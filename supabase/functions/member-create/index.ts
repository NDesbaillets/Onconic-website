// Création d'un membre permanent par l'administrateur ou l'admin de direction, sans passer par une demande d'accès.
// Rôles créés : médecin assistant, CDC, médecin cadre, assistante, infirmier·ère, pharmacien·ne ; l'administrateur crée aussi « direction ».
// Personne ne crée de compte « admin » par cette voie. Le droit est vérifié par la base (member_create_allowed), puis une seconde fois
// par member_create_apply, qui relit le rôle de l'auteur. Deux modes : « invite » (e-mail Supabase pour définir le mot de passe)
// ou « password » (mot de passe provisoire affiché une seule fois). Toute création est journalisée (temp_account_log).
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const SITE = "https://onconic.ch";
const ORIGINS = [SITE, "https://www.onconic.ch"];
const URL_ = Deno.env.get("SUPABASE_URL")!;
// Aperçus Cloudflare acceptés seulement sur le projet de test : en production, un lien ne mène jamais vers une branche non relue
const PREVIEW = URL_.includes("uubowlcyekbgmizrlyxb") ? /^https:\/\/([a-z0-9-]+\.)?onconic\.pages\.dev$/ : /^$/;
const admin = createClient(URL_, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

// Liste blanche côté fonction aussi (la base refuse « admin » et les rôles inconnus)
const ROLES = ["clinician", "cdc", "cadre", "assistant", "nurse", "pharmacist", "direction"];
const FRESH_MS = 2 * 60 * 1000; // seuil « compte créé à l'instant »
const INSTITUTIONS = ["CHUV", "Hors CHUV"];

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
const cleanList = (v: unknown) => Array.isArray(v) ? [...new Set(v.slice(0, 40).map((x) => clean(x, 60)).filter(Boolean))] : [];
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

  // Appelant : session valide
  const auth = req.headers.get("authorization") ?? "";
  const jwt = auth.replace(/^Bearer\s+/i, "");
  const { data: caller } = await admin.auth.getUser(jwt);
  if (!caller?.user) return json(req, 401, { error: "unauthorized" });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json(req, 400, { error: "invalid_json" }); }

  const role = clean(body.role, 20);
  if (!ROLES.includes(role)) return json(req, 400, { error: "invalid_role" });

  // Droit de créer ce rôle, vérifié par la base avec le jeton de l'appelant
  const asCaller = createClient(URL_, Deno.env.get("SUPABASE_ANON_KEY")!, {
    auth: { persistSession: false },
    global: { headers: { Authorization: "Bearer " + jwt } },
  });
  const { data: allowed, error: rightsError } = await asCaller.rpc("member_create_allowed", { p_role: role });
  if (rightsError || allowed !== true) return json(req, 403, { error: "forbidden" });

  const email = clean(body.email, 254).toLowerCase();
  const first = clean(body.first_name, 80), last = clean(body.last_name, 80);
  const institution = clean(body.institution, 20) || "CHUV";
  const mode = body.mode === "password" ? "password" : "invite";
  if (!EMAIL.test(email)) return json(req, 400, { error: "invalid_email" });
  if (!first || !last) return json(req, 400, { error: "invalid_name" });
  if (!INSTITUTIONS.includes(institution)) return json(req, 400, { error: "invalid_institution" });
  const clinics = cleanList(body.clinics), cdcClinics = cleanList(body.cdc_clinics);

  // Cliniques et institution validées par la base AVANT toute création de compte (aucune invitation ne part pour une demande invalide)
  const { error: checkError } = await asCaller.rpc("member_create_check", {
    p_role: role, p_clinics: clinics, p_cdc_clinics: cdcClinics, p_institution: institution,
  });
  if (checkError) {
    if (checkError.code === "OC001") return json(req, 400, { error: "invalid_institution" });
    if (checkError.code === "OC002") return json(req, 400, { error: "invalid_clinics" });
    return json(req, 403, { error: "forbidden" });
  }

  const fullName = first + " " + last;
  let userId: string | undefined, password: string | undefined, createdAt: string | undefined;
  if (mode === "invite") {
    const origin = req.headers.get("origin") ?? "";
    const site = PREVIEW.test(origin) ? origin : SITE;
    const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
      redirectTo: site + "/fr/nouveau-mot-de-passe.html",
      data: { full_name: fullName },
    });
    if (error || !data.user) {
      const exists = error?.code === "email_exists" || /already/i.test(error?.message ?? "");
      console.error("invite failed", error?.code, error?.status);
      return json(req, exists ? 409 : 502, { error: exists ? "user_exists" : "invite_failed" });
    }
    userId = data.user.id; createdAt = data.user.created_at;
  } else {
    password = provisionalPassword();
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: fullName } });
    if (error || !data.user) {
      const exists = error?.code === "email_exists" || /already/i.test(error?.message ?? "");
      console.error("create failed", error?.code, error?.status);
      return json(req, exists ? 409 : 502, { error: exists ? "user_exists" : "create_failed" });
    }
    userId = data.user.id; createdAt = data.user.created_at;
  }

  // inviteUserByEmail peut renvoyer sans erreur un compte déjà invité : un compte qui n'est pas né à l'instant n'est ni modifié ni supprimé
  const ts = Date.parse(String(createdAt ?? ""));
  if (!Number.isFinite(ts) || Date.now() - ts > FRESH_MS) return json(req, 409, { error: "user_exists" });

  // Le profil est créé par le déclencheur d'inscription ; la base le complète (rôle, cliniques, accès par défaut, journal).
  // En cas d'échec, le compte d'authentification qui vient d'être créé est supprimé.
  const { error: applyError } = await admin.rpc("member_create_apply", {
    p_actor: caller.user.id, p_user: userId, p_role: role, p_first: first, p_last: last, p_institution: institution,
    p_clinics: clinics, p_cdc_clinics: cdcClinics, p_mode: mode,
  });
  if (applyError) {
    console.error("member_create_apply failed", applyError.code);
    const { error: delError } = await admin.auth.admin.deleteUser(userId);
    if (delError) console.error("cleanup deleteUser failed", delError.code ?? delError.status);
    return json(req, 500, { error: "profile_failed" });
  }

  return json(req, 200, { ok: true, id: userId, mode, password });
});
