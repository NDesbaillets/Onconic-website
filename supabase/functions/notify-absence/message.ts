// Messages des absences (e-mail et push). Fonctions pures, testables hors Supabase.
export type Lang = "fr" | "en";
export type Kind = "to_validate" | "to_validate_change" | "approved" | "rejected" | "change_approved" | "change_rejected" | "to_direction" | "direction_change" | "to_opinion" | "peer_rejected" | "on_behalf" | "agenda_done" | "escalated";

export type Abs = {
  id: number; kind: "vacances" | "congres" | "autre"; start_date: string; end_date: string; note: string | null;
  change_type: "modify" | "delete" | null; change_kind: string | null; change_note: string | null;
  change_start: string | null; change_end: string | null;
  // Numéro de demande AAAA-NNNN, lu en base à l'envoi (jamais copié dans le payload)
  request_no?: string | null;
};
export type Ctx = {
  lang: Lang; kind: Kind; owner: string; by?: string | null; comment?: string | null; reminder?: boolean; action?: string | null; stepLabel?: string | null; secretary?: boolean; periods?: { start: string; end: string }[];
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
    toOpinionStep: (who: string, n: number, step: string) => `${who} demande ${n > 1 ? `${n} absences` : "une absence"} : Avis demandé : ${step}`,
    toOpinionStepChange: (who: string, del: boolean, step: string) => `${who} demande ${del ? "la suppression" : "la modification"} d'une absence validée : Avis demandé : ${step}`,
    opinionStepNeed: (step: string) => `Avis demandé : ${step}. Étape consultative, sans effet bloquant : votre avis (favorable ou non, avec un commentaire) s'affiche avec la demande comme aide à la décision.`,
    peerRejected: (by: string, who: string, step: string) => `${by} a refusé la demande d'absence de ${who}${step ? ` (${step})` : ""}`,
    peerRejectedSubject: (who: string) => `Absence refusée : ${who}`,
    peerRejectedNote: "Vous n'avez plus de décision à prendre sur cette demande. Le motif est consultable dans l'application.",
    dirAdded: (by: string) => `${by} a ajouté une absence à votre nom`,
    dirEdited: (by: string) => `${by} a modifié votre absence`,
    dirCancelled: (by: string) => `${by} a annulé votre absence`,
    onBehalf: (by: string, action: string) => `${by} a demandé ${action === "delete" ? "la suppression d'une absence validée" : action === "modify" ? "la modification d'une absence validée" : "une absence"} en votre nom`,
    onBehalfNote: "La demande suit le circuit de validation habituel ; vous êtes prévenu·e de la décision.",
    secApproved: (o: string) => `L'absence de ${o} est validée`,
    secRejected: (o: string) => `La demande d'absence de ${o} a été refusée`,
    secChangeApproved: (o: string) => `La demande de changement de ${o} est acceptée`,
    secChangeRejected: (o: string) => `La demande de changement de ${o} a été refusée`,
    agendaBlocked: (p: string[]) => p.length > 1 ? `Vos absences (${p.join(" ; ")}) sont bloquées dans Ultragenda` : `Votre absence du ${p[0]} est bloquée dans Ultragenda`,
    agendaUnblocked: (p: string[]) => p.length > 1 ? `Vos absences (${p.join(" ; ")}) sont débloquées dans Ultragenda` : `Votre absence du ${p[0]} est débloquée dans Ultragenda`,
    agendaBy: (by: string) => `Fait par ${by}.`,
    escalated: (step: string) => `Votre demande d'absence a reçu le visa de la direction et a été envoyée à la cheffe de service pour signature${step ? ` (${step})` : ""}`,
    escalatedNote: "Vous serez prévenu·e de la décision finale. L'avancement est consultable dans l'application.",
    dirNote: "La direction l'a enregistrée ou modifiée directement : elle est validée.",
    approved: "Votre absence est validée",
    approvedMany: "Votre demande d'absence est validée",
    rejected: "Votre demande d'absence a été refusée",
    changeApproved: "Votre demande de changement est acceptée",
    changeRejected: "Votre demande de changement a été refusée",
    needAll: (names: string[]) => `Chaque absence doit être validée par tous les validateurs concernés${names.length ? ` : ${names.slice(0, 10).join(", ")}${names.length > 10 ? ` et ${names.length - 10} autre${names.length - 10 > 1 ? "s" : ""}` : ""}` : ""}.`,
    approvedBy: (names: string[]) => (names.length ? `Validée par : ${names.join(", ")}.` : "Validée."),
    rejectedBy: (by: string) => `Refusée par ${by}.`,
    stays: "L'absence reste validée aux dates actuelles.",
    comment: (c: string) => `Commentaire : « ${c} »`,
    open: "Ouvrir Absences",
    delHint: "Vous pouvez modifier cette demande puis la renvoyer, ou l'archiver ; elle reste consultable dans l'historique.",
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
    toOpinionStep: (who: string, n: number, step: string) => `${who} requests ${n > 1 ? `${n} absences` : "an absence"}: Opinion requested: ${step}`,
    toOpinionStepChange: (who: string, del: boolean, step: string) => `${who} asks to ${del ? "delete" : "change"} an approved absence: Opinion requested: ${step}`,
    opinionStepNeed: (step: string) => `Opinion requested: ${step}. Non-blocking step: your opinion (favourable or not, with a comment) is shown with the request as decision support.`,
    peerRejected: (by: string, who: string, step: string) => `${by} declined the absence request of ${who}${step ? ` (${step})` : ""}`,
    peerRejectedSubject: (who: string) => `Absence declined: ${who}`,
    peerRejectedNote: "No further decision is needed from you on this request. The reason is available in the app.",
    dirAdded: (by: string) => `${by} added an absence in your name`,
    dirEdited: (by: string) => `${by} changed your absence`,
    dirCancelled: (by: string) => `${by} cancelled your absence`,
    onBehalf: (by: string, action: string) => `${by} requested ${action === "delete" ? "the deletion of an approved absence" : action === "modify" ? "a change to an approved absence" : "an absence"} in your name`,
    onBehalfNote: "The request follows the usual approval chain; you will be told of the decision.",
    secApproved: (o: string) => `${o}'s absence is approved`,
    secRejected: (o: string) => `${o}'s absence request was declined`,
    secChangeApproved: (o: string) => `${o}'s change request was accepted`,
    secChangeRejected: (o: string) => `${o}'s change request was declined`,
    agendaBlocked: (p: string[]) => p.length > 1 ? `Your absences (${p.join("; ")}) are blocked in Ultragenda` : `Your absence from ${p[0]} is blocked in Ultragenda`,
    agendaUnblocked: (p: string[]) => p.length > 1 ? `Your absences (${p.join("; ")}) are unblocked in Ultragenda` : `Your absence from ${p[0]} is unblocked in Ultragenda`,
    agendaBy: (by: string) => `Done by ${by}.`,
    escalated: (step: string) => `Your absence request received the management visa and was sent to the head of department for signature${step ? ` (${step})` : ""}`,
    escalatedNote: "You will be notified of the final decision. Progress is available in the app.",
    dirNote: "Management entered or changed it directly: it is approved.",
    approved: "Your absence is approved",
    approvedMany: "Your absence request is approved",
    rejected: "Your absence request was declined",
    changeApproved: "Your change request was accepted",
    changeRejected: "Your change request was declined",
    needAll: (names: string[]) => `Each absence must be approved by all validators concerned${names.length ? `: ${names.slice(0, 10).join(", ")}${names.length > 10 ? ` and ${names.length - 10} more` : ""}` : ""}.`,
    approvedBy: (names: string[]) => (names.length ? `Approved by: ${names.join(", ")}.` : "Approved."),
    rejectedBy: (by: string) => `Declined by ${by}.`,
    stays: "The absence stays approved on its current dates.",
    comment: (c: string) => `Comment: “${c}”`,
    open: "Open Absences",
    delHint: "You can change this request and send it again, or archive it; it stays available in the history.",
    sent: "Automatic message from The Hive Onconic.",
    remind: "Reminder",
    remindText: "This is a reminder: your decision is still pending.",
    note: "Note",
    wasChange: "becomes",
    deletion: "deletion requested",
  },
};

