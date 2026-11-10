// Flux iCal personnel « Mon agenda Onconic » (congrès + absences) : https://<projet>.supabase.co/functions/v1/agenda-feed?t=<jeton>
// Même jeton secret que les flux « Mes congrès » (calendar-feed) et « Mes absences » (absence-feed) : un seul abonnement
// pour ceux qui préfèrent tout voir dans un même agenda. Les deux flux séparés restent disponibles.
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { buildCalendar as congresCalendar, type Row as CongresRow } from "./congres.ts";
import { buildCalendar as absencesCalendar, type Row as AbsenceRow } from "./absences.ts";
import { mergeCalendars } from "./merge.ts";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const plain = (status: number, body: string) =>
  new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });

Deno.serve(async (req) => {
  if (req.method !== "GET" && req.method !== "HEAD") return plain(405, "Method not allowed");
  const token = new URL(req.url).searchParams.get("t") ?? "";
  if (!/^[0-9a-f]{64}$/.test(token)) return plain(404, "Not found");
  const { data: owner } = await admin.from("calendar_tokens").select("user_id").eq("token", token).maybeSingle();
  if (!owner) return plain(404, "Not found");
  const [congres, absences] = await Promise.all([
    admin.rpc("calendar_feed", { p_token: token }),
    admin.rpc("absence_calendar_feed", { p_token: token }),
  ]);
  if (congres.error || absences.error) return plain(500, "Error");
  const ics = mergeCalendars("Onconic · Mon agenda",
    congresCalendar((congres.data ?? []) as CongresRow[]),
    absencesCalendar((absences.data ?? []) as AbsenceRow[]));
  return new Response(req.method === "HEAD" ? null : ics, {
    status: 200,
    headers: { "Content-Type": "text/calendar; charset=utf-8", "Content-Disposition": 'inline; filename="onconic-mon-agenda.ics"', "Cache-Control": "private, max-age=900" },
  });
});
