// Formulaires de demande d'absence (PDF), pré-remplis et signés électroniquement (nom du validateur + horodatage).
// Reprend la trame des trois formulaires papier du département : médecin assistant, chefs de clinique, médecin cadre.
// Module pur (pas d'accès réseau ni base) : testable hors Supabase. Le logo du CHUV n'est pas dans le dépôt public :
// il est lu par l'appelant dans le bucket privé « absence-forms » (logo.png) et passé en paramètre ; à défaut, texte seul.
import { PDFDocument, PDFFont, PDFPage, rgb, StandardFonts } from "npm:pdf-lib@1.17.1";

export type FormRole = "clinician" | "cdc" | "cadre";
export type FormAbsence = { kind: "vacances" | "congres" | "autre"; start_date: string; end_date: string; note: string | null };
export type FormSigner = { name: string; at: string; comment?: string | null };
export type FormData = {
  role: FormRole; owner: string; clinics: string[]; requestedAt: string; absences: FormAbsence[]; signers: FormSigner[];
  generatedAt: string; ref: string;
};

const TITLE: Record<FormRole, string> = {
  clinician: "DEMANDE D’ABSENCE – Médecin assistant",
  cdc: "DEMANDE D’ABSENCE – Chefs de clinique",
  cadre: "DEMANDE D’ABSENCE – Médecin Cadre",
};
export const FILE_LABEL: Record<FormRole, string> = { clinician: "Medecin-assistant", cdc: "Chef-de-clinique", cadre: "Medecin-cadre" };
const KIND_FR = { vacances: "Vacances", congres: "Congrès / formation", autre: "Autre" } as const;
const FOOT_COMMON = "Attention pour toutes demandes de congé/remboursement formation et congrès le formulaire ad’ hoc doit être également rempli";

