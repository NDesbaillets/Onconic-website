// Messages des absences (e-mail et push). Fonctions pures, testables hors Supabase.
export type Lang = "fr" | "en";
export type Kind = "to_validate" | "to_validate_change" | "approved" | "rejected" | "change_approved" | "change_rejected" | "to_direction" | "direction_change" | "to_opinion";

export type Abs = {
  id: number; kind: "vacances" | "congres" | "autre"; start_date: string; end_date: string; note: string | null;
  change_type: "modify" | "delete" | null; change_kind: string | null; change_note: string | null;
  change_start: string | null; change_end: string | null;
};
export type Ctx = {
  lang: Lang; kind: Kind; owner: string; by?: string | null; comment?: string | null; reminder?: boolean; action?: string | null;
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
    toDirection: (who: string, n: number) => `${who} : ${n > 1 ? `${n} demandes` : "demande"}, visa de la direction requis`,
    directionNeed: "Le visa de la direction conclut la demande. Le circuit et les décisions sont consultables dans l’application.",
    toOpinion: (who: string, n: number) => `${who} demande ${n > 1 ? `${n} absences` : "une absence"} : pré-avis de la direction possible`,
    toOpinionChange: (who: string, del: boolean) => `${who} demande ${del ? "la suppression" : "la modification"} d'une absence validée : pré-avis de la direction possible`,
    opinionNeed: "Étape facultative, sans effet bloquant : votre pré-avis (favorable ou non, avec un commentaire) s'affiche avec la demande chez les validateurs de la clinique, comme aide à la décision. Vous viserez ensuite la demande une fois les validateurs passés.",
    dirAdded: (by: string) => `${by} a ajouté une absence à votre nom`,
    dirEdited: (by: string) => `${by} a modifié votre absence`,
    dirCancelled: (by: string) => `${by} a annulé votre absence`,
    dirNote: "La direction l'a enregistrée ou modifiée directement : elle est validée.",
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
    toDirection: (who: string, n: number) => `${who}: ${n > 1 ? `${n} requests` : "request"}, management sign-off needed`,
    directionNeed: "Management sign-off completes the request. The approval chain and decisions are available in the app.",
    toOpinion: (who: string, n: number) => `${who} requests ${n > 1 ? `${n} absences` : "an absence"}: management pre-opinion possible`,
    toOpinionChange: (who: string, del: boolean) => `${who} asks to ${del ? "delete" : "change"} an approved absence: management pre-opinion possible`,
    opinionNeed: "Optional, non-blocking step: your pre-opinion (favourable or not, with a comment) is shown with the request to the clinic validators as decision support. You will give the final sign-off once the validators have decided.",
    dirAdded: (by: string) => `${by} added an absence in your name`,
    dirEdited: (by: string) => `${by} changed your absence`,
    dirCancelled: (by: string) => `${by} cancelled your absence`,
    dirNote: "Management entered or changed it directly: it is approved.",
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
  // Les précisions et commentaires se consultent uniquement dans l’application authentifiée.
  if (withChange && a.change_type === "delete") s += ` · ${t.deletion}`;
  if (withChange && a.change_type === "modify" && a.change_start && a.change_end) {
    s += ` → ${t.wasChange} ${period(a.change_start, a.change_end)}${a.change_kind ? " · " + (KIND[l][a.change_kind as keyof typeof KIND.fr] ?? a.change_kind) : ""}`;
  }
  return s;
}

