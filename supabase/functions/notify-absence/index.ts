// Notification push des absences (POST, JWT du membre) : { absence_id, event }
//   event "request" ou "change" : prévient les cadres valideurs (à défaut les admins) de la demande du membre connecté
//   event "decision"            : prévient le demandeur de la décision prise par le membre connecté
// Garde-fous : l'état de l'absence est relu en base (jamais pris dans la requête), le demandeur ne peut annoncer que
// ses propres demandes, le valideur que ses propres décisions (moins de 15 min), une seule annonce par demande ou décision
// (colonnes notified_at / notified_decision_at), abonnements expirés supprimés. Réutilise les abonnements et les clés
// VAPID de la fonction notify-event-join (tables push_subscriptions et push_config).
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import webpush from "npm:web-push@3.6.7";
import { type Absence, buildMessage, type Event, type Lang } from "./message.ts";

const SITE = "https://onconic.ch";
const ORIGINS = [SITE, "https://www.onconic.ch"];

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

function corsHeaders(req: Request) {
  const origin = req.headers.get("origin") ?? "";
  return {
    "Access-Control-Allow-Origin": ORIGINS.includes(origin) ? origin : SITE,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(req: Request, status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders(req), "Content-Type": "application/json" } });
}

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, 405, { error: "method_not_allowed" });

  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: auth } = await admin.auth.getUser(token);
  const user = auth?.user;
  if (!user) return json(req, 401, { error: "unauthorized" });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json(req, 400, { error: "invalid_json" });
  }
  const id = Number(body.absence_id);
  const event = body.event as Event;
  if (!Number.isInteger(id) || id <= 0 || !["request", "change", "decision"].includes(event)) return json(req, 400, { error: "invalid_request" });

  const { data: a } = await admin.from("absences").select("*").eq("id", id).maybeSingle();
  if (!a) return json(req, 404, { error: "absence_not_found" });

  let recipients: string[] = [];
  const now = new Date().toISOString();
  if (event === "decision") {
    if (a.decided_by !== user.id || !a.decided_at || Date.now() - new Date(a.decided_at).getTime() > 15 * 60 * 1000) {
      return json(req, 403, { error: "not_the_decider" });
    }
    const { data: claimed } = await admin.from("absences").update({ notified_decision_at: now }).eq("id", id).is("notified_decision_at", null).select("id");
    if (!claimed?.length) return json(req, 200, { sent: 0, reason: "already_notified" });
    recipients = [a.user_id];
  } else {
    if (a.user_id !== user.id) return json(req, 403, { error: "not_the_requester" });
    const pending = event === "request" ? a.status === "requested" && !a.change_type : !!a.change_type && a.status === "approved";
    if (!pending) return json(req, 200, { sent: 0, reason: "nothing_pending" });
    const { data: claimed } = await admin.from("absences").update({ notified_at: now }).eq("id", id).is("notified_at", null).select("id");
    if (!claimed?.length) return json(req, 200, { sent: 0, reason: "already_notified" });
    const { data: ids } = await admin.rpc("absence_validator_ids", { p_user: a.user_id });
    recipients = (ids ?? []) as string[];
  }
  if (!recipients.length) return json(req, 200, { sent: 0, reason: "no_recipient" });

  const { data: profs } = await admin.from("profiles").select("id, lang").in("id", recipients).eq("notify_events", true);
  const lang = new Map((profs ?? []).map((p) => [p.id, (p.lang === "en" ? "en" : "fr") as Lang]));
  if (!lang.size) return json(req, 200, { sent: 0, reason: "no_consent" });
  const { data: subs } = await admin.from("push_subscriptions").select("id, user_id, endpoint, p256dh, auth").in("user_id", [...lang.keys()]);
  if (!subs?.length) return json(req, 200, { sent: 0, reason: "no_device" });

  const { data: who } = await admin.rpc("member_name", { p_user: a.user_id });
  const keys = await vapidKeys();
  webpush.setVapidDetails("mailto:contact@onconic.ch", keys.vapid_public, keys.vapid_private);
  let sent = 0;
  const dead: number[] = [];
  await Promise.allSettled(subs.map(async (s) => {
    const msg = buildMessage({ lang: lang.get(s.user_id)!, event, who: (who as string) ?? "Un membre", a: a as Absence });
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(msg), { TTL: 86400, urgency: "normal" });
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) dead.push(s.id);
    }
  }));
  if (dead.length) await admin.from("push_subscriptions").delete().in("id", dead);
  return json(req, 200, { sent, devices: subs.length, removed: dead.length });
});
