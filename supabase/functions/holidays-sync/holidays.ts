// Vacances scolaires vaudoises depuis OpenHolidays (openholidaysapi.org). Fonctions pures, testables hors Supabase.
export type ApiHoliday = { id: string; startDate: string; endDate: string; name: { language: string; text: string }[] };
export type Period = { ext_id: string; label: string; start_date: string; end_date: string };

// Intitulés usuels dans le canton de Vaud
const NAMES: Record<string, string> = { "sport": "relâches", "printemps": "printemps", "été": "été", "automne": "automne", "noël": "Noël" };

export function toPeriods(rows: ApiHoliday[]): Period[] {
  return rows
    .filter((r) => r && r.id && /^\d{4}-\d{2}-\d{2}$/.test(r.startDate) && /^\d{4}-\d{2}-\d{2}$/.test(r.endDate) && r.endDate >= r.startDate)
    .map((r) => {
      const raw = (r.name.find((n) => n.language === "FR") ?? r.name[0])?.text ?? "vacances";
      const name = NAMES[raw.toLowerCase()] ?? raw;
      return { ext_id: "openholidays:" + r.id, label: `Vacances scolaires VD : ${name}`, start_date: r.startDate, end_date: r.endDate };
    });
}

// Fenêtre importée : de l'année en cours à deux ans plus tard
export function windowFor(now = new Date()): { from: string; to: string } {
  const y = now.getUTCFullYear();
  return { from: `${y}-01-01`, to: `${y + 2}-12-31` };
}
