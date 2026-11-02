// Texte des notifications « un autre membre participe au même congrès ». Fonctions pures (testables hors Supabase).
export type Lang = "fr" | "en";

// « 2026-11-12 » -> « 12.11.2026 » (format européen)
const eu = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;

export function dates(start: string | null, end: string | null): string {
  if (!start) return "";
  if (!end || end === start) return eu(start);
  return `${eu(start)} – ${eu(end)}`;
}

// Le nom n'est donné que si le membre l'a accepté (profiles.show_in_events) ; sinon null
export function joinerName(p: { first_name?: string | null; last_name?: string | null; full_name?: string | null; username?: string | null; show_in_events?: boolean | null } | null): string | null {
  if (!p || !p.show_in_events) return null;
  const n = [p.first_name, p.last_name].filter(Boolean).join(" ").trim();
  return n || p.full_name || p.username || null;
}

const TEXT = {
  fr: {
    title: "The Hive au congrès",
    named: (who: string, ev: string, when: string) => `${who} participe aussi à « ${ev} »${when ? ` (${when})` : ""}.`,
    anon: (ev: string, when: string) => `Un autre membre de The Hive participe aussi à « ${ev} »${when ? ` (${when})` : ""}.`,
  },
  en: {
    title: "The Hive at conferences",
    named: (who: string, ev: string, when: string) => `${who} is also attending “${ev}”${when ? ` (${when})` : ""}.`,
    anon: (ev: string, when: string) => `Another Hive member is also attending “${ev}”${when ? ` (${when})` : ""}.`,
  },
};

export function buildMessage(i: { lang: Lang; eventId: number; title: string; start: string | null; end: string | null; name: string | null }) {
  const t = TEXT[i.lang] ?? TEXT.fr;
  const when = dates(i.start, i.end);
  return {
    title: t.title,
    body: i.name ? t.named(i.name, i.title, when) : t.anon(i.title, when),
    url: `/app/congres.html?e=${i.eventId}`,
    tag: `event-${i.eventId}`,
  };
}
