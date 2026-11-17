// Flux iCal « Mon planning » : https://<projet>.supabase.co/functions/v1/plan-feed?t=<jeton>
// Même jeton secret que les autres flux personnels (public.calendar_tokens) : les agendas ne savent pas se connecter.
// Un événement « journée entière » par jour ouvrable où la ligne du membre a un poste ou une absence (J-30 à J+180).
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const SITE = "https://onconic.ch";
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const plain = (status: number, body: string) =>
  new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });

type Row = { day: string; half: number; code: string; label: string | null; source: string; status: string | null };
const esc = (s: unknown) => String(s ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
function fold(line: string): string {
  const enc = new TextEncoder(), out: string[] = [];
  let cur = "", bytes = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (bytes + n > (out.length ? 74 : 75)) { out.push(cur); cur = ""; bytes = 0; }
    cur += ch; bytes += n;
  }
  out.push(cur);
  return out.join("\r\n ");
}
const ymd = (iso: string) => iso.replace(/-/g, "");
const nextDay = (iso: string) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";

export function buildCalendar(rows: Row[], key: string, now = new Date()): string {
  const L = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Onconic//Planning//FR", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "X-WR-CALNAME:Onconic · Mon planning", "REFRESH-INTERVAL;VALUE=DURATION:PT6H", "X-PUBLISHED-TTL:PT6H"];
  const days = new Map<string, Row[]>();
  for (const r of rows) { if (!days.has(r.day)) days.set(r.day, []); days.get(r.day)!.push(r); }
  const dtstamp = stamp(now);
  for (const [day, list] of days) {
    const am = list.find((r) => r.half === 0), pm = list.find((r) => r.half === 1);
    const tag = (r?: Row) => (r ? r.code + (r.status === "requested" ? " ?" : "") : "—");
    const summary = am && pm && tag(am) === tag(pm) ? tag(am) : `${tag(am)} / ${tag(pm)}`;
    const line = (r: Row | undefined, h: string) => r ? `${h} : ${r.code}${r.label ? " · " + r.label : ""}${r.source === "absences" ? (r.status === "requested" ? " (absence demandée, en attente)" : " (absence validée)") : ""}` : `${h} : —`;
    const tentative = list.some((r) => r.status === "requested");
    L.push("BEGIN:VEVENT", `UID:planning-${key}-${day}@onconic.ch`, `DTSTAMP:${dtstamp}`,
      `DTSTART;VALUE=DATE:${ymd(day)}`, `DTEND;VALUE=DATE:${ymd(nextDay(day))}`,
      `SUMMARY:${esc("Planning : " + summary)}`, `DESCRIPTION:${esc(line(am, "Matin") + "\n" + line(pm, "Après-midi"))}`,
      `STATUS:${tentative ? "TENTATIVE" : "CONFIRMED"}`, "TRANSP:TRANSPARENT", `URL:${SITE}/app/planning.html`, "END:VEVENT");
  }
  L.push("END:VCALENDAR");
  return L.map(fold).join("\r\n") + "\r\n";
}

Deno.serve(async (req) => {
  if (req.method !== "GET" && req.method !== "HEAD") return plain(405, "Method not allowed");
  const token = new URL(req.url).searchParams.get("t") ?? "";
  if (!/^[0-9a-f]{64}$/.test(token)) return plain(404, "Not found");
  const { data: owner } = await admin.from("calendar_tokens").select("user_id").eq("token", token).maybeSingle();
  if (!owner) return plain(404, "Not found");
  const { data, error } = await admin.rpc("plan_calendar_feed", { p_token: token });
  if (error) return plain(500, "Error");
  // Identifiant stable et non devinable pour les UID (jamais l'identifiant du compte)
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  const key = [...digest.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const ics = buildCalendar((data ?? []) as Row[], key);
  return new Response(req.method === "HEAD" ? null : ics, {
    status: 200,
    headers: { "Content-Type": "text/calendar; charset=utf-8", "Content-Disposition": 'inline; filename="onconic-mon-planning.ics"', "Cache-Control": "private, max-age=900" },
  });
});
