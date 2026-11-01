// Lecture de la Liste des spécialités (OFSP, export Excel en français) pour les tables sl_products et sl_limitations.
// Onglets « Données de base » et « Limitations » ; colonnes repérées par leur en-tête, pas par leur position.
// Classes ATC gardées : oncologie (L01, L02), G-CSF et interférons (L03), IMiD (L04AX), denosumab et
// bisphosphonates (M05B), antiémétiques NK1 (A04AD), antidotes et folinates (V03AF). Textes repris tels quels.
(function (root) {
  const KEEP = /^(L01|L02|L03|L04AX|M05B|A04AD|V03AF)/;
  // Formes orales : comprimé, capsule, gélule, solution ou suspension buvable, granulés, sachet…
  const ORAL = /\b(cpr|compr|comprim|caps|capsule|gel|gelule|dragee|drag|sol(ution)?\s+(orale|buv)|susp(ension)?\s+(orale|buv)|gran|granules|sachet|pastille|tabl|filmtabl|kaps|lyophilisat oral|orodisp|sirop)\b/;
  const NOT_ORAL = /\b(inj|perf|amp|flac|seringue|stylo|pdr pour sol|concentre|implant|inhal|supp|creme|gel cut|patch|collyre)\b/;

  function norm(s) {
    return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
  }

  function text(v) {
    if (v == null) return null;
    if (typeof v === "object") {
      if (v.richText) v = v.richText.map((t) => t.text).join("");
      else if (v instanceof Date) return v.toLocaleDateString("fr-CH");
      else if ("result" in v) v = v.result;
      else if ("text" in v) v = v.text;
    }
    const s = String(v).trim();
    return s === "" ? null : s;
  }

  function columns(ws, wanted, optional) {
    const head = ws.getRow(1).values.map(norm);
    const out = {};
    for (const [key, labels] of Object.entries(wanted)) {
      const list = [].concat(labels).map(norm);
      const i = head.findIndex((h) => list.includes(h));
      if (i < 1) {
        if (optional && optional.includes(key)) continue;
        throw new Error(`colonne « ${[].concat(labels)[0]} » introuvable dans l'onglet « ${ws.name} »`);
      }
      out[key] = i;
    }
    return out;
  }

  function sheet(wb, names) {
    const list = [].concat(names).map(norm);
    const ws = wb.worksheets.find((w) => list.includes(norm(w.name)));
    if (!ws) throw new Error(`onglet « ${[].concat(names)[0]} » introuvable (onglets présents : ${wb.worksheets.map((w) => w.name).join(", ")})`);
    return ws;
  }

  const isOral = (galenic) => { const g = norm(galenic); return ORAL.test(g) && !NOT_ORAL.test(g); };

  function parseWorkbook(wb) {
    const base = sheet(wb, ["Données de base", "Donnees de base"]);
    const cb = columns(base, {
      specialty: "Nom de spécialité", galenic: ["Forme gal./dosage", "Forme galénique/dosage"], substance: "Substances actives",
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
        limited: /^(y|oui|o|yes|1)$/.test(norm(text(row.getCell(cb.limited).value)))
      };
      if (!p.specialty || !p.substance) return;
      p.peros = isOral(p.galenic);
      const k = [p.specialty, p.galenic, p.substance].join("|");
      const prev = products.get(k);
      if (prev) prev.limited = prev.limited || p.limited; // un emballage par ligne : on regroupe
      else products.set(k, p);
    });

    const lim = sheet(wb, "Limitations");
    const cl = columns(lim, {
      specialty: "Nom de spécialité", galenic: ["Forme gal./dosage", "Forme galénique/dosage"], body: "Limitations",
      lim_code: "Code de limitation", ind_code: "Code d'indication", valid_from: "Valable dès", valid_to: "Limité au",
      substance: "Substances actives", atc: "Code ATC"
    }, ["galenic", "ind_code", "valid_from", "valid_to"]);
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

  const api = { parseWorkbook, isOral, KEEP };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SLParse = api;
})(this);
