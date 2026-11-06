// Envoi des messages d'absence (POST, JWT d'un membre connecté) : vide la boîte d'envoi public.absence_outbox.
// Les fonctions SQL y déposent un message à chaque événement : nouvelles absences envoyées par lot aux validateurs,
// demande de changement, validation complète, refus (e-mail immédiat à l'usager), changement accepté ou refusé.
// Garde-fous : les messages viennent de la base (jamais de la requête) ; chaque message est pris une seule fois
// (absence_outbox_claim), réessayé jusqu'à 5 fois si l'e-mail échoue ; les refus de plus de 14 jours sont purgés.
// E-mail : boîte noreply@onconic.ch (secret SMTP_PASSWORD, comme contact-request). Push : abonnements de notify-event-join.
import nodemailer from "npm:nodemailer@6.9.16";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import webpush from "npm:web-push@3.6.7";
import { type Abs, buildEmail, type Kind, type Lang } from "./message.ts";

const SITE = "https://onconic.ch";
const ORIGINS = [SITE, "https://www.onconic.ch"];
const SMTP_USER = "noreply@onconic.ch";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

function corsHeaders(req: Request) {
  const origin = req.headers.get("origin") ?? "";
  return {
    "Access-Control-Allow-Origin": ORIGINS.includes(origin) ? origin : SITE,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
const json = (req: Request, status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders(req), "Content-Type": "application/json" } });

async function vapidKeys() {
  const read = async () => (await admin.from("push_config").select("vapid_public, vapid_private").eq("id", 1).maybeSingle()).data;
  let row = await read();
  if (!row) {
    const k = webpush.generateVAPIDKeys();
    await admin.from("push_config").upsert({ id: 1, vapid_public: k.publicKey, vapid_private: k.privateKey }, { onConflict: "id", ignoreDuplicates: true });
    row = await read();
  }
  return row!;
}

type Row = { id: number; kind: Kind; recipient: string; absence_ids: number[]; payload: { owner?: string; by?: string; comment?: string } };

async function sendOne(row: Row, transport: ReturnType<typeof nodemailer.createTransport> | null): Promise<string | null> {
  const { data: absences } = await admin.from("absences")
    .select("id, user_id, kind, start_date, end_date, note, change_type, change_kind, change_note, change_start, change_end")
    .in("id", row.absence_ids).order("start_date");
  if (!absences?.length) return null; // absence supprimée entre-temps : rien à envoyer

  const { data: prof } = await admin.from("profiles").select("lang, notify_events").eq("id", row.recipient).maybeSingle();
  const lang: Lang = prof?.lang === "en" ? "en" : "fr";
  const first = absences[0];
  const { data: ownerName } = await admin.rpc("member_name", { p_user: first.user_id });
  const { data: appr } = await admin.from("absence_approvals").select("validator_id, decision").eq("absence_id", first.id);
  const names = async (ids: string[]) => (await Promise.all(ids.map(async (i) => (await admin.rpc("member_name", { p_user: i })).data as string))).filter(Boolean);
  const validators = await names((appr ?? []).map((a) => a.validator_id));
  const approvers = await names((appr ?? []).filter((a) => a.decision === "approved").map((a) => a.validator_id));

  const msg = buildEmail({
    lang, kind: row.kind, owner: row.payload.owner ?? (ownerName as string) ?? "Un membre", by: row.payload.by, comment: row.payload.comment,
    absences: absences as unknown as Abs[], validators, approvers,
  });

  // Push (facultatif : l'appareil doit avoir activé les notifications dans Mon compte)
  try {
    if (prof?.notify_events) {
      const { data: subs } = await admin.from("push_subscriptions").select("id, endpoint, p256dh, auth").eq("user_id", row.recipient);
      if (subs?.length) {
        const keys = await vapidKeys();
        webpush.setVapidDetails("mailto:contact@onconic.ch", keys.vapid_public, keys.vapid_private);
        const dead: number[] = [];
        await Promise.allSettled(subs.map(async (s) => {
          try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(msg.push), { TTL: 86400, urgency: "normal" }); }
          catch (e) { const c = (e as { statusCode?: number }).statusCode; if (c === 404 || c === 410) dead.push(s.id); }
        }));
        if (dead.length) await admin.from("push_subscriptions").delete().in("id", dead);
      }
    }
  } catch (_) { /* le push ne doit jamais bloquer l'e-mail */ }

  // E-mail
  const { data: u } = await admin.auth.admin.getUserById(row.recipient);
  const to = u?.user?.email;
  if (!to) return null; // pas d'adresse : rien à envoyer
  if (!transport) return "SMTP_PASSWORD manquant";
  try {
    await transport.sendMail({ from: `Onconic <${SMTP_USER}>`, to, subject: msg.subject, text: msg.text, html: msg.html });
    return null;
  } catch (e) {
    return String((e as Error).message ?? e).slice(0, 250);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, 405, { error: "method_not_allowed" });

  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: auth } = await admin.auth.getUser(token);
  if (!auth?.user) return json(req, 401, { error: "unauthorized" });

  await admin.rpc("absence_purge");
  const { data: rows, error } = await admin.rpc("absence_outbox_claim", { p_limit: 30 });
  if (error) return json(req, 500, { error: "outbox" });
  if (!rows?.length) return json(req, 200, { processed: 0, sent: 0, failed: 0 });

  const pass = Deno.env.get("SMTP_PASSWORD");
  const transport = pass ? nodemailer.createTransport({ host: "mail.infomaniak.com", port: 465, secure: true, auth: { user: SMTP_USER, pass } }) : null;
  let sent = 0, failed = 0;
  for (const row of rows as Row[]) {
    let err: string | null;
    try { err = await sendOne(row, transport); } catch (e) { err = String((e as Error).message ?? e).slice(0, 250); }
    await admin.rpc("absence_outbox_done", { p_id: row.id, p_error: err });
    err ? failed++ : sent++;
  }
  return json(req, 200, { processed: rows.length, sent, failed });
});
