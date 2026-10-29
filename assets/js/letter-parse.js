// Import des lettres types : tableur d'index (ExcelJS) + fichiers Word (mammoth), dans le navigateur.
// Le texte des lettres est repris tel quel ; seuls la mise en page et les balises sont simplifiées.
(function (root) {
  const LINES = [
    ["neoadj", "Néoadjuvant", /neo ?adjuvant/],
    ["adj", "Adjuvant", /^adjuvant/],
    ["1L", "1re ligne", /^1|premiere/],
    ["2L", "2e ligne", /^2|deuxieme/],
    ["3L", "3e ligne et plus", /^3|troisieme|ulterieure/]
  ];
  const TAGS = new Set(["P", "STRONG", "B", "EM", "I", "U", "BR", "TABLE", "THEAD", "TBODY", "TR", "TD", "TH",
    "UL", "OL", "LI", "H1", "H2", "H3", "H4", "SUP", "SUB"]);

  const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
  const nfc = (s) => String(s || "").normalize("NFC").trim();

  function text(v) {
    if (v == null) return null;
    if (typeof v === "object") {
      if (v.richText) v = v.richText.map((t) => t.text).join("");
      else if ("result" in v) v = v.result;
      else if ("text" in v) v = v.text;
    }
    const s = String(v).trim();
    return s === "" ? null : s;
  }

  // Liste blanche de balises, sans aucun attribut : rien d'exécutable ne peut passer
  function sanitize(html) {
    const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
    const out = doc.createElement("div");
    (function copy(src, dst) {
      for (const n of src.childNodes) {
        if (n.nodeType === 3) dst.append(n.textContent);
        else if (n.nodeType === 1) {
          if (TAGS.has(n.tagName)) copy(n, dst.appendChild(doc.createElement(n.tagName)));
          else if (!/^(SCRIPT|STYLE|IFRAME|OBJECT)$/.test(n.tagName)) copy(n, dst);
        }
      }
    })(doc.body, out);
    return out.innerHTML;
  }

  function lineCodes(value) {
    return String(value || "").split(/[;,\n]/).map(norm).filter(Boolean).map((v) => {
      const hit = LINES.find(([, , re]) => re.test(v));
      if (!hit) throw new Error(`ligne inconnue « ${v} »`);
      return hit[0];
    });
  }

  function route(posology) {
    const t = norm(posology);
    if (/sous-cutan|\bsc\b/.test(t)) return "SC";
    if (/voie orale|per os|\bpo\b|comprime|gelule|capsule|par jour|\/j\b/.test(t)) return "PO";
    return "IV";
  }

  // Tableau « Médicament demandé » : substance + posologie | nom commercial + firme | code d'indication
  function drugs(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const table = [...doc.querySelectorAll("table")].find((t) => /code d.indication/i.test(norm(t.textContent)));
    if (!table) return [];
    return [...table.querySelectorAll("tr")].slice(1).map((tr) => {
      const cells = [...tr.children].map((td) => [...td.querySelectorAll("p")].map((p) => p.textContent.trim()).filter(Boolean));
      if (!cells[0] || !cells[0].length) return null;
      const code = (cells[2] || []).join(" ");
      return {
        substance: cells[0][0],
        posology: cells[0].slice(1).join(" "),
        brand: (cells[1] || [])[0] || "",
        company: (cells[1] || [])[1] || "",
        code,
        offLabel: /71a/i.test(code),
        route: route(cells[0].slice(1).join(" "))
      };
    }).filter(Boolean);
  }

  function firstLine(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const p = doc.querySelector("p");
    return p ? p.textContent.trim() : "";
  }

  // Colonnes repérées par leur en-tête
  const COLUMNS = { file: "fichier", title: "titre", clinic: "clinique", diagnosis: "diagnostic",
    markers: "drivers / marqueurs", lines: "lignes", trial: "etude de reference", keywords: "mots-cles", note: "remarque" };

  function readIndex(wb) {
    const ws = wb.worksheets[0];
    const head = ws.getRow(1).values.map((v) => norm(text(v)));
    const col = {};
    for (const [k, label] of Object.entries(COLUMNS)) {
      const i = head.indexOf(label);
      if (i < 1 && k !== "title" && k !== "note") throw new Error(`colonne « ${label} » introuvable`);
      col[k] = i;
    }
    const rows = [];
    ws.eachRow((row, i) => {
      if (i === 1) return;
      const r = {};
      for (const [k, c] of Object.entries(col)) r[k] = c > 0 ? text(row.getCell(c).value) : null;
      if (r.file) rows.push(Object.assign(r, { line: i }));
    });
    return rows;
  }

  function base64(buf) {
    const bytes = new Uint8Array(buf);
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  // files : FileList des .docx ; renvoie les lignes prêtes pour letters_replace et la liste des problèmes
  async function build(wb, files, mammoth) {
    const index = readIndex(wb);
    const byName = new Map([...files].filter((f) => /\.docx$/i.test(f.name)).map((f) => [nfc(f.name), f]));
    const rows = [], errors = [], warnings = [];
    for (const r of index) {
      const name = nfc(r.file);
      const f = byName.get(name) || byName.get(name + ".docx");
      if (!f) { errors.push(`ligne ${r.line} : fichier « ${r.file} » absent`); continue; }
      byName.delete(nfc(f.name));
      let lines;
      try { lines = lineCodes(r.lines); } catch (e) { errors.push(`ligne ${r.line} : ${e.message}`); continue; }
      const buf = await f.arrayBuffer();
      const { value } = await mammoth.convertToHtml({ arrayBuffer: buf });
      const html = sanitize(value);
      const d = drugs(html);
      if (!d.length) warnings.push(`${r.file} : tableau des médicaments non reconnu`);
      if (/\[[^\]]{3,}\]/.test(html)) warnings.push(`${r.file} : contient une zone entre crochets`);
      rows.push({
        position: rows.length + 1, file: nfc(f.name), title: r.title || firstLine(html) || f.name.replace(/\.docx$/i, ""),
        clinic: r.clinic, diagnosis: r.diagnosis, markers: r.markers, lines, trial: r.trial,
        keywords: r.keywords, note: r.note, drugs: d, html, docx: base64(buf)
      });
    }
    for (const name of byName.keys()) warnings.push(`${name} : fichier Word absent du tableur, ignoré`);
    return { rows, errors, warnings };
  }

  root.LetterParse = { build, sanitize, LINES: LINES.map(([id, label]) => [id, label]) };
})(this);
