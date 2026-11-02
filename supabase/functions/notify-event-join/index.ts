// Notification push : « un autre membre de The Hive participe au même congrès que vous ».
// Deux actions (POST, JWT du membre) :
//   { action: "public_key" }  -> { publicKey } : clé publique VAPID dont le navigateur a besoin pour s'abonner
//   { event_id }              -> prévient les autres participants qui ont accepté les notifications
// Les clés VAPID sont créées ici au premier appel et stockées dans public.push_config (jamais exposées au navigateur).
// Garde-fous : la participation du demandeur est relue en base, une seule annonce par membre et par événement,
// le nom n'est donné que si le membre l'a accepté (show_in_events), les abonnements expirés sont supprimés.
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import webpush from "npm:web-push@3.6.7";
import { buildMessage, joinerName, type Lang } from "./message.ts";

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
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json" },
  });
}

async function vapidKeys() {
  const read = async () => (await admin.from("push_config").select("vapid_public, vapid_private").eq("id", 1).maybeSingle()).data;
  let row = await read();
  if (!row) {
    const k = webpush.generateVAPIDKeys();
    // « do nothing » si une autre requête vient de créer la ligne : tout le monde relit la même paire
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

  if (body.action === "public_key") return json(req, 200, { publicKey: (await vapidKeys()).vapid_public });

  const eventId = Number(body.event_id);
  if (!Number.isInteger(eventId) || eventId <= 0) return json(req, 400, { error: "invalid_event" });

  // Le demandeur participe-t-il vraiment ? (lu en base, pas dans la requête)
  const { data: mine } = await admin.from("event_participants").select("status").eq("event_id", eventId).eq("user_id", user.id).maybeSingle();
  if (!mine || !["going", "presenting"].includes(mine.status)) return json(req, 200, { sent: 0, reason: "not_participating" });

  // Une seule annonce par (événement, membre) : l'insertion ne renvoie une ligne que la première fois
  const { data: first } = await admin.from("event_join_notices")
    .upsert({ event_id: eventId, user_id: user.id }, { onConflict: "event_id,user_id", ignoreDuplicates: true }).select("event_id");
  if (!first?.length) return json(req, 200, { sent: 0, reason: "already_announced" });

  const [{ data: ev }, { data: me }, { data: others }] = await Promise.all([
    admin.from("events").select("title, start_date, end_date").eq("id", eventId).maybeSingle(),
    admin.from("profiles").select("first_name, last_name, full_name, username, show_in_events").eq("id", user.id).maybeSingle(),
    admin.from("event_participants").select("user_id").eq("event_id", eventId).neq("user_id", user.id),
  ]);
  if (!ev) return json(req, 404, { error: "event_not_found" });
  const ids = (others ?? []).map((o) => o.user_id);
  if (!ids.length) return json(req, 200, { sent: 0, reason: "no_one_else" });

  const { data: recipients } = await admin.from("profiles").select("id, lang").in("id", ids).eq("notify_events", true);
  const lang = new Map((recipients ?? []).map((r) => [r.id, (r.lang === "en" ? "en" : "fr") as Lang]));
  if (!lang.size) return json(req, 200, { sent: 0, reason: "no_recipient" });
  const { data: subs } = await admin.from("push_subscriptions").select("id, user_id, endpoint, p256dh, auth").in("user_id", [...lang.keys()]);
  if (!subs?.length) return json(req, 200, { sent: 0, reason: "no_device" });

  const keys = await vapidKeys();
  webpush.setVapidDetails("mailto:contact@onconic.ch", keys.vapid_public, keys.vapid_private);
  const name = joinerName(me);
  let sent = 0;
  const dead: number[] = [];
  await Promise.allSettled(subs.map(async (s) => {
    const msg = buildMessage({ lang: lang.get(s.user_id)!, eventId, title: ev.title, start: ev.start_date, end: ev.end_date, name });
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(msg), { TTL: 86400, urgency: "normal" });
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) dead.push(s.id); // abonnement expiré ou révoqué
    }
  }));
  if (dead.length) await admin.from("push_subscriptions").delete().in("id", dead);
  return json(req, 200, { sent, devices: subs.length, removed: dead.length });
});