function line(l: Lang, a: Abs, withChange: boolean, numbered = false): string {
  const t = T[l];
  // Plusieurs demandes dans le même message : « N° 2026-0012 : vacances du … au … » ; sinon le numéro figure dans l'objet
  let s = numbered && a.request_no
    ? (l === "fr" ? `N° ${a.request_no} : ${KIND.fr[a.kind]} du ${eu(a.start_date)} au ${eu(a.end_date)}` : `No. ${a.request_no}: ${KIND.en[a.kind]} from ${eu(a.start_date)} to ${eu(a.end_date)}`)
    : `${period(a.start_date, a.end_date)} · ${KIND[l][a.kind]}`;
  // Les précisions et commentaires se consultent uniquement dans l’application authentifiée.
  if (withChange && a.change_type === "delete") s += ` · ${t.deletion}`;
  if (withChange && a.change_type === "modify" && a.change_start && a.change_end) {
    s += ` → ${t.wasChange} ${period(a.change_start, a.change_end)}${a.change_kind ? " · " + (KIND[l][a.change_kind as keyof typeof KIND.fr] ?? a.change_kind) : ""}`;
  }
  return s;
}

// « [2026-0012] » dans l'objet quand le message concerne une seule demande numérotée
const numberTag = (list: { request_no?: string | null }[]) => (list.length === 1 && list[0].request_no ? `[${list[0].request_no}] ` : "");

