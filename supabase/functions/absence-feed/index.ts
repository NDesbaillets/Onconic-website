// Flux iCal personnel « Mes absences » : https://<projet>.supabase.co/functions/v1/absence-feed?t=<jeton>
// Même jeton secret (64 caractères, public.calendar_tokens) que le flux « Mes congrès » : les applications d'agenda
// ne savent pas envoyer de connexion. Le flux ne contient que les absences du membre (demandées en provisoire, validées en ferme).
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { buildCalendar, type Row } from "./ics.ts";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const plain = (status: number, body: string) =>
  new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });

Deno.serve(async (req) => {
  if (req.method !== "GET" && req.method !== "HEAD") return plain(405, "Method not allowed");
  const token = new URL(req.url).searchParams.get("t") ?? "";
  if (!/^[0-9a-f]{64}$/.test(token)) return plain(404, "Not found");
  const { data: owner } = await admin.from("calendar_tokens").select("user_id").eq("token", token).maybeSingle();
  if (!owner) return plain(404, "Not found");
  const { data, error } = await admin.rpc("absence_calendar_feed", { p_token: token });
  if (error) return plain(500, "Error");
  const ics = buildCalendar((data ?? []) as Row[]);
  return new Response(req.method === "HEAD" ? null : ics, {
    status: 200,
    headers: { "Content-Type": "text/calendar; charset=utf-8", "Content-Disposition": 'inline; filename="onconic-mes-absences.ics"', "Cache-Control": "private, max-age=900" },
  });
});
