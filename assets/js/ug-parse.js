// Lecture du fichier Excel Ultragenda (classeur ExcelJS) en lignes pour la table ug_slots.
// Les valeurs sont reprises telles quelles : aucune correction des données.
(function (root) {
  const SKIP = /^des chiffres/i;

  function norm(s) {
    return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
  }

  function text(v) {
    if (v == null) return null;
    if (typeof v === "object") {
      if (v.richText) v = v.richText.map((t) => t.text).join("");
      else if ("result" in v) v = v.result;
      else if ("text" in v) v = v.text;
      else if (v instanceof Date) return v.toISOString();
    }
    const s = String(v).trim();
    return s === "" ? null : s;
  }

  // Colonnes repérées par leur en-tête, pas par leur position
  const COLUMNS = {
    name: "nom clean",
    codes: "code du plan",
    synonyms: "synonymes",
    note: "note interpro",
    ug_label: "etiquette ug",
    minutes: "temps en minutes"
  };

  function clinicNames(wb) {
    const map = {};
    wb.eachSheet((ws) => {
      if (!SKIP.test(ws.name)) return;
      ws.eachRow((row) => {
        const letter = text(row.getCell(1).value);
        const name = text(row.getCell(2).value);
        if (letter && name && /^[A-Z]$/.test(letter)) map[letter] = name;
      });
    });
    return map;
  }

  function parseWorkbook(wb) {
    const names = clinicNames(wb);
    const rows = [];
    const errors = [];
    wb.eachSheet((ws) => {
      if (SKIP.test(ws.name)) return;
      const header = {};
      ws.getRow(1).eachCell((cell, col) => {
        const h = norm(text(cell.value));
        for (const [key, prefix] of Object.entries(COLUMNS)) if (h.startsWith(prefix)) header[key] = col;
      });
      if (!header.name || !header.minutes) {
        errors.push(`Onglet « ${ws.name} » : colonnes « Nom » ou « temps en minutes » introuvables`);
        return;
      }
      const m = ws.name.trim().match(/\s([A-Z](?:\+[A-Z])*)$/);
      const letter = m ? m[1] : null;
      const clinicName = letter ? (names[letter[0]] || ws.name) : ws.name.trim();
      ws.eachRow((row, i) => {
        if (i === 1) return;
        const get = (k) => (header[k] ? text(row.getCell(header[k]).value) : null);
        // Nom vide mais ligne renseignée (ex. dénosumab) : on affiche les synonymes à la place
        const name = get("name") || get("synonyms");
        if (!name) return;
        const minutes = Number(get("minutes"));
        if (!Number.isFinite(minutes)) {
          errors.push(`Onglet « ${ws.name} », ligne ${i} : durée non numérique`);
          return;
        }
        rows.push({
          position: rows.length + 1,
          clinic_sheet: ws.name.trim(),
          clinic_letter: letter,
          clinic_name: clinicName,
          name,
          codes: get("codes"),
          synonyms: get("synonyms"),
          note: get("note"),
          ug_label: get("ug_label"),
          minutes: Math.round(minutes)
        });
      });
    });
    return { rows, errors };
  }

  root.UGParse = { parseWorkbook };
})(typeof window !== "undefined" ? window : globalThis);
