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

  // ----- Détection automatique des métadonnées (proposition, toujours relue par l'admin) -----
  function sections(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const ps = [...doc.body.children].map((n) => n.textContent.trim());
    const at = (re) => ps.findIndex((t) => re.test(norm(t)));
    const i = at(/^diagnostic/), j = at(/^justification/);
    return {
      dx: i >= 0 ? ps.slice(i + 1, j > i ? j : undefined).join("\n") : "",
      just: j >= 0 ? ps.slice(j + 1).join("\n") : ""
    };
  }

  const MARKERS = [
    ["EGFR T790M", /t790m/], ["EGFR ex19del", /exon 19|ex19/], ["EGFR L858R", /l858r/],
    ["EGFR exon 20", /egfr[^.]*exon 20|exon 20[^.]*egfr/], ["EGFR", /\begfr\b/],
    ["ALK", /\balk\b/], ["ROS1", /\bros1\b/], ["MET exon 14", /exon 14[^.]*met|met[^.]*exon 14/],
    ["MET amplification", /amplification[^.]*\bmet\b|\bmet\b[^.]*amplific/], ["RET", /\bret\b/],
    ["BRAF V600E", /v600e/], ["HER2 (ERBB2) muté", /her2|erbb2/], ["KRAS G12C", /g12c/], ["NTRK", /\bntrk/],
    ["PD-L1 ≥ 50 %", /pd-l1[^.]*(≥|>=|superieur[^.]*) ?50/], ["PD-L1 < 50 %", /pd-l1[^.]*< ?50/],
    ["PD-L1 ≥ 1 %", /pd-l1[^.]*(≥|>=) ?1 ?%/]
  ];
  const NEG = /\b(sans|ne presente pas|n.a pas|aucune?|absence|exclu)/;

  function guess(html, title) {
    const { dx, just } = sections(html);
    const t = norm(title), d = norm(dx), all = t + "\n" + d;
    // Diagnostic
    let diagnosis = "";
    if (/non a petites cellules|cbnpc|cpnpc|nsclc/.test(all)) diagnosis = "CBNPC";
    else if (/petites cellules|cppc|sclc/.test(all)) diagnosis = "CPPC";
    if (diagnosis === "CBNPC") {
      if (/non[ -]?epiderm|pas a predominance epiderm/.test(all)) diagnosis += " non épidermoïde";
      else if (/epiderm/.test(all)) diagnosis += " épidermoïde";
    }
    // Marqueurs : phrase par phrase, en écartant les mentions négatives
    const markers = [];
    let negEgfrAlk = false;
    // Découpage en propositions : une négation ne s'étend pas à la proposition suivante
    for (const sentence of all.split(/[.\n;]|, (?=sans|aucun)| et (?=presente|exprime|dont)/)) {
      const neg = NEG.test(sentence);
      if (neg && /egfr/.test(sentence) && /\balk\b/.test(sentence)) negEgfrAlk = true;
      if (neg) continue;
      for (const [label, re] of MARKERS) if (re.test(sentence) && !markers.includes(label)) markers.push(label);
    }
    // Un marqueur détaillé remplace le générique (EGFR ex19del plutôt qu'EGFR)
    const detailed = markers.filter((m) => !(m === "EGFR" && markers.some((x) => x.startsWith("EGFR ") && x !== "EGFR")));
    if (negEgfrAlk) detailed.push("EGFR/ALK négatif");
    // Lignes : le titre prime, puis le texte du diagnostic
    const lines = [];
    const later = /ayant progresse|en progression|progression est survenue|apres echec|ligne ulterieure|\b2l\b|traitement (systemique )?anterieur|post[- ]/;
    if (/neo ?adjuvant/.test(all)) lines.push("neoadj");
    if (/(^|[^o])adjuvant/.test(all.replace(/neo ?adjuvant/g, ""))) lines.push("adj");
    if (!lines.length) {
      if (/\b1l\b|premiere ligne/.test(t) && !/a partir de la premiere ligne/.test(d)) lines.push("1L");
      else if (later.test(t)) lines.push("2L", "3L");
      else if (/a partir de la premiere ligne/.test(d)) lines.push("1L", "2L", "3L");
      else {
        if (/premiere ligne|non precedemment traite|n.a pas ete traite/.test(d)) lines.push("1L");
        if (later.test(d)) lines.push("2L", "3L");
        if (!lines.length) lines.push("1L", "2L", "3L");
      }
    }
    // Études : acronymes connus, puis tout acronyme cité après « étude » (hors chiffres romains)
    const trials = [];
    const add = (x) => { x = x.trim(); if (x && !/^[IVX]+$/.test(x) && !trials.includes(x)) trials.push(x); };
    const KNOWN = /\b(KEYNOTE-\d+|CheckMate[- ]\w+|IMpower\d+|DESTINY-Lung\d+|LIBRETTO-\d+|STARTRK-\d+|GEOMETRY mono-1|INSIGHT 2|ALTA-1L|ALTA|CASPIAN|PACIFIC|ADAURA|FLAURA2?|AURA3?|MARIPOSA|PAPILLON|CROWN|VISION|PHAROS|REVEL|EURTAC|OPTIMAL|IPSOS|ALKA)\b/g;
    for (const m of just.matchAll(KNOWN)) add(m[1]);
    for (const m of just.matchAll(/\b([A-Z]{2}\d{4,})\b/g)) add(m[1]);
    for (const m of just.matchAll(/(?:étude|essai)(?: [a-zé]+){0,4} ([A-Z][A-Z0-9]{2,}(?:-[A-Za-z0-9]+)?)\b/g)) add(m[1]);
    return { diagnosis, markers: detailed.join(" ; "), lines: [...new Set(lines)], trial: trials.join(" ; ") };
  }

  // Une lettre Word → ligne prête pour la base (métadonnées devinées, à relire)
  async function fromDocx(file, mammoth) {
    const buf = await file.arrayBuffer();
    const { value } = await mammoth.convertToHtml({ arrayBuffer: buf });
    const html = sanitize(value);
    const title = firstLine(html) || file.name.replace(/\.docx$/i, "");
    const warnings = [];
    const d = drugs(html);
    if (!d.length) warnings.push("tableau des médicaments non reconnu");
    if (/\[[^\]]{3,}\]/.test(html)) warnings.push("contient une zone entre crochets");
    return Object.assign({ file: nfc(file.name), title, html, drugs: d, docx: base64(buf), warnings }, guess(html, title));
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

  root.LetterParse = { build, sanitize, guess, fromDocx, nfc, LINES: LINES.map(([id, label]) => [id, label]) };
})(this);
