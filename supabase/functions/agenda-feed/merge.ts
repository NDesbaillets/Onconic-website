// Fusion de flux iCal. Fonction pure, testable hors Supabase.
// Fusionne les événements de plusieurs calendriers iCal dans le premier, sous un nouveau nom
export function mergeCalendars(name: string, first: string, ...others: string[]): string {
  const events = (ics: string) => {
    const a = ics.indexOf("BEGIN:VEVENT"), b = ics.lastIndexOf("END:VCALENDAR");
    return a < 0 ? "" : ics.slice(a, b);
  };
  const head = first.slice(0, first.indexOf("BEGIN:VEVENT") < 0 ? first.lastIndexOf("END:VCALENDAR") : first.indexOf("BEGIN:VEVENT"))
    .replace(/X-WR-CALNAME:[^\r\n]*/, `X-WR-CALNAME:${name}`)
    .replace(/PRODID:[^\r\n]*/, "PRODID:-//Onconic//Agenda//FR");
  return head + [first, ...others].map(events).join("") + "END:VCALENDAR\r\n";
}
