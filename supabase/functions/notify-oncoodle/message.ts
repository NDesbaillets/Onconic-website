// Messages Oncoodle (e-mail et push). Fonctions pures, testables hors Supabase.
// Le push ne contient jamais de texte libre (ni titre, ni lieu, ni message) : il s'affiche sur un écran verrouillé.
// L'e-mail contient le titre du sondage, le lieu et le message de clôture, que le créateur adresse aux participants.
export type Lang = "fr" | "en";
export type Kind = "invite" | "updated" | "reminder" | "closed" | "cancelled" | "all_responded" | "deadline" | "calendar_proposal";
export type Opt = { id: number; day: string; start: string | null; end: string | null };
export type Data = {
  poll: { id: number; kind: "slots" | "rsvp"; title: string; location: string | null; status: string; deadline: string | null; creator: string; final_option_id: number | null; final_message: string | null };
  options: Opt[];
  invitee: { required: boolean; responded: boolean; answer_on_final: string | null } | null;
  counts: { invited: number; responded: number };
};
export type Ctx = { lang: Lang; kind: Kind; data: Data; manual?: boolean; reopened?: boolean; by?: string | null };
export type Msg = { subject: string; text: string; html: string; push: { title: string; body: string; url: string; tag: string } };

const SITE = "https://onconic.ch";
export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const eu = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
export const when = (o: Opt) => `${eu(o.day)}${o.start && o.end ? `, ${o.start}–${o.end}` : ""}`;
export const link = (id: number) => `${SITE}/app/oncoodle.html#p=${id}`;
// Échéance affichée à l'heure de Zurich
export function deadlineText(iso: string | null, lang: Lang): string {
  if (!iso) return "";
  const d = new Date(iso);
  const f = new Intl.DateTimeFormat("fr-CH", { timeZone: "Europe/Zurich", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d);
  const g = (t: string) => f.find((p) => p.type === t)?.value ?? "";
  return `${g("day")}.${g("month")}.${g("year")}${lang === "en" ? " at " : " à "}${g("hour")}:${g("minute")}`;
}

const T = {
  fr: {
    invite: (who: string, rsvp: boolean) => `${who} vous invite à ${rsvp ? "répondre à un sondage de participation" : "indiquer vos disponibilités"}`,
    inviteSubject: (title: string) => `Oncoodle · Votre réponse est attendue : ${title}`,
    updated: (title: string) => `Oncoodle · Sondage modifié : ${title}`,
    updatedBody: "Les créneaux de ce sondage ont changé. Vérifiez vos réponses.",
    reopenedBody: "Le sondage est de nouveau ouvert. Vérifiez vos réponses.",
    reminder: (title: string) => `Oncoodle · Rappel : ${title}`,
    reminderBody: (who: string) => `${who} attend encore votre réponse.`,
    closed: (title: string) => `Oncoodle · Date retenue : ${title}`,
    closedRsvp: (title: string) => `Oncoodle · Confirmé : ${title}`,
    chosen: "Date retenue",
    where: "Lieu",
    message: "Message de l'organisateur",
    ics: "Le fichier joint ajoute l'événement à votre agenda.",
    cancelled: (title: string) => `Oncoodle · Sondage annulé : ${title}`,
    cancelledBody: "Ce sondage est annulé. Aucune réponse n'est plus attendue.",
    all: (title: string) => `Oncoodle · Tout le monde a répondu : ${title}`,
    allBody: (n: number) => `Les ${n} personnes invitées ont répondu. Vous pouvez choisir la date.`,
    deadline: (title: string) => `Oncoodle · Échéance passée : ${title}`,
    deadlineBody: (r: number, n: number) => `Les réponses sont closes (${r} sur ${n}). Choisissez le créneau retenu.`,
    proposal: (title: string) => `Oncoodle · Demande pour l'agenda commun : ${title}`,
    proposalBody: (by: string) => `${by} demande d'ajouter cet événement à l'agenda commun du planning des absences. La demande attend l'approbation d'un·e admin ou d'un membre de la direction, dans Oncoodle (liste des sondages).`,
    required: "Votre présence est demandée (participant·e obligatoire).",
    deadlineLine: (d: string) => `Réponse souhaitée avant le ${d}.`,
    open: "Ouvrir Oncoodle",
    slots: "Créneaux proposés",
    when: "Date",
    sent: "Message automatique de The Hive Onconic. Les rappels et résumés se désactivent dans Oncoodle.",
    pushInvite: "Une réponse est attendue dans Oncoodle.",
    pushReminder: "Rappel : une réponse est attendue dans Oncoodle.",
    pushClosed: "Une date a été retenue.",
    pushCancelled: "Un sondage a été annulé.",
    pushUpdated: "Un sondage a été modifié.",
    pushAll: "Tout le monde a répondu à votre sondage.",
    pushDeadline: "L'échéance de votre sondage est passée.",
  },
  en: {
    invite: (who: string, rsvp: boolean) => `${who} invites you to ${rsvp ? "answer an attendance poll" : "share your availability"}`,
    inviteSubject: (title: string) => `Oncoodle · Your answer is requested: ${title}`,
    updated: (title: string) => `Oncoodle · Poll updated: ${title}`,
    updatedBody: "The time slots of this poll changed. Please check your answers.",
    reopenedBody: "The poll is open again. Please check your answers.",
    reminder: (title: string) => `Oncoodle · Reminder: ${title}`,
    reminderBody: (who: string) => `${who} is still waiting for your answer.`,
    closed: (title: string) => `Oncoodle · Date chosen: ${title}`,
    closedRsvp: (title: string) => `Oncoodle · Confirmed: ${title}`,
    chosen: "Chosen date",
    where: "Location",
    message: "Message from the organiser",
    ics: "The attached file adds the event to your calendar.",
    cancelled: (title: string) => `Oncoodle · Poll cancelled: ${title}`,
    cancelledBody: "This poll is cancelled. No further answer is needed.",
    all: (title: string) => `Oncoodle · Everyone answered: ${title}`,
    allBody: (n: number) => `All ${n} invited people answered. You can choose the date.`,
    deadline: (title: string) => `Oncoodle · Deadline passed: ${title}`,
    deadlineBody: (r: number, n: number) => `Answers are closed (${r} of ${n}). Please choose the final slot.`,
    proposal: (title: string) => `Oncoodle · Shared calendar request: ${title}`,
    proposalBody: (by: string) => `${by} asks to add this event to the shared calendar of the absence planning. The request awaits approval by an admin or a member of the direction team, in Oncoodle (poll list).`,
    required: "Your attendance is requested (required participant).",
    deadlineLine: (d: string) => `Please answer before ${d}.`,
    open: "Open Oncoodle",
    slots: "Proposed slots",
    when: "Date",
    sent: "Automatic message from The Hive Onconic. Reminders and summaries can be turned off in Oncoodle.",
    pushInvite: "An answer is requested in Oncoodle.",
    pushReminder: "Reminder: an answer is requested in Oncoodle.",
    pushClosed: "A date has been chosen.",
    pushCancelled: "A poll has been cancelled.",
    pushUpdated: "A poll has been updated.",
    pushAll: "Everyone answered your poll.",
    pushDeadline: "The deadline of your poll has passed.",
  },
} as const;

export function buildMessage(c: Ctx): Msg {
  const t = T[c.lang], p = c.data.poll, rsvp = p.kind === "rsvp";
  const url = link(p.id), lines: string[] = [];
  let subject = "", push = "";
  const final = c.data.options.find((o) => o.id === p.final_option_id);
  const list = (opts: Opt[]) => opts.slice(0, 12).map((o) => `• ${when(o)}`).concat(opts.length > 12 ? [`• … (+${opts.length - 12})`] : []);
  switch (c.kind) {
    case "invite":
      subject = t.inviteSubject(p.title); push = t.pushInvite;
      lines.push(t.invite(p.creator, rsvp), "", `« ${p.title} »`, "", `${rsvp ? t.when : t.slots} :`, ...list(c.data.options));
      if (c.data.invitee?.required) lines.push("", t.required);
      if (p.deadline) lines.push("", t.deadlineLine(deadlineText(p.deadline, c.lang)));
      break;
    case "updated":
      subject = t.updated(p.title); push = t.pushUpdated;
      lines.push(c.reopened ? t.reopenedBody : t.updatedBody, "", `« ${p.title} »`, "", ...list(c.data.options));
      break;
    case "reminder":
      subject = t.reminder(p.title); push = t.pushReminder;
      lines.push(t.reminderBody(p.creator), "", `« ${p.title} »`, "", ...list(c.data.options));
      if (p.deadline) lines.push("", t.deadlineLine(deadlineText(p.deadline, c.lang)));
      break;
    case "closed":
      subject = (rsvp ? t.closedRsvp : t.closed)(p.title); push = t.pushClosed;
      lines.push(`« ${p.title} »`, "", `${t.chosen} : ${final ? when(final) : ""}`);
      if (p.location) lines.push(`${t.where} : ${p.location}`);
      if (p.final_message) lines.push("", `${t.message} :`, p.final_message);
      if (c.data.invitee?.answer_on_final !== "no") lines.push("", t.ics);
      break;
    case "cancelled":
      subject = t.cancelled(p.title); push = t.pushCancelled;
      lines.push(t.cancelledBody, "", `« ${p.title} »`);
      if (p.final_message) lines.push("", `${t.message} :`, p.final_message);
      break;
    case "all_responded":
      subject = t.all(p.title); push = t.pushAll;
      lines.push(t.allBody(c.data.counts.invited), "", `« ${p.title} »`);
      break;
    case "deadline":
      subject = t.deadline(p.title); push = t.pushDeadline;
      lines.push(t.deadlineBody(c.data.counts.responded, c.data.counts.invited), "", `« ${p.title} »`);
      break;
    case "calendar_proposal":
      subject = t.proposal(p.title); push = "";
      lines.push(t.proposalBody(c.by ?? p.creator), "", `« ${p.title} »`, `${t.chosen} : ${final ? when(final) : ""}`);
      break;
  }
  const text = [...lines, "", `${t.open} : ${url}`, "", t.sent].join("\n");
  const body = lines.map((l) => (l === "" ? "<br>" : `<p style="margin:0 0 6px">${esc(l)}</p>`)).join("");
  const html = `<div style="font-family:Helvetica Neue,Helvetica,Arial,sans-serif;color:#001B4D;max-width:560px">${body}<p style="margin:18px 0"><a href="${url}" style="background:#F0B12B;color:#001B4D;padding:10px 16px;text-decoration:none;font-weight:600">${esc(t.open)}</a></p><p style="font-size:12px;color:#5b6b8a">${esc(t.sent)}</p></div>`;
  return { subject, text, html, push: { title: "Oncoodle", body: push, url: c.kind === "calendar_proposal" ? "/app/oncoodle.html" : `/app/oncoodle.html#p=${p.id}`, tag: `oncoodle-${p.id}-${c.kind}` } };
}
