// Envoi des messages d'absence (POST, JWT d'un membre connecté) : vide la boîte d'envoi public.absence_outbox.
// Les fonctions SQL y déposent un message à chaque événement : nouvelles absences envoyées par lot aux validateurs,
// demande de changement, validation complète, refus (e-mail immédiat à l'usager), changement accepté ou refusé.
// Garde-fous : les messages viennent de la base (jamais de la requête) ; chaque message est pris une seule fois
// (absence_outbox_claim), réessayé jusqu'à 5 fois si l'e-mail échoue ; les refus de plus de 14 jours sont purgés.
// E-mail : boîte noreply@onconic.ch (secret SMTP_PASSWORD, comme contact-request). Push : abonnements de notify-event-join.
// Messages destinés à la direction (visa, pré-avis, et messages de validation reçus par un membre « direction ») : un seul e-mail
// par message, à la boîte commune (secret ABSENCE_FORMS_TO, comme les formulaires) ; à défaut du secret, à l'adresse de chaque membre.
import { externalAbsence, sendSharedOnce, workerAuthorized } from "./delivery.ts";
import { Buffer } from "node:buffer";
import nodemailer from "npm:nodemailer@6.9.16";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import webpush from "npm:web-push@3.6.7";
import { type Abs, buildEmail, buildFormEmail, type Kind, type Lang } from "./message.ts";
import { buildAbsenceForm, FILE_LABEL, type FormData, stamp } from "./form.ts";

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

type Row = { id: number; kind: Kind | "form"; recipient: string | null; absence_ids: number[]; payload: { owner?: string; by?: string; comment?: string; reminder?: boolean; action?: string; document_id?: number; absences?: (Abs & { user_id: string })[] } };

const ROLE_LABEL: Record<string, string> = { clinician: "médecin assistant", cdc: "chef de clinique", cadre: "médecin cadre" };
const slug = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || "membre";

// Formulaire PDF d'un envoi d'absences validées (données lues en base, jamais dans la requête)
async function renderForm(ids: number[], documentId?: number) {
  const { data: d } = documentId ? await admin.rpc("absence_document_data", { p_document: documentId }) : await admin.rpc("absence_form_data", { p_ids: ids });
  if (!d) return { error: "not_found" as const };
  if (d.no_form) return { error: "no_form" as const };
  let logo: Uint8Array | null = null;
  try { const f = await admin.storage.from("absence-forms").download("logo.png"); if (f.data) logo = new Uint8Array(await f.data.arrayBuffer()); } catch (_) { /* logo facultatif */ }
  const now = d.generated_at ?? new Date().toISOString();
  const form: FormData = {
    role: d.role, owner: d.owner, clinics: d.clinics ?? [], requestedAt: d.requested_at ?? now, absences: d.absences.map((a: Abs) => externalAbsence(a)), signers: (d.signers ?? []).map((s: { name: string; at: string }) => ({ name: s.name, at: s.at })), direction: d.direction ?? null,
    generatedAt: now, ref: `OC-ABS-D${d.document_id}`, action: d.action,
  };
  const bytes = await buildAbsenceForm(form, logo);
  const file = `${d.action === "cancelled" || d.action === "cancelled_direct" ? "Annulation" : d.action === "modified" || d.action === "modified_direct" ? "Rectificatif" : "Demande"}_D${d.document_id}_absence_${FILE_LABEL[d.role as keyof typeof FILE_LABEL]}_${slug(d.owner)}_${now.slice(0, 10).replaceAll("-", "")}.pdf`;
  return { bytes, file, form };
}

