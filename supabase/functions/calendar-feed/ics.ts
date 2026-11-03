// Construction du flux iCal « Mes congrès ». Fonctions pures (testables hors Supabase).
export type Row = {
  event_id: number; status: string; title: string; description: string | null;
  start_date: string; end_date: string; city: string | null; country: string | null; venue: string | null; url: string | null;
  clinics: string[] | null; to_confirm: boolean; abstract_deadline: string | null; early_deadline: string | null;
  talk_title: string | null; talk_type: string | null; talk_date: string | null; talk_time: string | null;
  updated_at: string; user_key: string;
};

const SITE = "https://onconic.ch";
const STATUS_TEXT: Record<string, string> = { going: "Je participe", maybe: "Peut-être", presenting: "Je présente" };
const TALK_TYPE: Record<string, string> = { oral: "Communication orale", poster: "Poster", "invité": "Orateur invité", "table ronde": "Table ronde" };

// Valeur de texte iCal : échappement de \ ; , et des retours à la ligne
export const esc = (s: unknown) => String(s ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

// Pliage des lignes à 75 octets (UTF-8), sans couper un caractère
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
// Heure flottante (heure locale du lieu, sans fuseau) : AAAAMMJJTHHMMSS
const floating = (date: string, time: string) => `${ymd(date)}T${time.replace(/:/g, "").slice(0, 4).padEnd(4, "0")}00`;
const addHour = (date: string, time: string) => {
  const d = new Date(`${date}T${time.slice(0, 5)}:00Z`); d.setUTCHours(d.getUTCHours() + 1);
  return `${d.toISOString().slice(0, 10).replace(/-/g, "")}T${d.toISOString().slice(11, 16).replace(":", "")}00`;
};

function alarm(text: string) {
  // 3 jours avant, à 9 h (l'événement d'une journée entière commence à 0 h : 2 j 15 h avant)
  return ["BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${esc(text)}`, "TRIGGER:-P2DT15H", "END:VALARM"];
}

export function buildCalendar(rows: Row[], now = new Date()): string {
  const L: string[] = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Onconic//Congres//FR", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "X-WR-CALNAME:Onconic · Mes congrès", "REFRESH-INTERVAL;VALUE=DURATION:PT6H", "X-PUBLISHED-TTL:PT6H",
  ];
  const dtstamp = stamp(now);
  for (const r of rows) {
    const modified = stamp(r.updated_at);
    const where = [r.venue, r.city, r.country].filter(Boolean).join(", ");
    const page = `${SITE}/app/congres.html?e=${r.event_id}`;
    const tentative = r.status === "maybe" || r.to_confirm;
    L.push(
      "BEGIN:VEVENT", `UID:event-${r.event_id}@onconic.ch`, `DTSTAMP:${dtstamp}`, `LAST-MODIFIED:${modified}`,
      `DTSTART;VALUE=DATE:${ymd(r.start_date)}`, `DTEND;VALUE=DATE:${ymd(nextDay(r.end_date))}`,
      `SUMMARY:${esc(r.title + (r.to_confirm ? " (dates à confirmer)" : ""))}`,
    );
    if (where) L.push(`LOCATION:${esc(where)}`);
    L.push(`DESCRIPTION:${esc([`Votre statut : ${STATUS_TEXT[r.status] ?? r.status}`, r.description, (r.clinics ?? []).length ? `Cliniques : ${(r.clinics ?? []).join(", ")}` : "", page].filter(Boolean).join("\n"))}`);
    L.push(`URL:${r.url || page}`, `STATUS:${tentative ? "TENTATIVE" : "CONFIRMED"}`, "END:VEVENT");

    for (const [kind, label, date] of [["abstract", "Échéance abstracts", r.abstract_deadline], ["early", "Fin du tarif réduit", r.early_deadline]] as const) {
      if (!date) continue;
      L.push(
        "BEGIN:VEVENT", `UID:${kind}-${r.event_id}@onconic.ch`, `DTSTAMP:${dtstamp}`, `LAST-MODIFIED:${modified}`,
        `DTSTART;VALUE=DATE:${ymd(date)}`, `DTEND;VALUE=DATE:${ymd(nextDay(date))}`,
        `SUMMARY:${esc(`${label} : ${r.title}`)}`, "TRANSP:TRANSPARENT", `URL:${r.url || page}`,
        `DESCRIPTION:${esc(`${label} pour « ${r.title} ».\n${page}`)}`,
        ...alarm(`${label} : ${r.title}`), "END:VEVENT",
      );
    }

    if (r.status === "presenting" && r.talk_title && r.talk_date) {
      const type = r.talk_type ? TALK_TYPE[r.talk_type] ?? r.talk_type : "";
      L.push("BEGIN:VEVENT", `UID:talk-${r.event_id}-${r.user_key}@onconic.ch`, `DTSTAMP:${dtstamp}`, `LAST-MODIFIED:${modified}`);
      if (r.talk_time) L.push(`DTSTART:${floating(r.talk_date, r.talk_time)}`, `DTEND:${addHour(r.talk_date, r.talk_time)}`);
      else L.push(`DTSTART;VALUE=DATE:${ymd(r.talk_date)}`, `DTEND;VALUE=DATE:${ymd(nextDay(r.talk_date))}`);
      L.push(`SUMMARY:${esc("Présentation : " + r.talk_title)}`);
      if (where) L.push(`LOCATION:${esc(where)}`);
      L.push(`DESCRIPTION:${esc([type, r.title, page].filter(Boolean).join("\n"))}`, `URL:${page}`, "END:VEVENT");
    }
  }
  L.push("END:VCALENDAR");
  return L.map(fold).join("\r\n") + "\r\n";
}
