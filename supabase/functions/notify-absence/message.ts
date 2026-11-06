// Messages des absences (e-mail et push). Fonctions pures, testables hors Supabase.
export type Lang = "fr" | "en";
export type Kind = "to_validate" | "to_validate_change" | "approved" | "rejected" | "change_approved" | "change_rejected";

export type Abs = {
  id: number; kind: "vacances" | "congres" | "autre"; start_date: string; end_date: string; note: string | null;
  change_type: "modify" | "delete" | null; change_kind: string | null; change_note: string | null;
  change_start: string | null; change_end: string | null;
};
export type Ctx = {
  lang: Lang; kind: Kind; owner: string; by?: string | null; comment?: string | null; reminder?: boolean;
  absences: Abs[]; validators: string[]; approvers: string[];
};

const SITE = "https://onconic.ch";
const eu = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
export const period = (a: string, b: string) => (!b || a === b ? eu(a) : `${eu(a)} – ${eu(b)}`);
export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

const KIND = {
  fr: { vacances: "vacances", congres: "congrès", autre: "autre" },
  en: { vacances: "vacation", congres: "conference", autre: "other" },
} as const;

const T = {
  fr: {
    toValidate: (who: string, n: number) => `${who} demande ${n > 1 ? `${n} absences` : "une absence"} à valider`,
    toValidateChange: (who: string, del: boolean) => `${who} demande ${del ? "la suppression" : "la modification"} d'une absence validée`,
    approved: "Votre absence est validée",
    approvedMany: "Votre demande d'absence est validée",
    rejected: "Votre demande d'absence a été refusée",
    changeApproved: "Votre demande de changement est acceptée",
    changeRejected: "Votre demande de changement a été refusée",
    needAll: (names: string[]) => `Chaque absence doit être validée par tous les validateurs concernés${names.length ? ` : ${names.join(", ")}` : ""}.`,
    approvedBy: (names: string[]) => (names.length ? `Validée par : ${names.join(", ")}.` : "Validée."),
    rejectedBy: (by: string) => `Refusée par ${by}.`,
    stays: "L'absence reste validée aux dates actuelles.",
    comment: (c: string) => `Commentaire : « ${c} »`,
    open: "Ouvrir Absences",
    delHint: "Vous pouvez supprimer cette demande ou la modifier puis la renvoyer ; elle disparaît d'elle-même 14 jours après le refus.",
    sent: "Message automatique de The Hive Onconic.",
    remind: "Rappel",
    remindText: "Ce message est un rappel : votre décision est toujours attendue.",
    note: "Précision",
    wasChange: "devient",
    deletion: "suppression demandée",
  },
  en: {
    toValidate: (who: string, n: number) => `${who} requests ${n > 1 ? `${n} absences` : "an absence"} for approval`,
    toValidateChange: (who: string, del: boolean) => `${who} asks to ${del ? "delete" : "change"} an approved absence`,
    approved: "Your absence is approved",
    approvedMany: "Your absence request is approved",
    rejected: "Your absence request was declined",
    changeApproved: "Your change request was accepted",
    changeRejected: "Your change request was declined",
    needAll: (names: string[]) => `Each absence must be approved by all validators concerned${names.length ? `: ${names.join(", ")}` : ""}.`,
    approvedBy: (names: string[]) => (names.length ? `Approved by: ${names.join(", ")}.` : "Approved."),
    rejectedBy: (by: string) => `Declined by ${by}.`,
    stays: "The absence stays approved on its current dates.",
    comment: (c: string) => `Comment: “${c}”`,
    open: "Open Absences",
    delHint: "You can delete this request, or change it and send it again; it disappears by itself 14 days after the refusal.",
    sent: "Automatic message from The Hive Onconic.",
    remind: "Reminder",
    remindText: "This is a reminder: your decision is still pending.",
    note: "Note",
    wasChange: "becomes",
    deletion: "deletion requested",
  },
};

function line(l: Lang, a: Abs, withChange: boolean): string {
  const t = T[l];
  let s = `${period(a.start_date, a.end_date)} · ${KIND[l][a.kind]}`;
  if (a.note) s += ` (${t.note.toLowerCase()} : ${a.note})`;
  if (withChange && a.change_type === "delete") s += ` · ${t.deletion}`;
  if (withChange && a.change_type === "modify" && a.change_start && a.change_end) {
    s += ` → ${t.wasChange} ${period(a.change_start, a.change_end)}${a.change_kind ? " · " + (KIND[l][a.change_kind as keyof typeof KIND.fr] ?? a.change_kind) : ""}`;
  }
  return s;
}

export function buildEmail(c: Ctx) {
  const t = T[c.lang] ?? T.fr;
  const lang = c.lang === "en" ? "en" : "fr";
  const toValidator = c.kind === "to_validate" || c.kind === "to_validate_change";
  const url = `${SITE}/app/absences.html#${toValidator ? "todo" : "mine"}`;
  const withChange = c.kind === "to_validate_change";
  const lines = c.absences.map((a) => line(lang, a, withChange));
  const del = c.absences[0]?.change_type === "delete";

  let subject = "", intro = "";
  const extra: string[] = [];
  switch (c.kind) {
    case "to_validate": subject = t.toValidate(c.owner, c.absences.length); extra.push(t.needAll(c.validators)); break;
    case "to_validate_change": subject = t.toValidateChange(c.owner, del); extra.push(t.needAll(c.validators)); break;
    case "approved": subject = c.absences.length > 1 ? t.approvedMany : t.approved; extra.push(t.approvedBy(c.approvers)); break;
    case "rejected": subject = t.rejected; extra.push(t.rejectedBy(c.by ?? "—")); if (c.comment) extra.push(t.comment(c.comment)); extra.push(t.delHint); break;
    case "change_approved": subject = t.changeApproved; extra.push(t.approvedBy(c.approvers)); break;
    case "change_rejected": subject = t.changeRejected; extra.push(t.rejectedBy(c.by ?? "—")); if (c.comment) extra.push(t.comment(c.comment)); extra.push(t.stays); break;
  }
  if (c.reminder && toValidator) { subject = `${t.remind}${lang === "fr" ? " : " : ": "}${subject}`; extra.unshift(t.remindText); }
  intro = subject + ".";
  const text = [intro, "", ...lines.map((l) => `• ${l}`), "", ...extra, "", `${t.open} : ${url}`, "", t.sent].join("\n");
  const html = `<div style="font-family:Helvetica,Arial,sans-serif;color:#1A2A4A;font-size:15px;line-height:1.5;max-width:560px">
<p style="font-size:18px;color:#001B4D;margin:0 0 12px">${esc(intro)}</p>
<ul style="padding-left:18px;margin:0 0 12px">${lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>
${extra.map((e) => `<p style="margin:0 0 8px">${esc(e)}</p>`).join("")}
<p style="margin:16px 0"><a href="${url}" style="display:inline-block;padding:12px 20px;background:#F0B12B;color:#001B4D;text-decoration:none;font-weight:500;border:1px solid #001B4D">${esc(t.open)}</a></p>
<p style="font-size:12px;color:#5A6478">${esc(t.sent)}</p></div>`;
  const first = c.absences[0];
  const push = {
    title: "Absences",
    body: toValidator ? subject : `${subject}${first ? " (" + period(first.start_date, first.end_date) + ")" : ""}.`,
    url: `/app/absences.html#${toValidator ? "todo" : "mine"}`,
    tag: `absence-${c.kind}-${first?.id ?? 0}`,
  };
  return { subject: `Onconic · ${subject}`, text, html, push };
}