// Envoi à la gestion des absences (adresse = secret ABSENCE_FORMS_TO, plusieurs adresses séparées par une virgule)
async function sendForm(row: Row, transport: ReturnType<typeof nodemailer.createTransport> | null): Promise<string | null> {
  const to = (Deno.env.get("ABSENCE_FORMS_TO") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!to.length) return "ABSENCE_FORMS_TO manquant";
  if (!transport) return "SMTP_PASSWORD manquant";
  const r = await renderForm(row.absence_ids, row.payload.document_id);
  if ("error" in r) return "__skip__"; // absence supprimée ou rôle sans formulaire : rien à envoyer
  const m = buildFormEmail({ owner: r.form.owner, roleLabel: ROLE_LABEL[r.form.role] ?? r.form.role, absences: r.form.absences, signers: r.form.signers, direction: r.form.direction, file: r.file, action: r.form.action }, stamp);
  try {
    await transport.sendMail({ from: `Onconic <${SMTP_USER}>`, to, subject: m.subject, text: m.text, html: m.html,
      attachments: [{ filename: r.file, content: Buffer.from(r.bytes), contentType: "application/pdf" }] });
    return null;
  } catch (e) {
    return String((e as Error).message ?? e).slice(0, 250);
  }
}

function b64(bytes: Uint8Array): string {
  let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// Adresses de la boîte commune de la direction (secret ABSENCE_FORMS_TO, séparées par une virgule)
const sharedBox = () => (Deno.env.get("ABSENCE_FORMS_TO") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const DIRECTION_KINDS = ["to_direction", "to_opinion"];
const VALIDATE_KINDS = ["to_validate", "to_validate_change"];

async function sendOne(row: Row, transport: ReturnType<typeof nodemailer.createTransport> | null, sentShared: Set<string>): Promise<string | null> {
  if (row.kind === "form") return await sendForm(row, transport);
  if (!row.recipient) return "__skip__";
  const { data: allowed, error: scopeError } = await admin.rpc("absence_notification_ids", { p_recipient: row.recipient, p_ids: row.absence_ids, p_kind: row.kind });
  if (scopeError) return "notification_scope";
  if (!allowed?.length) return "__skip__"; // demande retirée, déjà décidée ou habilitation retirée
  const { data: rawAbsences, error: readError } = await admin.from("absences")
    .select("id, user_id, kind, start_date, end_date, change_type, change_kind, change_start, change_end")
    .in("id", allowed).order("start_date");
  if (readError) return "notification_read";
  const absences = (row.payload.absences ?? rawAbsences ?? []).filter((a) => allowed.includes(a.id)).map((a) => externalAbsence(a as Abs & { user_id: string }));
  if (!absences.length) return "__skip__"; // absence supprimée entre-temps : rien à envoyer

  const { data: prof } = await admin.from("profiles").select("lang, notify_events, role").eq("id", row.recipient).maybeSingle();
  const lang: Lang = prof?.lang === "en" ? "en" : "fr";
  const first = absences[0];
  const { data: ownerName } = await admin.rpc("member_name", { p_user: first.user_id });
  const { data: appr } = await admin.from("absence_approvals").select("validator_id, decision").eq("absence_id", first.id);
  const names = async (ids: string[]) => (await Promise.all(ids.map(async (i) => (await admin.rpc("member_name", { p_user: i })).data as string))).filter(Boolean);
  const validators = await names((appr ?? []).map((a) => a.validator_id));
  const approvers = await names((appr ?? []).filter((a) => a.decision === "approved").map((a) => a.validator_id));

  const msg = buildEmail({
    lang, kind: row.kind, owner: row.payload.owner ?? (ownerName as string) ?? "Un membre", by: row.payload.by, comment: null, reminder: row.payload.reminder, action: row.payload.action,
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

  // E-mail : boîte commune de la direction pour ses messages (un seul envoi par message), sinon adresse du destinataire
  const toDirection = DIRECTION_KINDS.includes(row.kind) || (VALIDATE_KINDS.includes(row.kind) && prof?.role === "direction");
  const box = toDirection ? sharedBox() : [];
  let to: string | string[] | undefined;
  if (box.length) {
    if (!transport) return "SMTP_PASSWORD manquant";

    to = box;
  } else {
    const { data: u } = await admin.auth.admin.getUserById(row.recipient);
    to = u?.user?.email ?? undefined;
  }
  if (!to) return "recipient_email_missing"; // pas d'adresse : rien à envoyer
  if (!transport) return "SMTP_PASSWORD manquant";
  try {
    const send = () => transport.sendMail({ from: `Onconic <${SMTP_USER}>`, to, subject: msg.subject, text: msg.text, html: msg.html });
    if (box.length) await sendSharedOnce(sentShared, `${row.kind}|${allowed.join(",")}|${row.payload.reminder ? "r" : ""}`, send);
    else await send();
    return null;
  } catch (e) {
    return String((e as Error).message ?? e).slice(0, 250);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, 405, { error: "method_not_allowed" });

  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  // Traitement autonome (pg_cron) : jeton comparé au secret Edge s'il existe, sinon au secret Vault par la base (jamais affiché)
  const provided = req.headers.get("x-absence-worker");
  const worker = (await workerAuthorized(provided, Deno.env.get("ABSENCE_WORKER_TOKEN")))
    || (!!provided && provided.length >= 32 && (await admin.rpc("absence_worker_verify", { p_token: provided })).data === true);
  if (!worker && !token) return json(req, 401, { error: "unauthorized" });
  const auth = worker ? null : (await admin.auth.getUser(token)).data;
  if (!worker && !auth?.user) return json(req, 401, { error: "unauthorized" });

  // Téléchargement d'un formulaire par un membre autorisé (l'intéressé, ses validateurs, un admin) : { action: "form", ids: [..] }
  const body = await req.json().catch(() => ({}));
  if (body?.action === "form") {
    if (!auth?.user || worker) return json(req, 403, { error: "forbidden" });
    const documentId = Number.isSafeInteger(body.document_id) && body.document_id > 0 ? body.document_id : undefined;
    if (documentId) {
      const { data: ok } = await admin.rpc("absence_document_access", { p_caller: auth.user.id, p_document: documentId });
      if (!ok) return json(req, 403, { error: "forbidden" });
      const r = await renderForm([], documentId);
      if ("error" in r) return json(req, 404, { error: r.error });
      return json(req, 200, { file: r.file, pdf: b64(r.bytes) });
    }
    const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter((n: number) => Number.isInteger(n) && n > 0).slice(0, 50) : [];
    if (!ids.length) return json(req, 400, { error: "ids" });
    const { data: ok } = await admin.rpc("absence_form_access", { p_caller: auth.user.id, p_ids: ids });
    if (!ok) return json(req, 403, { error: "forbidden" });
    const r = await renderForm(ids);
    if ("error" in r) return json(req, r.error === "no_form" ? 422 : 404, { error: r.error });
    return json(req, 200, { file: r.file, pdf: b64(r.bytes) });
  }

  await admin.rpc("absence_purge");
  const { data: rows, error } = await admin.rpc("absence_outbox_claim", { p_limit: 30 });
  if (error) return json(req, 500, { error: "outbox" });
  if (!rows?.length) return json(req, 200, { processed: 0, sent: 0, failed: 0 });

  const pass = Deno.env.get("SMTP_PASSWORD");
  const transport = pass ? nodemailer.createTransport({ host: "mail.infomaniak.com", port: 465, secure: true, connectionTimeout: 10000, socketTimeout: 15000, auth: { user: SMTP_USER, pass } }) : null;
  let sent = 0, failed = 0, skipped = 0;
  const sentShared = new Set<string>();
  for (const row of rows as Row[]) {
    let err: string | null;
    try { err = await sendOne(row, transport, sentShared); } catch (e) { err = String((e as Error).message ?? e).slice(0, 250); }
    if (err === "__skip__") {
      await admin.rpc("absence_outbox_skip", { p_id: row.id }); skipped++;
    } else {
      await admin.rpc("absence_outbox_done", { p_id: row.id, p_error: err });
      err ? failed++ : sent++;
    }
  }
  return json(req, 200, { processed: rows.length, sent, failed, skipped });
});
