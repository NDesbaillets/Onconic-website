// Création d'un compte temporaire par un cadre administratif (ou la direction), sans validation par l'administrateur.
// Le compte reçoit toujours le rôle assistant, l'institution CHUV et une fin d'accès (un an au plus).
// Deux modes : « invite » (e-mail Supabase pour définir le mot de passe) ou « password » (mot de passe provisoire
// affiché une seule fois au cadre, qui le transmet). Toute création est journalisée (temp_account_log).
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const SITE = "https://onconic.ch";
const ORIGINS = [SITE, "https://www.onconic.ch"];
// Aperçus Cloudflare (projet de test uniquement) : la fonction exige de toute façon un jeton de session valide
const PREVIEW = /^https:\/\/([a-z0-9-]+\.)?onconic\.pages\.dev$/;

const URL_ = Deno.env.get("SUPABASE_URL")!;
const admin = createClient(URL_, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

function allowedOrigin(origin: string) {
  return ORIGINS.includes(origin) || PREVIEW.test(origin);
}
function corsHeaders(req: Request) {
  const origin = req.headers.get("origin") ?? "";
  return {
    "Access-Control-Allow-Origin": allowedOrigin(origin) ? origin : SITE,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
function json(req: Request, status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders(req), "Content-Type": "application/json" } });
}

const EMAIL = /^[^\s@<>()",;:]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,}$/i;
const clean = (v: unknown, max: number) => String(v ?? "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, max);
function zurichToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Zurich" }).format(new Date()); // AAAA-MM-JJ
}
function addDays(iso: string, n: number) {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
// Mot de passe provisoire : 16 caractères sans ambiguïté (pas de 0/O, 1/l/I)
function provisionalPassword() {
  const set = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let out = "";
  for (const b of bytes) out += set[b % set.length];
  return out.slice(0, 4) + "-" + out.slice(4, 8) + "-" + out.slice(8, 12) + "-" + out.slice(12);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, 405, { error: "method_not_allowed" });

  // Appelant : session valide et droit de gérer les comptes temporaires (vérifié par la base, comme dans la page)
  const auth = req.headers.get("authorization") ?? "";
  const jwt = auth.replace(/^Bearer\s+/i, "");
  const { data: caller } = await admin.auth.getUser(jwt);
  if (!caller?.user) return json(req, 401, { error: "unauthorized" });
  const asCaller = createClient(URL_, Deno.env.get("SUPABASE_ANON_KEY")!, {
    auth: { persistSession: false },
    global: { headers: { Authorization: "Bearer " + jwt } },
  });
  const { data: allowed, error: rightsError } = await asCaller.rpc("can_manage_temps");
  if (rightsError || allowed !== true) return json(req, 403, { error: "forbidden" });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json(req, 400, { error: "invalid_json" }); }

  const email = clean(body.email, 254).toLowerCase();
  const first = clean(body.first_name, 80), last = clean(body.last_name, 80);
  const until = clean(body.access_until, 10);
  const mode = body.mode === "password" ? "password" : "invite";
  const today = zurichToday();
  if (!EMAIL.test(email)) return json(req, 400, { error: "invalid_email" });
  if (!first || !last) return json(req, 400, { error: "invalid_name" });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(until) || until < today || until > addDays(today, 366)) return json(req, 400, { error: "invalid_until" });

  const fullName = first + " " + last;
  let userId: string | undefined, password: string | undefined;
  if (mode === "invite") {
    const origin = req.headers.get("origin") ?? "";
    const site = PREVIEW.test(origin) ? origin : SITE;
    const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
      redirectTo: site + "/fr/nouveau-mot-de-passe.html",
      data: { full_name: fullName },
    });
    if (error || !data.user) {
      const exists = error?.code === "email_exists" || /already/i.test(error?.message ?? "");
      console.error("invite failed", error?.code, error?.message);
      return json(req, exists ? 409 : 502, { error: exists ? "user_exists" : "invite_failed" });
    }
    userId = data.user.id;
  } else {
    password = provisionalPassword();
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: fullName } });
    if (error || !data.user) {
      const exists = error?.code === "email_exists" || /already/i.test(error?.message ?? "");
      console.error("create failed", error?.code, error?.message);
      return json(req, exists ? 409 : 502, { error: exists ? "user_exists" : "create_failed" });
    }
    userId = data.user.id;
  }

  // Le profil est créé par le déclencheur d'inscription ; on le complète. En cas d'échec, le compte est retiré.
  const { data: updated, error: profileError } = await admin.from("profiles").update({
    role: "assistant", first_name: first, last_name: last, full_name: fullName, institution: "CHUV",
    access_until: until, created_by: caller.user.id, admin_lead: false,
  }).eq("id", userId).select("id");
  if (profileError || !updated?.length) {
    console.error("profile update failed", profileError?.message ?? "no row");
    await admin.auth.admin.deleteUser(userId);
    return json(req, 500, { error: "profile_failed" });
  }
  await admin.from("temp_account_log").insert({ actor: caller.user.id, target: userId, action: "create", detail: { mode, until } });

  return json(req, 200, { ok: true, id: userId, mode, password });
});
