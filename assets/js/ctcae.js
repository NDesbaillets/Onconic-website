// CTCAE v5.0 et v6.0 : recherche libre d'un symptôme ou d'une anomalie biologique, grading par version, anglais et français.
// Données : /assets/data/ctcae.json (construit par tools/ctcae/build_ctcae.py à partir des fichiers NCIt du NCI, domaine public).
// Accès : médecins (dont CDC), pharmaciens, admins. Aucune donnée de patient.
(function () {
  const cfg = window.ONCONIC_CONFIG || {};
  const sb = window.supabase && cfg.supabaseUrl ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey) : null;
  const PAGE = 30;
  const DATA_URL = "/assets/data/ctcae.json?v=20261105a";
  const ALLOWED = new Set(["admin", "clinician", "cdc", "pharmacist"]);

  const $ = (id) => document.getElementById(id);
  const state = { data: null, terms: [], q: "", ver: "5", lang: "fr", soc: -1, shown: PAGE };

  // ----- Texte -----
  // Minuscules sans accents, lettres et chiffres séparés par des espaces
  const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  // Comparaison de deux libellés de grade d'une version à l'autre : ignore espaces, casse et notation 10e9 / 10^9
  const sig = (s) => String(s || "").toLowerCase().replace(/10e9/g, "10^9").replace(/\s+/g, "").replace(/[.;,]+$/, "");
  function el(tag, cls, txt) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }
  function button(label, cls, onClick) {
    const b = el("button", cls, label);
    b.type = "button";
    b.addEventListener("click", onClick);
    return b;
  }
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* stockage indisponible */ } }
  };

  // ----- Synonymes et abréviations (clé normalisée -> expressions équivalentes, chaque mot doit être présent) -----
  const ALIASES = {
    alt: ["alanine aminotransferase"], alat: ["alanine aminotransferase"], sgpt: ["alanine aminotransferase"], transaminases: ["alanine aminotransferase", "aspartate aminotransferase"],
    ast: ["aspartate aminotransferase"], asat: ["aspartate aminotransferase"], sgot: ["aspartate aminotransferase"],
    alp: ["alkaline phosphatase"], pal: ["alkaline phosphatase"], ggt: ["ggt increased"], ldh: ["lactate dehydrogenase"],
    bilirubine: ["blood bilirubin"], cholestase: ["alkaline phosphatase", "blood bilirubin"],
    anc: ["neutrophil count"], pnn: ["neutrophil count"], neutropenie: ["neutrophil count decreased"], neutropenia: ["neutrophil count decreased"],
    leucopenie: ["white blood cell decreased"], leukopenia: ["white blood cell decreased"], wbc: ["white blood cell"], gb: ["white blood cell"],
    thrombopenie: ["platelet count decreased", "thrombocytopenia"], thrombocytopenie: ["platelet count decreased", "thrombocytopenia"], plaquettes: ["platelet count decreased", "thrombocytopenia"], plt: ["platelet count decreased", "thrombocytopenia"],
    lymphopenie: ["lymphocyte count decreased", "lymphopenia"], lymphopenia: ["lymphocyte count decreased", "lymphopenia"],
    hb: ["anemia", "hemoglobin"], hgb: ["anemia", "hemoglobin"], anemie: ["anemia"], pancytopenie: ["anemia", "neutrophil count decreased"],
    creat: ["creatinine"], creatinine: ["creatinine"], dfg: ["chronic kidney disease", "creatinine clearance"], egfr: ["chronic kidney disease", "creatinine clearance"], gfr: ["chronic kidney disease", "creatinine clearance"], ira: ["acute kidney injury"], aki: ["acute kidney injury"], irc: ["chronic kidney disease"],
    cpk: ["cpk increased"], ck: ["cpk increased"], rhabdo: ["rhabdomyolysis"],
    fevg: ["ejection fraction", "left ventricular"], lvef: ["ejection fraction", "left ventricular"], fe: ["ejection fraction"], cardiotoxicite: ["ejection fraction", "heart failure", "myocarditis"],
    qtc: ["qt corrected"], qt: ["qt corrected"], bav: ["atrioventricular block"], fa: ["atrial fibrillation"], afib: ["atrial fibrillation"],
    hta: ["hypertension"], tvp: ["thromboembolic"], dvt: ["thromboembolic"], vte: ["venous thromboembolism", "thromboembolic"], ep: ["pulmonary embolism", "thromboembolic"], embolie: ["thromboembolic"],
    crs: ["cytokine release syndrome"], rcc: ["cytokine release syndrome"], relargage: ["cytokine release syndrome"], icans: ["immune effector cell"], tls: ["tumor lysis syndrome"], lyse: ["tumor lysis syndrome"],
    hfs: ["palmar plantar"], ppe: ["palmar plantar"], mainpied: ["palmar plantar"], "main pied": ["palmar plantar"],
    sjs: ["stevens johnson"], nel: ["toxic epidermal necrolysis"], ten: ["toxic epidermal necrolysis"], lyell: ["toxic epidermal necrolysis"],
    gvh: ["graft versus host"], gvhd: ["graft versus host"], hlh: ["hemophagocytic"], dress: ["rash", "eosinophilia"],
    pneumonite: ["pneumonitis"], ild: ["pneumonitis", "pulmonary fibrosis"], pid: ["pneumonitis", "pulmonary fibrosis"],
    colite: ["colitis"], hepatite: ["hepatitis"], hypophysite: ["hypophysitis"], thyroidite: ["thyroiditis"], myocardite: ["myocarditis"], uveite: ["uveitis"],
    rash: ["rash maculo papular", "rash acneiform", "rash pustular"], eruption: ["rash maculo papular", "rash acneiform"], acne: ["rash acneiform"],
    neuropathie: ["neuropathy"], polyneuropathie: ["peripheral sensory neuropathy"], paresthesies: ["paresthesia"], vertiges: ["dizziness", "vertigo"],
    nausee: ["nausea"], nausees: ["nausea"], vomissement: ["vomiting"], diarrhee: ["diarrhea"], constipation: ["constipation"],
    fievre: ["fever"], asthenie: ["fatigue"], alopecie: ["alopecia"], mucite: ["mucositis"], stomatite: ["mucositis oral"],
    glycemie: ["hyperglycemia", "hypoglycemia"], natremie: ["hyponatremia", "hypernatremia"], kaliemie: ["hypokalemia", "hyperkalemia"], calcemie: ["hypocalcemia", "hypercalcemia"], magnesemie: ["hypomagnesemia", "hypermagnesemia"],
    phosphatemie: ["hypophosphatemia", "hyperphosphatemia"], uricemie: ["hyperuricemia"], lipase: ["lipase increased"], amylase: ["serum amylase"], tsh: ["thyroid stimulating hormone", "hypothyroidism", "hyperthyroidism"],
    anaphylaxie: ["anaphylaxis"], allergie: ["allergic reaction", "anaphylaxis"], perfusion: ["infusion related reaction"], irr: ["infusion related reaction"]
  };

  // Mots ignorés dans la recherche (« grade 3 », articles)
  const STOP = new Set(["grade", "grades", "gr", "ctcae", "v5", "v6", "de", "du", "des", "la", "le", "les", "d", "l", "et", "of", "the", "and", "1", "2", "3", "4", "5"]);

  // ----- Préparation des données -----
  function prepare(d) {
    const fix = (s) => String(s || "");
    state.data = d;
    state.terms = d.t.map((t, i) => {
      const soc = d.soc[t.s];
      const o = { i, t, soc, has: { 5: !!t.v5, 6: !!t.v6 }, g: {} };
      for (const v of ["5", "6"]) {
        const arr = t["v" + v];
        if (arr) o.g[v] = arr.map((x) => (x < 0 ? null : { en: d.g[x][0], fr: d.g[x][1] || d.g[x][0] }));
      }
      o.def = { 5: t.d5 != null && t.d5 >= 0 ? d.d[t.d5] : "", 6: t.d6 != null && t.d6 >= 0 ? d.d[t.d6] : "" };
      o.names = { 6: { en: t.en, fr: t.fr }, 5: { en: t.n5 || t.en, fr: t.fr5 || t.fr } };
      o.renamed = !!t.n5;
      // Libellés de grade modifiés d'une version à l'autre
      o.changed = [false, false, false, false, false];
      if (o.g[5] && o.g[6]) for (let k = 0; k < 5; k++) {
        const a = o.g[5][k], b = o.g[6][k];
        o.changed[k] = !!(a || b) && sig(a && a.en) !== sig(b && b.en);
      }
      o.nChanged = o.changed.filter(Boolean).length;
      o._nm = norm([t.en, t.fr, t.n5, t.fr5].map(fix).join(" "));
      o._soc = norm(soc.en + " " + soc.fr);
      for (const v of ["5", "6"]) o["_g" + v] = o.g[v] ? norm(o.g[v].map((g) => (g ? g.en + " " + g.fr : "")).join(" ")) : "";
      return o;
    });
    const vocab = new Set();
    for (const o of state.terms) for (const w of o._nm.split(" ")) if (w.length >= 4) vocab.add(w);
    state.vocab = [...vocab];
  }

  // ----- Recherche -----
  const verOK = (o) => state.ver === "all" || o.has[state.ver];
  const activeVers = () => (state.ver === "all" ? ["5", "6"] : [state.ver]);
  const gradeHay = (o) => activeVers().map((v) => o["_g" + v]).join(" ");
  const hasWord = (hay, w) => (" " + hay).indexOf(" " + w) >= 0;

  function wordScore(o, w, exact) {
    if ((" " + o._nm + " ").indexOf(" " + w + " ") >= 0) return 10;
    if (exact) return 0;
    if (hasWord(o._nm, w)) return 7;
    if (w.length >= 5 && o._nm.indexOf(w) >= 0) return 4;
    if (hasWord(o._soc, w)) return 2;
    if (hasWord(gradeHay(o), w)) return 1;
    return 0;
  }
  // Score d'un jeton : lui-même ou l'une de ses expressions équivalentes (tous les mots requis)
  function tokenScore(o, tok, phrase) {
    let best = 0;
    // Abréviation connue (ALT, PNN, CRS…) : le mot lui-même doit être entier, sinon « alt » ramène « altération »
    const short = tok.length <= 4 && !!ALIASES[tok];
    const options = [[tok.split(" "), 1, short]];
    for (const key of [tok, phrase]) if (ALIASES[key]) for (const a of ALIASES[key]) options.push([a.split(" "), 0.8, false]);
    for (const [words, k, exact] of options) {
      let min = Infinity;
      for (const w of words) {
        const s = wordScore(o, w, exact);
        if (!s) { min = 0; break; }
        min = Math.min(min, s);
      }
      if (min > 0 && min * k > best) best = min * k;
    }
    return best;
  }
  function search(tokens, phrase) {
    const out = [];
    for (const o of state.terms) {
      if (!verOK(o) || (state.soc >= 0 && o.t.s !== state.soc)) continue;
      let total = 0;
      let ok = true;
      for (const tok of tokens) {
        const s = tokenScore(o, tok, phrase);
        if (!s) { ok = false; break; }
        total += s;
      }
      if (!ok) continue;
      if (o._nm.indexOf(phrase) >= 0) total += 6;      // expression entière dans le nom
      out.push({ o, score: total });
    }
    out.sort((a, b) => b.score - a.score || a.o.t.s - b.o.t.s || a.o.t.en.localeCompare(b.o.t.en));
    return out;
  }
  // Distance d'édition bornée (insertion, suppression, substitution)
  function near(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return false;
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      let rowMin = i;
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        if (cur[j] < rowMin) rowMin = cur[j];
      }
      if (rowMin > max) return false;
      prev = cur;
    }
    return prev[b.length] <= max;
  }
  function fuzzy(tokens) {
    let changed = false;
    const fixed = tokens.map((t) => {
      if (t.length < 5 || ALIASES[t]) return t;
      const max = t.length >= 9 ? 2 : 1;
      const hit = state.vocab.find((w) => w !== t && near(t, w, max) && w[0] === t[0]);
      if (hit) { changed = true; return hit; }
      return t;
    });
    return changed ? fixed : null;
  }

  // ----- Surlignage -----
  const flat = (c) => { const r = c.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase(); return r.length === 1 ? r : (r[0] || " "); };
  function appendHL(parent, text, words) {
    if (!words || !words.length) { parent.append(text); return; }
    const f = Array.from(text, (c) => (/[a-z0-9]/.test(flat(c)) ? flat(c) : " ")).join("");
    const mark = new Array(text.length).fill(false);
    for (const w of words) {
      let from = 0, at;
      while ((at = f.indexOf(w, from)) >= 0) {
        if (at === 0 || f[at - 1] === " ") for (let k = 0; k < w.length; k++) mark[at + k] = true;
        from = at + 1;
      }
    }
    let i = 0;
    while (i < text.length) {
      let j = i;
      while (j < text.length && mark[j] === mark[i]) j++;
      if (mark[i]) parent.append(el("mark", "", text.slice(i, j))); else parent.append(text.slice(i, j));
      i = j;
    }
  }

  // ----- Affichage -----
  const VER_LABEL = { 5: "v5.0", 6: "v6.0" };
  const socName = (o) => (state.lang === "en" ? o.soc.en : o.soc.fr);
  function nameFor(o, v) { return o.names[v]; }
  function shownName(o) {
    const v = state.ver === "5" ? "5" : "6";
    const n = o.has[v] ? nameFor(o, v) : nameFor(o, o.has[6] ? "6" : "5");
    return n;
  }
  function pair(parent, n, words) {
    const primary = state.lang === "en" ? n.en : n.fr || n.en;
    const second = state.lang === "both" && n.en && n.en !== primary ? n.en : "";
    const a = el("span", "ct-name");
    appendHL(a, primary, words);
    parent.append(a);
    if (second) { const b = el("span", "ct-alt"); appendHL(b, second, words); parent.append(b); }
  }

  function gradeText(g, words, cls) {
    const box = el("div", cls || "ct-txt");
    if (!g) { box.append(el("span", "ct-none", "—")); return box; }
    if (state.lang !== "en") { const p = el("p", "ct-fr"); appendHL(p, g.fr, words); box.append(p); }
    if (state.lang !== "fr" || !g.fr) { const p = el("p", state.lang === "both" ? "ct-en" : "ct-fr"); appendHL(p, g.en, words); box.append(p); }
    return box;
  }

  function copyText(o, v) {
    const n = nameFor(o, v);
    const head = (state.lang === "en" ? n.en : state.lang === "fr" ? n.fr : n.fr + " / " + n.en) + " (CTCAE " + VER_LABEL[v] + ")";
    const lines = [head];
    o.g[v].forEach((g, k) => {
      if (!g) return;
      const t = state.lang === "en" ? g.en : state.lang === "fr" ? g.fr : g.fr + " / " + g.en;
      lines.push("Grade " + (k + 1) + " : " + t);
    });
    return lines.join("\n");
  }
  async function copy(text, btn) {
    const old = btn.textContent;
    try { await navigator.clipboard.writeText(text); btn.textContent = "Copié"; } catch (e) { btn.textContent = "Copie impossible"; }
    setTimeout(() => { btn.textContent = old; }, 1600);
  }

  function renderBody(o, words) {
    const body = el("div", "ug-body ct-body");
    const vers = activeVers().filter((v) => o.has[v]);
    const defV = vers.includes("6") ? "6" : vers[0];
    if (o.def[defV]) {
      const p = el("p", "ct-def");
      p.append(el("strong", "", "Définition NCI (anglais) : "), o.def[defV]);
      body.append(p);
    }
    if (state.ver === "all" && (o.has[5] !== o.has[6])) {
      body.append(el("p", "ug-flag", o.has[5] ? "Ce terme existe dans la v5.0 seulement : il n'a pas été repris tel quel dans la v6.0." : "Ce terme est nouveau dans la v6.0 : il n'existe pas dans la v5.0."));
    }
    if (state.ver === "all" && o.renamed) {
      body.append(el("p", "ug-flag", "Terme renommé : v5.0 « " + o.t.n5 + " », v6.0 « " + o.t.en + " »."));
    }
    const table = el("table", "ct-table");
    const cap = el("caption", "visually-hidden", "Grades de " + o.t.en);
    table.append(cap);
    const thead = el("thead");
    const hr = el("tr");
    hr.append(el("th", "ct-gh", "Grade"));
    for (const v of vers) {
      const th = el("th", "ct-vh");
      th.scope = "col";
      th.append("CTCAE " + VER_LABEL[v]);
      hr.append(th);
    }
    thead.append(hr);
    table.append(thead);
    const tb = el("tbody");
    for (let k = 0; k < 5; k++) {
      if (!vers.some((v) => o.g[v][k])) continue;
      const tr = el("tr");
      const th = el("th", "ct-g", String(k + 1));
      th.scope = "row";
      th.setAttribute("aria-label", "Grade " + (k + 1));
      tr.append(th);
      for (const v of vers) {
        const td = el("td", "ct-cell" + (vers.length > 1 && o.changed[k] ? " ct-chg" : ""));
        td.dataset.ver = "CTCAE " + VER_LABEL[v];
        td.append(gradeText(o.g[v][k], words));
        if (vers.length > 1 && o.changed[k]) td.append(el("span", "ct-flag", "≠ modifié entre v5.0 et v6.0"));
        tr.append(td);
      }
      tb.append(tr);
    }
    table.append(tb);
    body.append(table);
    const acts = el("div", "ct-acts");
    for (const v of vers) acts.append(button("Copier " + VER_LABEL[v], "btn btn-outline ug-copy", (e) => copy(copyText(o, v), e.currentTarget)));
    body.append(acts);
    const foot = el("p", "muted ct-foot", "Catégorie : " + socName(o) + (state.lang === "both" ? " / " + o.soc.en : ""));
    body.append(foot);
    return body;
  }

  // Extrait de grade quand la recherche ne porte pas sur le nom
  function snippet(o, words) {
    if (!words.length) return null;
    for (const v of activeVers().slice().reverse()) {
      if (!o.g[v]) continue;
      for (let k = 0; k < 5; k++) {
        const g = o.g[v][k];
        if (!g) continue;
        const txt = state.lang === "en" ? g.en : g.fr;
        const n = norm(txt);
        if (words.some((w) => hasWord(n, w))) return { k, txt: txt.length > 150 ? txt.slice(0, 147) + "…" : txt, v };
      }
    }
    return null;
  }

  function card(o, words, open) {
    const d = el("details", "ug-card ct-card");
    d.id = "ct-" + o.i;
    if (open) d.open = true;
    const sum = el("summary");
    const head = el("span", "ug-head");
    const line = el("span", "ct-line");
    pair(line, shownName(o), words);
    head.append(line);
    const meta = el("span", "ug-meta");
    meta.append(el("span", "ug-badge", socName(o)));
    if (state.ver === "all") {
      if (o.has[5] && o.has[6]) {
        if (o.nChanged) meta.append(el("span", "ug-badge ug-warn", o.nChanged + (o.nChanged > 1 ? " grades modifiés" : " grade modifié")));
        else meta.append(el("span", "ug-badge", "identique v5.0 / v6.0"));
        if (o.renamed) meta.append(el("span", "ug-badge ug-warn", "renommé"));
      } else meta.append(el("span", "ug-badge ug-warn", o.has[5] ? "v5.0 seulement" : "nouveau en v6.0"));
    }
    head.append(meta);
    if (words.length && !words.some((w) => hasWord(o._nm, w))) {
      const sn = snippet(o, words);
      if (sn) {
        const p = el("span", "ct-snip");
        p.append("Grade " + (sn.k + 1) + " (" + VER_LABEL[sn.v] + ") : ");
        appendHL(p, sn.txt, words);
        head.append(p);
      }
    }
    sum.append(head, el("span", "ct-chev"));
    sum.querySelector(".ct-chev").setAttribute("aria-hidden", "true");
    d.append(sum);
    let built = false;
    const build = () => { if (!built) { built = true; d.append(renderBody(o, words)); } };
    d.addEventListener("toggle", () => { if (d.open) build(); });
    if (open) build();
    return d;
  }

  // ----- Écran -----
  function wordsOf(tokens, phrase) {
    const set = new Set();
    for (const t of tokens) {
      t.split(" ").forEach((w) => w && set.add(w));
      for (const key of [t, phrase]) if (ALIASES[key]) ALIASES[key].forEach((a) => a.split(" ").forEach((w) => set.add(w)));
    }
    return [...set];
  }

  function render() {
    const list = $("ct-list");
    list.replaceChildren();
    const q = state.q.trim();
    const phrase = norm(q);
    const tokens = phrase.split(" ").filter((t) => t && !STOP.has(t));
    $("ct-browse").hidden = true;
    $("ct-more").hidden = true;

    if (!tokens.length && state.soc < 0) {
      $("ct-count").textContent = "";
      renderBrowse();
      return;
    }

    let results, approx = null;
    if (!tokens.length) {
      results = state.terms.filter((o) => verOK(o) && o.t.s === state.soc).map((o) => ({ o, score: 0 }))
        .sort((a, b) => a.o.t.en.localeCompare(b.o.t.en));
    } else {
      results = search(tokens, phrase);
      if (!results.length) {
        const fixed = fuzzy(tokens);
        if (fixed) { results = search(fixed, fixed.join(" ")); if (results.length) approx = fixed.join(" "); }
      }
    }
    const words = tokens.length ? wordsOf(approx ? approx.split(" ") : tokens, phrase) : [];
    const n = results.length;
    $("ct-count").textContent = n
      ? (approx ? "Aucune correspondance exacte ; résultats pour « " + approx + " » : " : "") + n + (n > 1 ? " termes" : " terme")
      : "Aucun terme ne correspond. Essayez un mot plus court, le nom anglais ou une abréviation (ALAT, PNN, CRS).";
    const shown = results.slice(0, state.shown);
    shown.forEach((r, idx) => list.append(card(r.o, words, n <= 3 || (idx === 0 && tokens.length > 0 && r.score >= 10 && n <= 8))));
    $("ct-more").hidden = n <= state.shown;
    if (n > state.shown) $("ct-more-btn").textContent = "Afficher plus (" + (n - state.shown) + " restants)";
  }

  const QUICK = ["diarrhée", "nausées", "neutropénie fébrile", "ALAT", "neuropathie périphérique", "pneumopathie", "relargage cytokinique", "hypertension", "main-pied", "fatigue", "mucite", "éruption"];
  function renderBrowse() {
    const box = $("ct-browse");
    box.replaceChildren();
    box.hidden = false;
    const quick = el("div", "ct-quick");
    quick.append(el("span", "ct-ctl-label", "Recherches fréquentes"));
    const chips = el("div", "ug-chips");
    for (const w of QUICK) chips.append(button(w, "ug-chip", () => { $("q").value = w; state.q = w; state.shown = PAGE; sync(); render(); $("q").focus(); }));
    quick.append(chips);
    box.append(quick);
    const cats = el("div", "ct-cats");
    cats.append(el("span", "ct-ctl-label", "Parcourir par catégorie"));
    const grid = el("div", "ct-catgrid");
    state.data.soc.forEach((s, i) => {
      const n = state.terms.filter((o) => verOK(o) && o.t.s === i).length;
      if (!n) return;
      const b = button("", "ct-cat", () => { state.soc = i; $("ct-soc").value = String(i); state.shown = PAGE; sync(); render(); });
      b.append(el("span", "ct-cat-n", socFor(s)), el("span", "ct-cat-c", n + (n > 1 ? " termes" : " terme")));
      grid.append(b);
    });
    cats.append(grid);
    box.append(cats);
  }
  const socFor = (s) => (state.lang === "en" ? s.en : s.fr);

  function segment(box, options, key, onPick) {
    box.replaceChildren();
    for (const [val, label] of options) {
      const b = button(label, "ug-chip", () => { state[key] = val; store.set("ctcae2." + key, val); onPick(); });
      b.setAttribute("aria-pressed", String(state[key] === val));
      box.append(b);
    }
  }
  function controls() {
    segment($("ct-ver"), [["5", "v5.0"], ["6", "v6.0"], ["all", "v5.0 et v6.0"]], "ver", () => { state.shown = PAGE; controls(); sync(); render(); });
    segment($("ct-lang"), [["fr", "Français"], ["both", "Français et anglais"], ["en", "Anglais"]], "lang", () => { controls(); fillSoc(); sync(); render(); });
  }
  function fillSoc() {
    const sel = $("ct-soc");
    sel.replaceChildren();
    sel.append(new Option("Toutes les catégories", "-1"));
    state.data.soc.forEach((s, i) => sel.append(new Option(socFor(s), String(i))));
    sel.value = String(state.soc);
  }
  // Adresse partageable : ?q=…&v=5|6&l=fr|en&c=n
  function sync() {
    const p = new URLSearchParams();
    if (state.q.trim()) p.set("q", state.q.trim());
    if (state.ver !== "5") p.set("v", state.ver);
    if (state.lang !== "fr") p.set("l", state.lang);
    if (state.soc >= 0) p.set("c", String(state.soc));
    const s = p.toString();
    try { history.replaceState(null, "", location.pathname + (s ? "?" + s : "")); } catch (e) { /* ignoré */ }
  }

  // ----- Démarrage -----
  (async () => {
    if (!sb) return ($("ct-status").textContent = "Service indisponible.");
    const { data } = await sb.auth.getSession();
    if (!data.session) return (location.href = "/fr/the-hive.html");
    $("logout").addEventListener("click", async () => { await sb.auth.signOut(); location.href = "/fr/"; });
    const { data: profile } = await sb.from("profiles").select("role").eq("id", data.session.user.id).single();
    const role = profile ? profile.role : "member";
    if (!ALLOWED.has(role)) {
      $("ct-status").textContent = "Cet outil est réservé aux médecins. Contactez l'administrateur si besoin.";
      return;
    }
    try {
      const res = await fetch(DATA_URL);
      if (!res.ok) throw new Error("HTTP " + res.status);
      prepare(await res.json());
    } catch (e) { $("ct-status").textContent = "Chargement impossible : " + e.message; return; }

    const p = new URLSearchParams(location.search);
    const sv = store.get("ctcae2.ver"), sl = store.get("ctcae2.lang");
    state.ver = ["all", "5", "6"].includes(p.get("v")) ? p.get("v") : ["all", "5", "6"].includes(sv) ? sv : "5";
    state.lang = ["both", "fr", "en"].includes(p.get("l")) ? p.get("l") : ["both", "fr", "en"].includes(sl) ? sl : "fr";
    const c = parseInt(p.get("c"), 10);
    state.soc = c >= 0 && c < state.data.soc.length ? c : -1;
    state.q = p.get("q") || "";
    $("q").value = state.q;

    const m = state.data.meta;
    $("ct-src").textContent = `${m.v5.label} (${m.v5.date}, ${m.v5.meddra}) et ${m.v6.label} (${m.v6.date}, ${m.v6.meddra}). ${m.source}.`;
    $("ct-status").hidden = true;
    $("ct-tool").hidden = false;
    controls();
    fillSoc();
    let timer = 0;
    $("q").addEventListener("input", (e) => {
      state.q = e.target.value;
      state.shown = PAGE;
      render();
      clearTimeout(timer);
      timer = setTimeout(sync, 400);
    });
    $("ct-soc").addEventListener("change", (e) => { state.soc = parseInt(e.target.value, 10); state.shown = PAGE; sync(); render(); });
    $("ct-more-btn").addEventListener("click", () => { state.shown += PAGE; render(); });
    render();
  })();
})();