export function buildEmail(c: Ctx) {
  const t = T[c.lang] ?? T.fr;
  const lang = c.lang === "en" ? "en" : "fr";
  const toValidator = c.kind === "to_validate" || c.kind === "to_validate_change" || c.kind === "to_direction" || c.kind === "to_opinion";
  const url = `${SITE}/app/absences.html#${toValidator ? "todo" : "mine"}`;
  const withChange = toValidator && c.absences.some((a) => !!a.change_type);
  const lines = c.absences.map((a) => line(lang, a, withChange));
  const del = c.absences[0]?.change_type === "delete";

  let subject = "", intro = "";
  const extra: string[] = [];
  switch (c.kind) {
    case "to_validate": subject = t.toValidate(c.owner, c.absences.length); extra.push(t.needAll(c.validators)); break;
    case "to_validate_change": subject = t.toValidateChange(c.owner, del); extra.push(t.needAll(c.validators)); break;
    case "to_opinion": subject = c.absences.some((a) => !!a.change_type) ? t.toOpinionChange(c.owner, c.absences[0]?.change_type === "delete") : t.toOpinion(c.owner, c.absences.length); extra.push(t.opinionNeed); break;
    case "to_direction": subject = t.toDirection(c.owner, c.absences.length); extra.push(t.directionNeed); break;
    case "direction_change": {
      const by = c.by ?? "—";
      subject = c.action === "cancelled" ? t.dirCancelled(by) : c.action === "edited" ? t.dirEdited(by) : t.dirAdded(by);
      if (c.action !== "cancelled") extra.push(t.dirNote);
      break;
    }
    case "approved": subject = c.absences.length > 1 ? t.approvedMany : t.approved; extra.push(t.approvedBy(c.approvers)); break;
    case "rejected": subject = t.rejected; extra.push(t.rejectedBy(c.by ?? "—")); extra.push(lang === "fr" ? "Le motif est consultable dans l’application." : "The reason is available in the app."); extra.push(t.delHint); break;
    case "change_approved": subject = t.changeApproved; extra.push(t.approvedBy(c.approvers)); break;
    case "change_rejected": subject = t.changeRejected; extra.push(t.rejectedBy(c.by ?? "—")); extra.push(lang === "fr" ? "Le motif est consultable dans l’application." : "The reason is available in the app."); extra.push(t.stays); break;
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

// E-mail à la gestion des absences : le formulaire PDF (déjà signé électroniquement) est en pièce jointe. Français seulement.
export type FormMail = { owner: string; roleLabel: string; absences: { kind: Abs["kind"]; start_date: string; end_date: string; note: string | null }[]; signers: { name: string; at: string }[]; direction?: { name: string; at: string } | null; file: string; action?: string };
export function buildFormEmail(c: FormMail, stamp: (iso: string) => string) {
  const lines = c.absences.map((a) => `${period(a.start_date, a.end_date)} · ${KIND.fr[a.kind]}`);
  const who = c.signers.map((s) => `${s.name} (${stamp(s.at)})`);
  const visa = c.direction ? ` Visa de la direction : ${c.direction.name} (${stamp(c.direction.at)}).` : "";
  const congres = c.absences.some((a) => a.kind === "congres");
  const label = c.action?.startsWith("cancelled") ? "Annulation d'absence" : c.action?.startsWith("modified") ? "Rectificatif d'absence" : "Demande d'absence validée";
  const subject = `${label} : ${c.owner}`;
  const intro = `${c.owner} (${c.roleLabel}) : ${c.action?.startsWith("cancelled") ? "l’absence ci-dessous est annulée dans Onconic" : c.action?.startsWith("modified") ? "ce rectificatif remplace les dates précédemment autorisées" : "la demande d’absence ci-dessous est validée dans Onconic"}. Le formulaire pré-rempli est en pièce jointe (${c.file}).`;
  const extra = [
    (who.length ? `Validation électronique : ${who.join(", ")}.` : "Validation électronique dans Onconic.") + visa,
    ...(congres ? ["La demande contient un congrès ou une formation : le formulaire ad' hoc doit être joint séparément."] : []),
    "Validation électronique simple (nom et horodatage), sans signature manuscrite ni tampon.",
  ];
  const text = [intro, "", ...lines.map((l) => `• ${l}`), "", ...extra, "", "Message automatique de The Hive Onconic."].join("\n");
  const html = `<div style="font-family:Helvetica,Arial,sans-serif;color:#1A2A4A;font-size:15px;line-height:1.5;max-width:560px">
<p style="font-size:18px;color:#001B4D;margin:0 0 12px">${esc(intro)}</p>
<ul style="padding-left:18px;margin:0 0 12px">${lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>
${extra.map((e) => `<p style="margin:0 0 8px">${esc(e)}</p>`).join("")}
<p style="font-size:12px;color:#5A6478">Message automatique de The Hive Onconic.</p></div>`;
  return { subject: `Onconic · ${subject}`, text, html };
}