const eu = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
export const period = (a: string, b: string) => (!b || a === b ? eu(a) : `du ${eu(a)} au ${eu(b)}`);
/** JJ.MM.AAAA HH:MM à l'heure de Zurich */
export function stamp(iso: string): string {
  const p = new Intl.DateTimeFormat("fr-CH", { timeZone: "Europe/Zurich", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(iso)).reduce((o, x) => (o[x.type] = x.value, o), {} as Record<string, string>);
  return `${p.day}.${p.month}.${p.year} ${p.hour}:${p.minute}`;
}
export const day = (iso: string) => stamp(iso).slice(0, 10);

// Les polices standard du PDF ne couvrent que le jeu Windows-1252 : on remplace le reste par « ? » au lieu de planter
const CP1252_EXTRA = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";
export function safe(s: string): string {
  return Array.from(String(s ?? "").replace(/\s+/g, " ")).map((c) => {
    const n = c.codePointAt(0)!;
    return (n >= 32 && n <= 126) || (n >= 160 && n <= 255) || CP1252_EXTRA.includes(c) ? c : "?";
  }).join("");
}

const NAVY = rgb(0, 0, 0), GREY = rgb(0.35, 0.35, 0.35), SIGN = rgb(0, 0.11, 0.3);
const W = 595.28, H = 841.89, ML = 56, MR = 56, CW = W - ML - MR;

export async function buildAbsenceForm(d: FormData, logo?: Uint8Array | null): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`${TITLE[d.role]} – ${safe(d.owner)}`);
  pdf.setProducer("Onconic");
  pdf.setCreator("Onconic");
  const reg = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ital = await pdf.embedFont(StandardFonts.HelveticaOblique);
  let page: PDFPage = pdf.addPage([W, H]);
  let y = H - 40; // curseur depuis le haut de la page

  const wrap = (t: string, f: PDFFont, size: number, width: number): string[] => {
    const out: string[] = []; let line = "";
    for (const w of safe(t).split(" ")) {
      const test = line ? `${line} ${w}` : w;
      if (f.widthOfTextAtSize(test, size) > width && line) { out.push(line); line = w; } else line = test;
    }
    if (line) out.push(line);
    return out.length ? out : [""];
  };
  const need = (h: number) => { if (y - h < 60) { page = pdf.addPage([W, H]); y = H - 50; } };
  const text = (t: string, x: number, f: PDFFont = reg, size = 10, color = NAVY) => page.drawText(safe(t), { x, y: y - size, size, font: f, color });
  const para = (t: string, x: number, width: number, f: PDFFont = reg, size = 10, color = NAVY, gap = 3) => {
    for (const l of wrap(t, f, size, width)) { need(size + gap); text(l, x, f, size, color); y -= size + gap; }
  };
  const box = (x: number, top: number, on: boolean) => {
    page.drawRectangle({ x, y: top - 9, width: 9, height: 9, borderColor: NAVY, borderWidth: 0.8 });
    if (on) {
      page.drawLine({ start: { x: x + 1.5, y: top - 7.5 }, end: { x: x + 7.5, y: top - 1.5 }, thickness: 1.2, color: SIGN });
      page.drawLine({ start: { x: x + 1.5, y: top - 1.5 }, end: { x: x + 7.5, y: top - 7.5 }, thickness: 1.2, color: SIGN });
    }
  };
  const dots = () => { need(16); text(".".repeat(98), ML, reg, 9, GREY); y -= 16; };
  const rule2 = () => { need(14); page.drawLine({ start: { x: ML, y: y - 3 }, end: { x: W - MR, y: y - 3 }, thickness: 1.4, color: NAVY });
    page.drawLine({ start: { x: ML, y: y - 7 }, end: { x: W - MR, y: y - 7 }, thickness: 1.4, color: NAVY }); y -= 18; };

  // En-tête : logo (facultatif) puis adresse du département
  let hdrX = ML;
  if (logo?.length) {
    try {
      const img = await pdf.embedPng(logo); const s = 34 / img.height;
      page.drawImage(img, { x: ML, y: y - 34, width: img.width * s, height: 34 }); hdrX = ML + img.width * s + 12;
    } catch (_) { hdrX = ML; }
  }
  const hdr = ["Département d’oncologie", "Bâtiment hospitalier", "Rue du Bugnon 46", "CH-1011 Lausanne"];
  hdr.forEach((l, i) => page.drawText(safe(l), { x: hdrX, y: y - 9 - i * 9.5, size: i ? 7.5 : 8.5, font: i ? reg : bold, color: NAVY }));
  y -= 52;

  // Titre dans un cadre à double filet
  page.drawRectangle({ x: ML, y: y - 50, width: CW, height: 50, borderColor: NAVY, borderWidth: 1.6 });
  page.drawRectangle({ x: ML + 4, y: y - 46, width: CW - 8, height: 42, borderColor: NAVY, borderWidth: 0.8 });
  const t = TITLE[d.role]; const ts = 15;
  page.drawText(safe(t), { x: ML + (CW - bold.widthOfTextAtSize(safe(t), ts)) / 2, y: y - 31, size: ts, font: bold, color: NAVY });
  y -= 70;

  // Date et identité
  const dl = `Date : ${day(d.requestedAt)}`;
  text(dl, W - MR - reg.widthOfTextAtSize(dl, 10) - 10, reg, 10); y -= 22;
  text("NOM : ", ML, bold, 10); text(d.owner, ML + bold.widthOfTextAtSize("NOM : ", 10), reg, 10); y -= 17;
  const cl = d.role === "cdc" ? "CLINIQUES : " : "CLINIQUE : ";
  text(cl, ML, bold, 10); para(d.clinics.length ? d.clinics.join(", ") : "—", ML + bold.widthOfTextAtSize(cl, 10), CW - 70, reg, 10); y -= 8;

  // Dates et type d'absence
  const heading = d.role === "cadre" ? "DATES DE CONGÉS DÉSIRÉS ET MOTIFS :" : "DATES et type d’absence (vacances, formation, mariage, enfant .... etc.) :";
  text(heading, ML, bold, 10); y -= 17;
  const abs = [...d.absences].sort((a, b) => a.start_date.localeCompare(b.start_date));
  abs.forEach((a, i) => {
    const lead = d.role === "cadre" ? `${i + 1}.` : "•";
    const body = `${period(a.start_date, a.end_date)} : ${KIND_FR[a.kind]}${a.note ? ` (${a.note})` : ""}`;
    need(14); text(lead, ML + 12, reg, 10); para(body, ML + 28, CW - 34);
  });
  if (d.role === "cdc") { y -= 6; text("Congés à annuler :", ML, bold, 10); y -= 16; text("•", ML + 12, reg, 10); y -= 20; }
  y -= 10;

  const signers = d.signers;
  const optionRow = (label: string, who: FormSigner | null, favourable: boolean) => {
    need(40);
    text(label, ML, bold, 10);
    let x = ML + bold.widthOfTextAtSize(label, 10) + 8;
    text("Favorable", x, reg, 10); x += reg.widthOfTextAtSize("Favorable", 10) + 6; box(x, y - 1, favourable && !!who); x += 28;
    text("Défavorable", x, reg, 10); x += reg.widthOfTextAtSize("Défavorable", 10) + 6; box(x, y - 1, false); x += 30;
    if (who) {
      const sig = `Signé électroniquement : ${who.name}`;
      page.drawText(safe(sig), { x: Math.max(x, ML + 270), y: y - 9, size: 8.5, font: bold, color: SIGN });
      page.drawText(safe(stamp(who.at)), { x: Math.max(x, ML + 270), y: y - 19, size: 8, font: reg, color: SIGN });
    } else page.drawText("Tampon - signature", { x: ML + 380, y: y - 9, size: 7.5, font: reg, color: GREY });
    y -= 30;
  };
  const comments = () => {
    text("Commentaires : ", ML, bold, 10);
    text(".".repeat(80), ML + bold.widthOfTextAtSize("Commentaires : ", 10), reg, 9, GREY); y -= 18;
  };
  const approvals = () => {
    const rows = signers.length ? signers : [null, null, null] as (FormSigner | null)[];
    rows.forEach((s) => optionRow("Avis : ", s, true));
    const withComments = signers.filter((s) => s.comment);
    if (withComments.length) {
      text("Commentaires : ", ML, bold, 10); y -= 14;
      withComments.forEach((s) => para(`${s.name} : « ${s.comment} »`, ML + 12, CW - 14, ital, 9));
    } else comments();
  };

  if (d.role === "clinician") {
    text("PRÉ-AVIS DES CHEFS DE CLINIQUE :", ML, bold, 10); y -= 20;
    for (let i = 0; i < 3; i++) optionRow("Avis : ", null, false);
    comments(); y -= 4; rule2();
    text("AVIS DU MÉDECIN CADRE RESPONSABLE DE LA CLINIQUE", ML, bold, 10); y -= 20;
    approvals(); y -= 4;
  } else if (d.role === "cdc") {
    text("PRÉ-AVIS DU MÉDECIN CADRE RESPONSABLE DE LA CLINIQUE", ML, bold, 10); y -= 20;
    approvals(); y -= 4; rule2();
    text("AVIS DU CHEF DE SERVICE :", ML, bold, 10); text("Tampon et signature.", ML + 230, reg, 10); y -= 22;
    need(24); text("Demande acceptée :", ML, reg, 10); let x = ML + reg.widthOfTextAtSize("Demande acceptée :", 10) + 14;
    text("oui", x, reg, 10); box(x + 20, y - 1, false); text("non", x + 55, reg, 10); box(x + 76, y - 1, false); y -= 24;
    comments();
  } else {
    if (signers.length) {
      text("VALIDATION EN LIGNE PRÉALABLE (Onconic)", ML, bold, 10); y -= 16;
      signers.forEach((s) => para(`${s.name} : favorable, signé électroniquement le ${stamp(s.at)}${s.comment ? ` · « ${s.comment} »` : ""}`, ML + 12, CW - 14, reg, 9, SIGN));
      y -= 8;
    }
    text("AVIS DU CHEF DE SERVICE :", ML, bold, 10); text("Tampon et signature.", ML + 230, reg, 10); y -= 22;
    need(24); text("Demande acceptée :", ML, reg, 10); const x = ML + reg.widthOfTextAtSize("Demande acceptée :", 10) + 14;
    text("oui", x, reg, 10); box(x + 20, y - 1, false); text("non", x + 55, reg, 10); box(x + 76, y - 1, false); y -= 24;
    comments(); dots();
  }

  y -= 6;
  if (d.role === "clinician") para(FOOT_COMMON, ML, CW, ital, 8, GREY);
  else {
    para("Décision finale validée par le chef de service et transmise par email aux médecins ci-dessus et aux gestionnaires poly point – tout changement fait l’objet d’une nouvelle demande", ML, CW, ital, 8, GREY);
    para("Attention pour toutes demandes de congé formation et congrès le formulaire ad’ hoc doit être également joint à cette demande", ML, CW, ital, 8, GREY);
  }
  if (abs.some((a) => a.kind === "congres")) para("Cette demande contient un congrès ou une formation : joindre le formulaire ad’ hoc.", ML, CW, bold, 8.5, SIGN);

  // Pied : traçabilité
  const last = pdf.getPages()[pdf.getPageCount() - 1];
  const foot = `Pré-rempli et validé électroniquement dans Onconic (onconic.ch) · Réf. ${d.ref} · généré le ${stamp(d.generatedAt)}`;
  last.drawText(safe(foot), { x: ML, y: 34, size: 7, font: reg, color: GREY });
  last.drawText("Validation électronique simple (nom et horodatage), sans signature manuscrite ni tampon.", { x: ML, y: 25, size: 7, font: reg, color: GREY });
  return await pdf.save();
}
