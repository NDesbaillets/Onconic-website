// Flux iCal personnel « Mes congrès » : https://<projet>.supabase.co/functions/v1/calendar-feed?t=<jeton>
// Les applications d'agenda (Apple, Google, Outlook) ne savent pas envoyer de connexion : l'accès repose sur un jeton secret
// de 64 caractères propre au membre (public.calendar_tokens), qu'il peut renouveler depuis la page Congrès.
// Le flux ne contient que les événements où le membre participe, leurs échéances et sa propre présentation.
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { buildCalendar, type Row } from "./ics.ts";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

const plain = (status: number, body: string) =>
  new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });

Deno.serve(async (req) => {
  if (req.method !== "GET" && req.method !== "HEAD") return plain(405, "Method not allowed");
  const token = new URL(req.url).searchParams.get("t") ?? "";
  if (!/^[0-9a-f]{64}$/.test(token)) return plain(404, "Not found");

  const { data: owner } = await admin.from("calendar_tokens").select("user_id").eq("token", token).maybeSingle();
  if (!owner) return plain(404, "Not found");

  const { data, error } = await admin.rpc("calendar_feed", { p_token: token });
  if (error) return plain(500, "Error");

  const ics = buildCalendar((data ?? []) as Row[]);
  return new Response(req.method === "HEAD" ? null : ics, {
    status: 200,
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="onconic-mes-congres.ics"',
      "Cache-Control": "private, max-age=900",
    },
  });
});
