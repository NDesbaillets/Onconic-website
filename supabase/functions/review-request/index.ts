// Traitement d'une demande depuis le lien reçu par e-mail (page /admin/review.html).
// { confirm: false } renvoie le détail de la demande ; { confirm: true } exécute l'action :
// - review (16.11.2026) : l'admin, connecté, choisit le rôle et l'institution ; le rôle est posé par admin_set_role
//   avec SA session (mêmes contrôles que la page Membres). Cliniques, valideurs et outils sont ensuite réglés par la page.
// - invite_clinician / invite_assistant / invite_pharmacist : anciens liens (encore valables 7 jours), rôle fixe ;
// - decline.
// Le lien est signé (REVIEW_SECRET), expire, et ne sert qu'une fois (statut « pending »).
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const SITE = "https://onconic.ch";
const ORIGINS = [SITE, "https://www.onconic.ch"];
// Aperçus Cloudflare (projet de test) : l'invitation exige de toute façon le lien signé et, pour « review », une session admin
const PREVIEW = /^https:\/\/([a-z0-9-]+\.)?onconic\.pages\.dev$/;
const ROLES: Record<string, string> = { invite_clinician: "clinician", invite_assistant: "assistant", invite_pharmacist: "pharmacist" };
const REVIEW_ROLES = ["clinician", "cdc", "cadre", "assistant", "nurse", "pharmacist", "direction", "admin"];

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

function corsHeaders(req: Request) {
  const origin = req.headers.get("origin") ?? "";
  return {
    "Access-Control-Allow-Origin": ORIGINS.includes(origin) || PREVIEW.test(origin) ? origin : SITE,
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

async function validSignature(data: string, sig: string) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(Deno.env.get("REVIEW_SECRET")!),
    { name: "HMAC", hash: "SHA-256" }, false, ["verify"],
  );
  let raw: Uint8Array;
  try {
    const b64 = sig.replace(/-/g, "+").replace(/_/g, "/");
    raw = Uint8Array.from(atob(b64 + "=".repeat((4 - b64.length % 4) % 4)), (c) => c.charCodeAt(0));
  } catch {
    return false;
  }
  return crypto.subtle.verify("HMAC", key, raw, new TextEncoder().encode(data)); // comparaison à temps constant
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, 405, { error: "method_not_allowed" });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json(req, 400, { error: "invalid_json" });
  }

  const id = Number(body.id);
  const action = String(body.action ?? "");
  const exp = Number(body.exp);
  const sig = String(body.sig ?? "");
  if (!Number.isInteger(id) || !(action in ROLES || action === "decline" || action === "review") || !Number.isInteger(exp)) {
    return json(req, 400, { error: "invalid_link" });
  }
  if (!(await validSignature(`${id}.${action}.${exp}`, sig))) return json(req, 403, { error: "invalid_link" });
  if (exp < Date.now() / 1000) return json(req, 410, { error: "expired" });

  const { data: request } = await admin.from("contact_requests")
    .select("id, kind, name, email, organisation, message, lang, status, created_at").eq("id", id).single();
  if (!request) return json(req, 404, { error: "not_found" });

  if (body.confirm !== true) return json(req, 200, { request, action });
  if (request.status !== "pending") return json(req, 409, { error: "already_handled", status: request.status });

  // « review » : l'appelant doit être connecté comme admin ou direction ; le rôle demandé est vérifié avant toute invitation
  let caller: ReturnType<typeof createClient> | null = null;
  let reviewRole = "";
  if (action === "review") {
    const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: who } = await admin.auth.getUser(jwt);
    if (!who?.user) return json(req, 401, { error: "login_required" });
    caller = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      auth: { persistSession: false }, global: { headers: { Authorization: "Bearer " + jwt } },
    });
    const { data: myRole } = await caller.rpc("current_role_name");
    if (myRole !== "admin" && myRole !== "direction") return json(req, 403, { error: "forbidden" });
    reviewRole = String(body.role ?? "");
    if (!REVIEW_ROLES.includes(reviewRole)) return json(req, 400, { error: "invalid_role" });
    if ((reviewRole === "admin" || reviewRole === "direction") && myRole !== "admin") return json(req, 403, { error: "admin_only_role" });
  }

  // Réserve la demande (évite un double traitement si deux clics arrivent en même temps)
  const { data: claimed } = await admin.from("contact_requests")
    .update({ status: "processing" }).eq("id", id).eq("status", "pending").select("id");
  if (!claimed?.length) return json(req, 409, { error: "already_handled" });

  const finish = (status: string, role: string | null = null) =>
    admin.from("contact_requests")
      .update({ status, handled_role: role, handled_at: new Date().toISOString() }).eq("id", id);

  if (action === "decline") {
    await finish("declined");
    return json(req, 200, { ok: true, status: "declined" });
  }

  const role = action === "review" ? reviewRole : ROLES[action];
  const { data: invited, error } = await admin.auth.admin.inviteUserByEmail(request.email, {
    redirectTo: SITE + (request.lang === "fr" ? "/fr/nouveau-mot-de-passe.html" : "/reset-password.html"),
    data: { full_name: request.name },
  });
  if (error || !invited.user) {
    console.error("invite failed", error);
    await admin.from("contact_requests").update({ status: "pending" }).eq("id", id);
    const exists = error?.code === "email_exists" || /already/i.test(error?.message ?? "");
    return json(req, exists ? 409 : 500, { error: exists ? "user_exists" : "invite_failed" });
  }

  // Le profil est créé par le déclencheur à l'insertion dans auth.users ; on lui donne son rôle.
  let roleError: unknown = null;
  if (caller) {
    // Institution choisie par l'admin (les droits de plusieurs outils dépendent du CHUV), puis rôle par admin_set_role
    const institution = body.institution === "CHUV" ? "CHUV" : null;
    const { error: instError } = await admin.from("profiles").update({ institution }).eq("id", invited.user.id);
    if (instError) console.error("institution update failed", instError.message);
    ({ error: roleError } = await caller.rpc("admin_set_role", { p_user: invited.user.id, p_role: role }));
  } else {
    ({ error: roleError } = await admin.from("profiles").update({ role }).eq("id", invited.user.id));
  }
  if (roleError) console.error("role update failed", (roleError as { message?: string }).message ?? "unknown");

  await finish("invited", role);
  return json(req, 200, { ok: true, status: "invited", role, role_set: !roleError, user_id: invited.user.id });
});
