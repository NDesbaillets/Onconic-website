// Renvoi du lien de premier accès à un membre qui ne s'est encore jamais connecté (page Membres et accès).
// Réservé à l'admin et à la direction (vérifié avec la session de l'appelant) ; un compte admin ou direction ne reçoit
// un nouveau lien que d'un administrateur. Compte jamais confirmé : nouvelle invitation ; compte déjà confirmé
// (mot de passe provisoire, inscription) : lien « nouveau mot de passe ». Le lien mène à la page Onconic de choix du mot de passe.
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const SITE = "https://onconic.ch";
const ORIGINS = [SITE, "https://www.onconic.ch"];
const URL_ = Deno.env.get("SUPABASE_URL")!, ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
// Aperçus Cloudflare acceptés seulement sur le projet de test : en production, un lien ne mène jamais vers une branche non relue
const PREVIEW = URL_.includes("uubowlcyekbgmizrlyxb") ? /^https:\/\/([a-z0-9-]+\.)?onconic\.pages\.dev$/ : /^$/;
const admin = createClient(URL_, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

function corsHeaders(req: Request) {
  const origin = req.headers.get("origin") ?? "";
  return {
    "Access-Control-Allow-Origin": ORIGINS.includes(origin) || PREVIEW.test(origin) ? origin : SITE,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
const json = (req: Request, status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders(req), "Content-Type": "application/json" } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, 405, { error: "method_not_allowed" });

  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: who } = await admin.auth.getUser(jwt);
  if (!who?.user) return json(req, 401, { error: "unauthorized" });
  const caller = createClient(URL_, ANON, { auth: { persistSession: false }, global: { headers: { Authorization: "Bearer " + jwt } } });
  const { data: myRole } = await caller.rpc("current_role_name");
  if (myRole !== "admin" && myRole !== "direction") return json(req, 403, { error: "forbidden" });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json(req, 400, { error: "invalid_json" }); }
  const id = String(body.user_id ?? "");
  if (!UUID.test(id)) return json(req, 400, { error: "invalid_user" });
  if (id === who.user.id) return json(req, 400, { error: "self" });

  const { data: target } = await admin.auth.admin.getUserById(id);
  const u = target?.user;
  if (!u?.email) return json(req, 404, { error: "not_found" });
  if (u.last_sign_in_at) return json(req, 409, { error: "already_signed_in" });
  const { data: prof } = await admin.from("profiles").select("role, lang").eq("id", id).maybeSingle();
  if ((!prof || prof.role === "admin" || prof.role === "direction") && myRole !== "admin") return json(req, 403, { error: "admin_only" });

  const origin = req.headers.get("origin") ?? "";
  const site = PREVIEW.test(origin) ? origin : SITE;
  const redirectTo = site + (prof?.lang === "en" ? "/reset-password.html" : "/fr/nouveau-mot-de-passe.html");
  let error: { message?: string; status?: number; code?: string } | null = null;
  let mode: "invite" | "recovery";
  if (!u.email_confirmed_at) {
    mode = "invite";
    ({ error } = await admin.auth.admin.inviteUserByEmail(u.email, { redirectTo, data: u.user_metadata ?? {} }));
  } else {
    mode = "recovery";
    const pub = createClient(URL_, ANON, { auth: { persistSession: false } });
    ({ error } = await pub.auth.resetPasswordForEmail(u.email, { redirectTo }));
  }
  if (error) {
    const limited = error.status === 429 || /rate|seconds/i.test(error.message ?? "");
    console.error("resend failed", mode, error.code ?? "", error.status ?? "");
    return json(req, limited ? 429 : 502, { error: limited ? "rate_limited" : "send_failed" });
  }
  return json(req, 200, { ok: true, mode });
});
