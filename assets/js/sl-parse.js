// Lecture de la Liste des spécialités (OFSP, classeur ExcelJS) pour les tables sl_products et sl_limitations.
// Seules l'oncologie (ATC L01, L02) et les G-CSF (L03AA) sont gardées. Les textes sont repris tels quels.
(function (root) {
  const KEEP = /^(L01|L02|L03AA)/;

  function norm(s) {
    return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
  }

  function text(v) {
    if (v == null) return null;
    if (typeof v === "object") {
      if (v.richText) v = v.richText.map((t) => t.text).join("");
      else if ("result" in v) v = v.result;
      else if ("text" in v) v = v.text;
      else if (v instanceof Date) return v.toLocaleDateString("fr-CH");
    }
    const s = String(v).trim();
    return s === "" ? null : s;
  }

  // Colonnes repérées par leur en-tête, pas par leur position
  function columns(ws, wanted) {
    const head = ws.getRow(1).values.map(norm);
    const out = {};
    for (const [key, label] of Object.entries(wanted)) {
      const i = head.indexOf(norm(label));
      if (i < 1) throw new Error(`colonne « ${label} » introuvable dans l'onglet « ${ws.name} »`);
      out[key] = i;
    }
    return out;
  }

  function sheet(wb, name) {
    const ws = wb.worksheets.find((w) => norm(w.name) === norm(name));
    if (!ws) throw new Error(`onglet « ${name} » introuvable`);
    return ws;
  }

  function parseWorkbook(wb) {
    const base = sheet(wb, "Données de base");
    const cb = columns(base, {
      specialty: "Nom de spécialité", galenic: "Forme gal./dosage", substance: "Substances actives",
      atc: "Code ATC", limited: "Limitation (y/n)"
    });
    const products = new Map();
    base.eachRow((row, i) => {
      if (i === 1) return;
      const atc = text(row.getCell(cb.atc).value) || "";
      if (!KEEP.test(atc)) return;
      const p = {
        specialty: text(row.getCell(cb.specialty).value),
        galenic: text(row.getCell(cb.galenic).value),
        substance: text(row.getCell(cb.substance).value),
        atc,
        limited: norm(text(row.getCell(cb.limited).value)) === "y"
      };
      if (!p.specialty || !p.substance) return;
      const k = [p.specialty, p.galenic, p.substance].join("|");
      const prev = products.get(k);
      if (prev) prev.limited = prev.limited || p.limited; // un emballage par ligne : on regroupe
      else products.set(k, p);
    });

    const lim = sheet(wb, "Limitations");
    const cl = columns(lim, {
      specialty: "Nom de spécialité", galenic: "Forme gal./dosage", body: "Limitations", lim_code: "Code de limitation",
      ind_code: "Code d'indication", valid_from: "Valable dès", valid_to: "Limité au",
      substance: "Substances actives", atc: "Code ATC"
    });
    const limits = new Map();
    lim.eachRow((row, i) => {
      if (i === 1) return;
      const atc = text(row.getCell(cl.atc).value) || "";
      if (!KEEP.test(atc)) return;
      const r = {};
      for (const k of Object.keys(cl)) r[k] = text(row.getCell(cl[k]).value);
      if (!r.specialty || !r.lim_code || !r.substance) return;
      // Même limitation répétée pour chaque emballage : une ligne, avec la liste des formes concernées
      const k = r.specialty + "|" + r.lim_code;
      const prev = limits.get(k);
      const g = r.galenic;
      delete r.galenic;
      if (!prev) limits.set(k, Object.assign(r, { galenics: g ? [g] : [] }));
      else if (g && !prev.galenics.includes(g)) prev.galenics.push(g);
    });
    const rows = [...limits.values()].map((r) => Object.assign(r, { galenics: r.galenics.join(" ; ") }));
    return { products: [...products.values()], limits: rows };
  }

  const api = { parseWorkbook };
  if (typeof module !== "undefined") module.exports = api;
  else root.SLParse = api;
})(this);
