// Formulaire de contact : enregistre la demande et prévient les admins par e-mail.
// Pour une demande d'adhésion, l'e-mail contient des liens signés vers /admin/review.html
// (inviter comme médecin, comme assistante, ou refuser).
// Secrets requis : SMTP_PASSWORD (boîte noreply@onconic.ch), REVIEW_SECRET (signature des liens).
import nodemailer from "npm:nodemailer@6.9.16";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const SITE = "https://onconic.ch";
const ORIGINS = [SITE, "https://www.onconic.ch"];
const SMTP_USER = "noreply@onconic.ch";
const LINK_DAYS = 7;
const KINDS = ["join", "business", "other"];
const KIND_LABEL: Record<string, string> = {
  join: "Demande d'adhésion (clinicien)",
  business: "Demande de conseil (pharma, finance)",
  other: "Autre demande",
};

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

function text(v: unknown, max: number) {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

async function sign(data: string) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(Deno.env.get("REVIEW_SECRET")!),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
  return btoa(String.fromCharCode(...mac)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function reviewLink(id: number, action: string, exp: number) {
  const sig = await sign(`${id}.${action}.${exp}`);
  const q = new URLSearchParams({ id: String(id), action, exp: String(exp), sig });
  return `${SITE}/admin/review.html?${q}`;
}

async function adminEmails(): Promise<string[]> {
  const { data: rows } = await admin.from("profiles").select("id").eq("role", "admin");
  const emails: string[] = [];
  for (const r of rows ?? []) {
    const { data } = await admin.auth.admin.getUserById(r.id);
    if (data.user?.email) emails.push(data.user.email);
  }
  return emails;
}

type Request_ = { id: number; kind: string; name: string; email: string; organisation: string; message: string; lang: string };

async function notify(r: Request_) {
  const to = await adminEmails();
  if (!to.length) return;

  const exp = Math.floor(Date.now() / 1000) + LINK_DAYS * 86400;
  const buttons = r.kind === "join"
    ? [
      ["Inviter comme médecin", await reviewLink(r.id, "invite_clinician", exp), "#F0B12B", "#001B4D"],
      ["Inviter comme assistante", await reviewLink(r.id, "invite_assistant", exp), "#001B4D", "#FFFFFF"],
      ["Refuser", await reviewLink(r.id, "decline", exp), "#FFFFFF", "#001B4D"],
    ]
    : [];

  const rows = [
    ["Nom", r.name], ["E-mail", r.email], ["Institution", r.organisation || "—"], ["Langue", r.lang.toUpperCase()],
  ].map(([k, v]) =>
    `<tr><td style="padding:6px 16px 6px 0;color:#5A6478">${k}</td><td style="padding:6px 0;color:#1A2A4A">${escapeHtml(v)}</td></tr>`
  ).join("");

  const html = `<div style="font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;max-width:560px;color:#1A2A4A">
<p style="letter-spacing:.2em;font-size:12px;color:#B4820E;margin:0 0 8px">ONCONIC</p>
<h1 style="font-weight:300;font-size:26px;color:#001B4D;margin:0 0 16px">${KIND_LABEL[r.kind]}</h1>
<table style="border-collapse:collapse;font-size:15px;margin-bottom:16px">${rows}</table>
<p style="white-space:pre-wrap;background:#F2F4F8;border-top:4px solid #001B4D;padding:16px;font-size:15px;margin:0 0 24px">${escapeHtml(r.message)}</p>
${buttons.map(([label, href, bg, fg]) =>
    `<a href="${href}" style="display:inline-block;margin:0 8px 8px 0;padding:12px 20px;background:${bg};color:${fg};border:1px solid #001B4D;text-decoration:none;font-weight:500">${label}</a>`
  ).join("")}
${buttons.length ? `<p style="font-size:13px;color:#5A6478;margin-top:16px">Chaque lien ouvre une page de confirmation. Valable ${LINK_DAYS} jours, utilisable une fois.</p>` : ""}
</div>`;

  const plain = [
    KIND_LABEL[r.kind], "", `Nom : ${r.name}`, `E-mail : ${r.email}`, `Institution : ${r.organisation || "—"}`, "", r.message, "",
    ...buttons.map(([label, href]) => `${label} : ${href}`),
  ].join("\n");

  const transport = nodemailer.createTransport({
    host: "mail.infomaniak.com",
    port: 465,
    secure: true,
    auth: { user: SMTP_USER, pass: Deno.env.get("SMTP_PASSWORD")! },
  });
  await transport.sendMail({
    from: `Onconic <${SMTP_USER}>`,
    to,
    replyTo: r.email,
    subject: `Onconic · ${KIND_LABEL[r.kind]} · ${r.name}`,
    text: plain,
    html,
  });
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

  if (text(body.website, 200)) return json(req, 200, { ok: true }); // piège anti-robot

  const r = {
    kind: text(body.kind, 20),
    name: text(body.name, 120),
    email: text(body.email, 200).toLowerCase(),
    organisation: text(body.organisation, 200),
    message: text(body.message, 4000),
    lang: body.lang === "fr" ? "fr" : "en",
  };
  if (!KINDS.includes(r.kind) || !r.name || !r.message || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email)) {
    return json(req, 400, { error: "invalid_input" });
  }

  // Limite simple : 3 demandes par adresse e-mail toutes les 10 minutes
  const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { count } = await admin.from("contact_requests").select("id", { count: "exact", head: true })
    .eq("email", r.email).gte("created_at", since);
  if ((count ?? 0) >= 3) return json(req, 429, { error: "too_many_requests" });

  const { data, error } = await admin.from("contact_requests").insert(r).select("id").single();
  if (error) {
    console.error("insert failed", error);
    return json(req, 500, { error: "insert_failed" });
  }

  try {
    await notify({ id: data.id, ...r });
  } catch (e) {
    console.error("notification failed", e); // la demande est enregistrée quand même
  }
  return json(req, 200, { ok: true });
});
