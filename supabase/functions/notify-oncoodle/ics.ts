// Fichier agenda (.ics) d'un sondage clos. Heures locales de Zurich avec définition du fuseau, journée entière sans heure.
export type IcsEvent = { id: number; title: string; location?: string | null; day: string; start?: string | null; end?: string | null; sequence?: number };

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
// Pliage des lignes à 75 caractères (RFC 5545), continuation par une espace
const fold = (line: string) => {
  const out: string[] = [];
  let rest = line;
  while ([...rest].length > 74) { const head = [...rest].slice(0, 74).join(""); out.push(head); rest = " " + rest.slice(head.length); }
  out.push(rest);
  return out.join("\r\n");
};
const compact = (day: string) => day.replaceAll("-", "");
const nextDay = (day: string) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

const ZURICH = [
  "BEGIN:VTIMEZONE", "TZID:Europe/Zurich",
  "BEGIN:DAYLIGHT", "TZOFFSETFROM:+0100", "TZOFFSETTO:+0200", "TZNAME:CEST", "DTSTART:19700329T020000", "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU", "END:DAYLIGHT",
  "BEGIN:STANDARD", "TZOFFSETFROM:+0200", "TZOFFSETTO:+0100", "TZNAME:CET", "DTSTART:19701025T030000", "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU", "END:STANDARD",
  "END:VTIMEZONE",
];

export function buildIcs(e: IcsEvent, now = new Date()): string {
  const timed = !!(e.start && e.end);
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Onconic//Oncoodle//FR", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    ...(timed ? ZURICH : []),
    "BEGIN:VEVENT",
    `UID:oncoodle-${e.id}@onconic.ch`,
    `DTSTAMP:${stamp(now)}`,
    `SEQUENCE:${e.sequence ?? 0}`,
    timed ? `DTSTART;TZID=Europe/Zurich:${compact(e.day)}T${e.start!.replace(":", "")}00` : `DTSTART;VALUE=DATE:${compact(e.day)}`,
    timed ? `DTEND;TZID=Europe/Zurich:${compact(e.day)}T${e.end!.replace(":", "")}00` : `DTEND;VALUE=DATE:${compact(nextDay(e.day))}`,
    `SUMMARY:${esc(e.title)}`,
    ...(e.location ? [`LOCATION:${esc(e.location)}`] : []),
    "END:VEVENT", "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}
