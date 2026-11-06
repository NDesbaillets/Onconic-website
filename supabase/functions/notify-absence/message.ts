// Texte des notifications d'absence. Fonctions pures (testables hors Supabase).
export type Lang = "fr" | "en";
export type Event = "request" | "change" | "decision";

// « 2026-11-12 » -> « 12.11.2026 » (format européen)
const eu = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
export function dates(start: string, end: string): string {
  return !end || end === start ? eu(start) : `${eu(start)} – ${eu(end)}`;
}

const KIND = {
  fr: { vacances: "vacances", congres: "congrès", autre: "autre" },
  en: { vacances: "vacation", congres: "conference", autre: "other" },
} as const;

const T = {
  fr: {
    title: "Absences",
    request: (who: string, kind: string, when: string) => `${who} demande une absence (${kind}) : ${when}.`,
    modify: (who: string, when: string) => `${who} demande la modification d'une absence validée (${when}).`,
    remove: (who: string, when: string) => `${who} demande la suppression d'une absence validée (${when}).`,
    approved: (when: string) => `Votre demande d'absence (${when}) a été validée.`,
    rejected: (when: string) => `Votre demande d'absence (${when}) a été refusée.`,
    changeApproved: (when: string) => `Votre demande de changement (${when}) a été acceptée.`,
    changeRejected: (when: string) => `Votre demande de changement (${when}) a été refusée ; l'absence reste validée.`,
    comment: (c: string) => ` Commentaire : « ${c} »`,
  },
  en: {
    title: "Absences",
    request: (who: string, kind: string, when: string) => `${who} requests an absence (${kind}): ${when}.`,
    modify: (who: string, when: string) => `${who} asks to change an approved absence (${when}).`,
    remove: (who: string, when: string) => `${who} asks to delete an approved absence (${when}).`,
    approved: (when: string) => `Your absence request (${when}) was approved.`,
    rejected: (when: string) => `Your absence request (${when}) was declined.`,
    changeApproved: (when: string) => `Your change request (${when}) was accepted.`,
    changeRejected: (when: string) => `Your change request (${when}) was declined; the absence stays approved.`,
    comment: (c: string) => ` Comment: “${c}”`,
  },
};

export type Absence = {
  id: number; kind: keyof typeof KIND.fr; start_date: string; end_date: string;
  change_type: "modify" | "delete" | null; change_start: string | null; change_end: string | null;
  decision: "approved" | "rejected" | "change_approved" | "change_rejected" | null; decision_comment: string | null;
};

// Message pour les valideurs (request, change) ou pour le demandeur (decision)
export function buildMessage(i: { lang: Lang; event: Event; who: string; a: Absence }) {
  const t = T[i.lang] ?? T.fr;
  const a = i.a;
  if (i.event === "decision") {
    const when = dates(a.start_date, a.end_date);
    const base = a.decision === "approved" ? t.approved(when) : a.decision === "rejected" ? t.rejected(when)
      : a.decision === "change_approved" ? t.changeApproved(when) : t.changeRejected(when);
    return { title: t.title, body: base + (a.decision_comment ? t.comment(a.decision_comment) : ""), url: "/app/absences.html#mine", tag: `absence-${a.id}` };
  }
  if (i.event === "change") {
    const body = a.change_type === "delete"
      ? t.remove(i.who, dates(a.start_date, a.end_date))
      : t.modify(i.who, dates(a.change_start ?? a.start_date, a.change_end ?? a.end_date));
    return { title: t.title, body, url: "/app/absences.html#todo", tag: `absence-todo-${a.id}` };
  }
  return {
    title: t.title,
    body: t.request(i.who, (KIND[i.lang] ?? KIND.fr)[a.kind], dates(a.start_date, a.end_date)),
    url: "/app/absences.html#todo",
    tag: `absence-todo-${a.id}`,
  };
}
