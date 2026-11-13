// Envoi des messages Oncoodle (POST) : vide la boîte d'envoi public.oncoodle_outbox.
// Appelée par pg_cron toutes les 5 minutes (jeton Vault, en-tête x-absence-worker, comme notify-absence) et, juste après une
// action, par la page Oncoodle avec la session du membre (le contenu vient toujours de la base, jamais de la requête).
// Garde-fous : chaque message est pris une seule fois (oncoodle_outbox_claim), réessayé 5 fois au plus ; l'état du sondage
// est relu avant l'envoi (un sondage clos, annulé ou déjà répondu ne produit pas de relance).
// E-mail : noreply@onconic.ch (secret SMTP_PASSWORD). Push : appareils abonnés des membres qui ont activé les notifications.
// Demandes d'ajout à l'agenda commun : avis envoyé à la boîte de la direction (secret ABSENCE_FORMS_TO) ; l'approbation se fait dans Oncoodle.
import nodemailer from "npm:nodemailer@6.9.16";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import webpush from "npm:web-push@3.6.7";
import { workerAuthorized } from "./delivery.ts";
import { buildIcs } from "./ics.ts";
import { buildMessage, type Data, type Kind, type Lang } from "./message.ts";

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

type Row = { id: number; kind: Kind; poll_id: number; recipient: string | null; payload: { manual?: boolean; reopened?: boolean; option_id?: number; by?: string } };
type Mail = Data & { recipient: { lang: string; push: boolean; email: boolean } | null };

// Le message a-t-il encore un sens ? (l'état du sondage a pu changer depuis la mise en file)
function relevant(row: Row, d: Mail): boolean {
  const p = d.poll, open = p.status === "open", future = !p.deadline || new Date(p.deadline) > new Date();
  switch (row.kind) {
    case "invite": return open && future && !!d.invitee && !d.invitee.responded;
    case "reminder": return open && future && !!d.invitee && !d.invitee.responded;
    case "updated": return open && !!d.invitee;
    case "closed": return p.status === "closed" && !!d.invitee;
    case "cancelled": return p.status === "cancelled" && !!d.invitee;
    case "all_responded": return open;
    case "deadline": return open && !!p.deadline && new Date(p.deadline) <= new Date();
    case "calendar_proposal": return p.status === "closed";
  }
}
// Résumés et rappels : désactivables par le membre (invitation, clôture et annulation restent toujours envoyées)
const OPTIONAL = new Set<Kind>(["reminder", "updated", "all_responded", "deadline"]);

async function sendOne(row: Row, transport: ReturnType<typeof nodemailer.createTransport> | null): Promise<string | null> {
  const { data: raw } = await admin.rpc("oncoodle_mail_data", { p_poll: row.poll_id, p_recipient: row.recipient });
  if (!raw) return "__skip__";
  const d = raw as Mail;
  if (!relevant(row, d)) return "__skip__";

  // Proposition pour l'agenda commun : un seul e-mail à la boîte de la direction
  if (row.kind === "calendar_proposal") {
    const to = (Deno.env.get("ABSENCE_FORMS_TO") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!to.length) return "ABSENCE_FORMS_TO manquant";
    if (!transport) return "SMTP_PASSWORD manquant";
    const m = buildMessage({ lang: "fr", kind: row.kind, data: d, by: row.payload.by });
    try { await transport.sendMail({ from: `Onconic <${SMTP_USER}>`, to, subject: m.subject, text: m.text, html: m.html }); return null; }
    catch (e) { return String((e as Error).message ?? e).slice(0, 250); }
  }
  if (!row.recipient || !d.recipient) return "__skip__";
  const lang: Lang = d.recipient.lang === "en" ? "en" : "fr";
  const msg = buildMessage({ lang, kind: row.kind, data: d, manual: row.payload.manual, reopened: row.payload.reopened });

  // Push : facultatif (appareil activé dans Mon compte), jamais bloquant, sans texte libre
  try {
    if (d.recipient.push && msg.push.body) {
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
  } catch (_) { /* le push ne bloque jamais l'e-mail */ }

  if (OPTIONAL.has(row.kind) && !d.recipient.email) return null;
  const { data: u } = await admin.auth.admin.getUserById(row.recipient);
  const to = u?.user?.email;
  if (!to) return "__skip__";
  if (!transport) return "SMTP_PASSWORD manquant";
  const final = d.options.find((o) => o.id === d.poll.final_option_id);
  const attachments = row.kind === "closed" && final && d.invitee?.answer_on_final !== "no"
    ? [{ filename: "oncoodle.ics", content: buildIcs({ id: d.poll.id, title: d.poll.title, location: d.poll.location, day: final.day, start: final.start, end: final.end }), contentType: "text/calendar; charset=utf-8; method=PUBLISH" }]
    : [];
  try {
    await transport.sendMail({ from: `Onconic <${SMTP_USER}>`, to, subject: msg.subject, text: msg.text, html: msg.html, attachments });
    return null;
  } catch (e) {
    return String((e as Error).message ?? e).slice(0, 250);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, 405, { error: "method_not_allowed" });

  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const provided = req.headers.get("x-absence-worker");
  const worker = (await workerAuthorized(provided, Deno.env.get("ABSENCE_WORKER_TOKEN")))
    || (!!provided && provided.length >= 32 && (await admin.rpc("absence_worker_verify", { p_token: provided })).data === true);
  if (!worker) {
    if (!token) return json(req, 401, { error: "unauthorized" });
    const { data: auth } = await admin.auth.getUser(token);
    if (!auth?.user) return json(req, 401, { error: "unauthorized" });
    // Seuls les membres qui disposent de l'outil peuvent déclencher le vidage de la file (un compte en attente de validation, non)
    const { data: allowed } = await admin.rpc("oncoodle_user_allowed", { p_user: auth.user.id });
    if (allowed !== true) return json(req, 403, { error: "forbidden" });
  }

  const { data: rows, error } = await admin.rpc("oncoodle_outbox_claim", { p_limit: 30 });
  if (error) return json(req, 500, { error: "outbox" });
  if (!rows?.length) return json(req, 200, { processed: 0, sent: 0, failed: 0, skipped: 0 });

  const pass = Deno.env.get("SMTP_PASSWORD");
  const transport = pass ? nodemailer.createTransport({ host: "mail.infomaniak.com", port: 465, secure: true, connectionTimeout: 10000, socketTimeout: 15000, auth: { user: SMTP_USER, pass } }) : null;
  let sent = 0, failed = 0, skipped = 0;
  for (const row of rows as Row[]) {
    let err: string | null;
    try { err = await sendOne(row, transport); } catch (e) { err = String((e as Error).message ?? e).slice(0, 250); }
    if (err === "__skip__") { await admin.rpc("oncoodle_outbox_skip", { p_id: row.id }); skipped++; }
    else { await admin.rpc("oncoodle_outbox_done", { p_id: row.id, p_error: err }); err ? failed++ : sent++; }
  }
  return json(req, 200, { processed: rows.length, sent, failed, skipped });
});