export function buildEmail(c: Ctx) {
  const t = T[c.lang] ?? T.fr;
  const lang = c.lang === "en" ? "en" : "fr";
  const toValidator = c.kind === "to_validate" || c.kind === "to_validate_change" || c.kind === "to_direction" || c.kind === "to_opinion" || c.kind === "peer_rejected";
  const url = `${SITE}/app/absences.html#${toValidator ? "todo" : "mine"}`;
  const withChange = toValidator && c.absences.some((a) => !!a.change_type);
  const lines = c.absences.map((a) => line(lang, a, withChange, c.absences.length > 1));
  const del = c.absences[0]?.change_type === "delete";

  let subject = "", intro = "";
  const extra: string[] = [];
  switch (c.kind) {
    case "to_validate": subject = t.toValidate(c.owner, c.absences.length); extra.push(t.needAll(c.validators)); break;
    case "to_validate_change": subject = t.toValidateChange(c.owner, del); extra.push(t.needAll(c.validators)); break;
    case "to_opinion": {
      const step = (c.stepLabel ?? "").trim();
      const chg = c.absences.some((a) => !!a.change_type);
      if (step) { subject = chg ? t.toOpinionStepChange(c.owner, c.absences[0]?.change_type === "delete", step) : t.toOpinionStep(c.owner, c.absences.length, step); extra.push(t.opinionStepNeed(step)); }
      else { subject = chg ? t.toOpinionChange(c.owner, c.absences[0]?.change_type === "delete") : t.toOpinion(c.owner, c.absences.length); extra.push(t.opinionNeed); }
      break;
    }
    case "peer_rejected": subject = t.peerRejectedSubject(c.owner); intro = t.peerRejected(c.by ?? "—", c.owner, (c.stepLabel ?? "").trim()) + "."; extra.push(t.peerRejectedNote); break;
    case "to_direction": subject = t.toDirection(c.owner, c.absences.length); extra.push(t.directionNeed); break;
    case "direction_change": {
      const by = c.by ?? "—";
      subject = c.action === "cancelled" ? t.dirCancelled(by) : c.action === "edited" ? t.dirEdited(by) : t.dirAdded(by);
      if (c.action !== "cancelled") extra.push(t.dirNote);
      break;
    }
    case "escalated": subject = t.escalated((c.stepLabel ?? "").trim()); extra.push(t.escalatedNote); break;
    case "on_behalf": subject = t.onBehalf(c.by ?? "—", c.action ?? "request"); extra.push(t.onBehalfNote); break;
    case "agenda_done": {
      const ps = (c.periods?.length ? c.periods : c.absences.map((a) => ({ start: a.start_date, end: a.end_date }))).map((p) => (lang === "fr" ? period(p.start, p.end) : period(p.start, p.end)));
      const fr = lang === "fr";
      const list = fr ? ps.map((p) => p.replace(" – ", " au ")) : ps.map((p) => p.replace(" – ", " to "));
      subject = c.action === "unblocked" ? t.agendaUnblocked(list) : t.agendaBlocked(list);
      if (c.by) extra.push(t.agendaBy(c.by));
      break;
    }
    case "approved": subject = c.secretary ? t.secApproved(c.owner) : c.absences.length > 1 ? t.approvedMany : t.approved; extra.push(t.approvedBy(c.approvers)); break;
    case "rejected": subject = c.secretary ? t.secRejected(c.owner) : t.rejected; extra.push(t.rejectedBy(c.by ?? "—")); extra.push(lang === "fr" ? "Le motif est consultable dans l’application." : "The reason is available in the app."); extra.push(t.delHint); break;
    case "change_approved": subject = c.secretary ? t.secChangeApproved(c.owner) : t.changeApproved; extra.push(t.approvedBy(c.approvers)); break;
    case "change_rejected": subject = c.secretary ? t.secChangeRejected(c.owner) : t.changeRejected; extra.push(t.rejectedBy(c.by ?? "—")); extra.push(lang === "fr" ? "Le motif est consultable dans l’application." : "The reason is available in the app."); extra.push(t.stays); break;
  }
  if (c.reminder && toValidator) { subject = `${t.remind}${lang === "fr" ? " : " : ": "}${subject}`; extra.unshift(t.remindText); }
  intro = intro || subject + ".";
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
    body: toValidator || c.kind === "agenda_done" ? subject : `${subject}${first ? " (" + period(first.start_date, first.end_date) + ")" : ""}.`,
    url: `/app/absences.html#${toValidator ? "todo" : "mine"}`,
    tag: `absence-${c.kind}-${first?.id ?? 0}`,
  };
  return { subject: `Onconic · ${numberTag(c.absences)}${subject}`, text, html, push };
}

