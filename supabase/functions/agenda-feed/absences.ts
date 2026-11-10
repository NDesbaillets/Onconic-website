// Copie de supabase/functions/absence-feed/ics.ts (une fonction Edge se déploie seule) : garder les deux identiques.
// Flux iCal « Mes absences ». Fonctions pures, testables hors Supabase.
export type Row = {
  id: number; kind: string; note: string | null; status: string; start_date: string; end_date: string;
  change_type: string | null; updated_at: string; user_key: string;
};
const SITE = "https://onconic.ch";
const KIND: Record<string, string> = { vacances: "Vacances", congres: "Congrès", autre: "Absence" };

export const esc = (s: unknown) => String(s ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
export function fold(line: string): string {
  const enc = new TextEncoder();
  const out: string[] = [];
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
const stamp = (ts: string | Date) => new Date(ts).toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
const eu = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;

export function buildCalendar(rows: Row[], now = new Date()): string {
  const L: string[] = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Onconic//Absences//FR", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "X-WR-CALNAME:Onconic · Mes absences", "REFRESH-INTERVAL;VALUE=DURATION:PT6H", "X-PUBLISHED-TTL:PT6H",
  ];
  const dtstamp = stamp(now);
  for (const r of rows) {
    const confirmed = r.status === "approved";
    const label = KIND[r.kind] ?? "Absence";
    const desc = [
      confirmed ? "Absence validée par tous les validateurs." : "Demande en attente de validation.",
      r.note ? `Précision : ${r.note}` : "",
      r.change_type === "delete" ? "Suppression demandée, en attente de décision." : r.change_type === "modify" ? "Modification demandée, en attente de décision." : "",
      `${eu(r.start_date)}${r.end_date !== r.start_date ? " – " + eu(r.end_date) : ""}`,
    ].filter(Boolean).join("\n");
    L.push(
      "BEGIN:VEVENT", `UID:absence-${r.id}@onconic.ch`, `DTSTAMP:${dtstamp}`, `LAST-MODIFIED:${stamp(r.updated_at)}`,
      `DTSTART;VALUE=DATE:${ymd(r.start_date)}`, `DTEND;VALUE=DATE:${ymd(nextDay(r.end_date))}`,
      `SUMMARY:${esc(label + (confirmed ? "" : " (en attente)"))}`, `DESCRIPTION:${esc(desc)}`,
      `STATUS:${confirmed ? "CONFIRMED" : "TENTATIVE"}`, "TRANSP:OPAQUE", `URL:${SITE}/app/absences.html`, "END:VEVENT",
    );
  }
  L.push("END:VCALENDAR");
  return L.map(fold).join("\r\n") + "\r\n";
}