// E-mail à la gestion des absences : le formulaire PDF (déjà signé électroniquement) est en pièce jointe. Français seulement.
export type FormMail = { owner: string; roleLabel: string; absences: { kind: Abs["kind"]; start_date: string; end_date: string; note: string | null; request_no?: string | null }[]; signers: { name: string; at: string }[]; direction?: { name: string; at: string } | null; file: string; action?: string };
export function buildFormEmail(c: FormMail, stamp: (iso: string) => string) {
  const lines = c.absences.map((a) => (c.absences.length > 1 && a.request_no ? `N° ${a.request_no} : ${KIND.fr[a.kind]} du ${eu(a.start_date)} au ${eu(a.end_date)}` : `${period(a.start_date, a.end_date)} · ${KIND.fr[a.kind]}`));
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
  return { subject: `Onconic · ${numberTag(c.absences)}${subject}`, text, html };
}

// E-mail de diffusion du PDF validé : plages à bloquer ou débloquer dans Ultragenda. Aucun texte libre ; français seulement.
export type AgendaEntry = { start: string; end: string; days?: string[] };
export type AgendaMail = { owner: string; action?: string | null; file?: string; block: AgendaEntry[]; unblock: AgendaEntry[] };
const DOW_FR = ["di", "lu", "ma", "me", "je", "ve", "sa"];
const dayLabel = (iso: string) => `${DOW_FR[new Date(`${iso}T12:00:00Z`).getUTCDay()]} ${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
const entryLine = (e: AgendaEntry) => {
  const days = e.days ?? [];
  const shown = days.slice(0, 12).map(dayLabel).join(", ");
  return `${period(e.start, e.end)} : ${days.length} jour${days.length > 1 ? "s" : ""} ouvrable${days.length > 1 ? "s" : ""}${days.length ? ` (${shown}${days.length > 12 ? ", …" : ""})` : ""}`;
};
export function buildAgendaEmail(c: AgendaMail) {
  const a = c.action ?? "approved";
  const kind = a.startsWith("cancelled") ? "cancelled" : a.startsWith("modified") ? "modified" : "approved";
  const ps = (l: AgendaEntry[]) => l.map((e) => period(e.start, e.end)).join(" ; ");
  const subject = kind === "approved" ? `Absence validée de ${c.owner} : plages Ultragenda à bloquer`
    : kind === "cancelled" ? `Absence annulée de ${c.owner} : plages Ultragenda à débloquer`
    : c.unblock.length ? `Absence modifiée de ${c.owner} : débloquer ${ps(c.unblock)} puis bloquer ${ps(c.block) || "la nouvelle période"}`
    : `Absence modifiée de ${c.owner} : nouvelle plage Ultragenda à bloquer`;
  const url = `${SITE}/app/absences.html#agenda`;
  const sections: { title: string; items: string[] }[] = [];
  if (c.unblock.length) sections.push({ title: "À débloquer dans Ultragenda", items: c.unblock.map(entryLine) });
  if (c.block.length) sections.push({ title: "À bloquer dans Ultragenda", items: c.block.map(entryLine) });
  const note = "Le formulaire en pièce jointe est identique à celui envoyé à la gestion des absences. Cochez la tâche dans Absences, onglet « Blocage Ultragenda », une fois l'agenda à jour.";
  const text = [subject + ".", "", ...sections.flatMap((s) => [s.title + " :", ...s.items.map((i) => `• ${i}`), ""]), note, "", `Ouvrir la liste : ${url}`, "", "Message automatique de The Hive Onconic."].join("\n");
  const html = `<div style="font-family:Helvetica,Arial,sans-serif;color:#1A2A4A;font-size:15px;line-height:1.5;max-width:560px">
<p style="font-size:18px;color:#001B4D;margin:0 0 12px">${esc(subject)}.</p>
${sections.map((s) => `<p style="margin:0 0 4px;font-weight:600">${esc(s.title)}</p><ul style="padding-left:18px;margin:0 0 12px">${s.items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`).join("")}
<p style="margin:0 0 8px">${esc(note)}</p>
<p style="margin:16px 0"><a href="${url}" style="display:inline-block;padding:12px 20px;background:#F0B12B;color:#001B4D;text-decoration:none;font-weight:500;border:1px solid #001B4D">Ouvrir la liste</a></p>
<p style="font-size:12px;color:#5A6478">Message automatique de The Hive Onconic.</p></div>`;
  return { subject: `Onconic · ${subject}`, text, html };
}
