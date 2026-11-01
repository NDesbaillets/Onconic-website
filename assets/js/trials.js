// Key trials : une fiche par étude clé, recherchable par clinique, diagnostic, drivers et ligne.
// Les graphiques (schéma de l'étude, courbes de survie, forest plot des HR, médianes, taux) sont générés
// à partir des chiffres de la fiche ; aucune figure des articles n'est reproduite.
(function () {
  const cfg = window.ONCONIC_CONFIG || {};
  const sb = window.supabase && cfg.supabaseUrl ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey) : null;

  const BLOCS = [
    ["Bloc 1", ["Sénologie", "Gynécologie", "Urologie"]],
    ["Bloc 2", ["Thoracique", "Neuro-oncologie", "Mélanome"]],
    ["Bloc 3", ["Lower GI", "Upper GI", "ORL", "Sarcomes", "Radiologie interventionnelle"]]
  ];
  const LINES = [["neoadj", "Néoadjuvant"], ["adj", "Adjuvant"], ["1L", "1re ligne"], ["2L", "2e ligne"], ["3L", "3e ligne et plus"]];
  const LINE_LABEL = Object.fromEntries(LINES);
  const PRACTICE = { oui: "Practice changing", partiel: "Practice changing (partiel)", non: "Pas practice changing" };
  const EP = { OS: "OS", PFS: "PFS", DFS: "DFS", EFS: "EFS", ORR: "ORR", DoR: "DoR" };
  const SVGNS = "http://www.w3.org/2000/svg";

  const $ = (id) => document.getElementById(id);
  const state = { rows: [], admin: false, clinic: "", line: "", me: "" };
  const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9+<>≥≤%]+/g, " ").trim();
  const SYN = [["cbnpc", "nsclc", "cpnpc"], ["cppc", "sclc"], ["her2", "erbb2"], ["epidermoide", "squameux", "squamous"]];
  // Synonymes par mot entier (« nsclc » ne doit pas déclencher « sclc »)
  const expand = (s) => {
    let t = norm(s);
    const words = new Set(t.split(" "));
    for (const g of SYN) if (g.some((w) => words.has(w))) t += " " + g.join(" ");
    return t;
  };
  const num = (x) => String(x).replace(".", ",");
  const hr = (x) => Number(x).toFixed(2).replace(".", ",");
  const med = (x) => Number(x).toFixed(1).replace(".", ",");

  function el(tag, cls, txt) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }
  const badge = (txt, cls) => el("span", "ug-badge " + (cls || ""), txt);
  function button(label, cls, onClick) { const b = el("button", cls, label); b.type = "button"; b.addEventListener("click", onClick); return b; }
  function svg(tag, attrs, txt) {
    const e = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
    if (txt != null) e.textContent = txt;
    return e;
  }

  // ----- Données -----
  async function load() {
    const { data, error } = await sb.from("key_trials").select("*").order("acronym").range(0, 999);
    if (error) throw error;
    state.rows = (data || []).map((r) => Object.assign(r, {
      _hay: expand([r.acronym, r.title, r.drugs, r.diagnosis, r.markers, r.phase, r.summary].join(" ")),
      _dx: expand([r.diagnosis, r.title].join(" ")),
      _mk: (r.markers || "").split(";").map(expand)
    }));
  }

  // ----- Recherche -----
  function search() {
    const tokens = norm($("q").value).split(" ").filter(Boolean);
    const dx = norm($("f-dx").value).split(" ").filter(Boolean);
    const mk = norm($("f-mk").value).split(" ").filter(Boolean);
    const neg = mk.some((t) => t.startsWith("neg"));
    const list = state.rows.filter((r) =>
      (!state.clinic || norm(r.clinic) === state.clinic) &&
      (!state.line || (r.lines || []).includes(state.line)) &&
      tokens.every((t) => r._hay.includes(t)) &&
      dx.every((t) => r._dx.split(" ").some((w) => w.startsWith(t))) &&
      (!mk.length || mk.every((t) => r._mk.some((m) => m.includes(t) && (neg || !/negati/.test(m))))));
    $("ug-count").textContent = `${list.length} étude${list.length > 1 ? "s" : ""}` + (list.length !== state.rows.length ? ` sur ${state.rows.length}` : "");
    $("ug-results").replaceChildren(...list.map(card));
    if (list.length === 1) $("ug-results").firstChild.open = true;
  }

  function card(r) {
    const d = el("details", "ug-card lt-card kt-card");
    d.id = "trial-" + r.slug;
    const s = el("summary");
    const head = el("div", "ug-head");
    const name = el("span", "ug-name");
    name.append(el("strong", "kt-acro", r.acronym), " ", r.title);
    head.append(name);
    const meta = el("div", "ug-meta");
    if (r.status === "draft") meta.append(badge("Brouillon à relire", "ug-warn"));
    (r.lines || []).forEach((l) => meta.append(badge(LINE_LABEL[l] || l)));
    if (r.diagnosis) meta.append(badge(r.diagnosis));
    (r.markers || "").split(";").map((m) => m.trim()).filter(Boolean).forEach((m) => meta.append(badge(m, "lt-marker")));
    if (r.practice) meta.append(badge(PRACTICE[r.practice], "kt-pc kt-pc-" + r.practice));
    head.append(meta);
    const key = keyResult(r);
    if (key) head.append(el("p", "lt-drugs", key));
    s.append(head);
    d.append(s);
    d.addEventListener("toggle", () => { if (d.open && !d.dataset.ready) body(d, r); });
    return d;
  }

  // Résultat principal en une ligne : premier critère avec HR
  function keyResult(r) {
    const o = (r.outcomes || []).find((x) => x.hr != null) || (r.outcomes || [])[0];
    if (!o) return "";
    if (o.hr != null) return `${o.label} : HR ${hr(o.hr)} (IC ${o.ci || "95 %"} ${hr(o.lo)}–${hr(o.hi)})`;
    const a = (o.arms || []).filter((x) => x.rate != null).map((x) => `${x.arm} ${num(x.rate)} %`);
    return a.length ? `${o.label} : ${a.join(" · ")}` : o.label;
  }

  function body(d, r) {
    d.dataset.ready = "1";
    const b = el("div", "ug-body kt-body");
    if (r.status === "draft") b.append(el("p", "ug-note ug-attn", "Brouillon généré à partir des résumés publiés : à relire avant publication."));
    if (r.summary) b.append(el("p", "kt-summary", r.summary));

    // Design : schéma de l'étude en tête, puis les faits clés
    const de = r.design || {};
    const width = Math.max(300, d.clientWidth - 40);
    const scheme = studyScheme(r, width);
    const dl = el("dl", "ug-dl kt-design");
    const fact = (k, v) => { if (v) dl.append(el("dt", null, k), el("dd", null, v)); };
    fact("Type", r.phase);
    fact("Population", de.population);
    fact("Randomisation", de.randomization);
    const n = (de.arms || []).reduce((s, a) => s + (a.n || 0), 0) || de.total;
    fact("Bras", (de.arms || []).map((a) => a.name + (a.n ? ` (n = ${a.n})` : "")).join(" vs ") + (n ? ` · total ${n}` : ""));
    fact("Critère principal", de.primary);
    fact("Stratification", de.stratification);
    fact("Remarques", de.notes);
    b.append(section("Design de l'étude", ...(scheme ? [scheme] : []), dl));
    const rx = regimens(r);
    if (rx) b.append(rx);

    // Résultats : graphiques + tableau
    const outs = r.outcomes || [];
    const charts = el("div", "kt-charts");
    const kmW = Math.min(640, Math.max(300, width >= 900 ? width / 2 - 40 : width - 30));
    for (const k of r.km || []) {
      const fig = kmFigure(k, kmW);
      if (fig) charts.append(fig);
    }
    const forest = forestPlot(outs);
    if (forest) { const f = figure("Hazard ratios (IC)", forest); f.classList.add("wide"); charts.append(f); }
    for (const o of outs) {
      const med = (o.arms || []).filter((a) => a.median != null || a.nr);
      if (med.length) charts.append(figure(`${o.label} : médianes${o.timepoint ? " · " + o.timepoint : ""}`, bars(med.map((a) => ({ label: a.arm, value: a.median, nr: a.nr })), "mois")));
      const rates = (o.arms || []).filter((a) => a.rate != null);
      if (rates.length) charts.append(figure(`${o.label}${o.note ? " · " + o.note.toLowerCase() : o.timepoint ? " · " + o.timepoint : ""}`, bars(rates.map((a) => ({ label: a.arm, value: a.rate })), "%", 100)));
    }
    b.append(section("Résultats", charts, table(outs)));
    const tol = safety(r);
    if (tol) b.append(tol);

    // Discussion
    const disc = el("div", "kt-disc");
    const box = (title, txt, cls) => { if (!txt) return; const x = el("div", "kt-disc-box " + (cls || "")); x.append(el("h4", null, title), el("p", null, txt)); disc.append(x); };
    box("Forces", r.strengths, "plus");
    box("Limites", r.limitations, "minus");
    box(r.practice ? PRACTICE[r.practice] + " ?" : "Practice changing ?", r.practice_text, "pc");
    b.append(section("Discussion", disc));

    // Références
    const ul = el("ul", "kt-refs");
    for (const ref of r.refs || []) {
      const li = el("li");
      li.append(`${ref.label}. ${ref.journal} ${ref.year}. `);
      if (ref.pmid) { const a = el("a", null, `PMID ${ref.pmid}`); a.href = `https://pubmed.ncbi.nlm.nih.gov/${ref.pmid}/`; a.target = "_blank"; a.rel = "noopener noreferrer"; li.append(a); }
      if (ref.doi) { li.append(" · "); const a = el("a", null, `doi:${ref.doi}`); a.href = `https://doi.org/${ref.doi}`; a.target = "_blank"; a.rel = "noopener noreferrer"; li.append(a); }
      ul.append(li);
    }
    b.append(section("Références", ul));
    b.append(el("p", "muted kt-stamp", [r.reviewed_by ? `Relu par ${r.reviewed_by} le ${fmtDate(r.reviewed_at)}` : "Pas encore relu", `mis à jour le ${new Date(r.updated_at).toLocaleDateString("fr-CH")}`].join(" · ")));

    if (state.admin) b.append(adminBar(r));
    d.append(b);
  }

  const fmtDate = (s) => (s ? s.split("-").reverse().join(".") : "");
  function section(title, ...nodes) { const s = el("section", "kt-section"); s.append(el("h3", null, title), ...nodes); return s; }
  function figure(caption, node) { const f = el("figure", "kt-fig"); f.append(node, el("figcaption", null, caption)); return f; }

  function table(outs) {
    if (!outs.length) return el("span");
    const t = el("table", "it-table kt-table");
    const tr = el("tr");
    ["Critère", "Résultats par bras", "HR (IC)", "p"].forEach((h) => tr.append(el("th", null, h)));
    t.append(el("thead"), el("tbody"));
    t.tHead.append(tr);
    for (const o of outs) {
      const row = el("tr");
      const arms = (o.arms || []).map((a) => {
        const parts = [];
        if (a.nr) parts.push("médiane non atteinte");
        else if (a.median != null) parts.push(`${med(a.median)} mois`);
        if (a.rate != null) parts.push(`${num(a.rate)} %`);
        return `${a.arm} : ${parts.join(", ")}`;
      }).join(" · ");
      row.append(el("td", null, [EP[o.ep] || o.ep, o.label !== o.ep ? "— " + o.label : "", o.timepoint ? `(${o.timepoint})` : ""].filter(Boolean).join(" ")),
        el("td", null, arms + (o.note ? ` (${o.note})` : "")),
        el("td", null, o.hr != null ? `${hr(o.hr)} (${hr(o.lo)}–${hr(o.hi)}${o.ci ? ", IC " + o.ci : ""})` : "—"),
        el("td", null, o.p || "—"));
      t.tBodies[0].append(row);
    }
    const wrap = el("div", "it-table-wrap");
    wrap.append(t);
    return wrap;
  }

  // Tolérance : synthèse, puis tableau des effets indésirables principaux (fréquence par grade et par bras)
  function safety(r) {
    const ae = r.ae || {};
    const arms = ae.arms || [];
    const rows = (ae.rows || []).filter((x) => Array.isArray(x) && x.length);
    if (!r.safety && !rows.length) return null;
    const nodes = [];
    if (r.safety) nodes.push(el("p", null, r.safety));
    if (rows.length && arms.length) {
      const pct = (v) => (v == null || v === "" ? "—" : typeof v === "number" ? num(v) + " %" : String(v));
      const t = el("table", "it-table kt-ae");
      t.append(el("thead"), el("tbody"));
      const h1 = el("tr"), h2 = el("tr");
      const first = el("th", null, "Effet indésirable");
      first.rowSpan = 2;
      h1.append(first);
      arms.forEach((a, i) => {
        const th = el("th", "kt-ae-arm " + ARM[i % 3], a);
        th.colSpan = 2;
        h1.append(th);
        h2.append(el("th", null, "Tous grades"), el("th", null, ae.grade || "Grade ≥ 3"));
      });
      t.tHead.append(h1, h2);
      for (const x of rows) {
        const tr = el("tr");
        tr.append(el("th", null, x[0]));
        arms.forEach((a, i) => {
          [x[1 + 2 * i], x[2 + 2 * i]].forEach((v, j) => {
            const c = el("td", j ? "kt-ae-g3" : null, pct(v));
            c.dataset.label = `${a} · ${j ? ae.grade || "Grade ≥ 3" : "tous grades"}`;
            tr.append(c);
          });
        });
        t.tBodies[0].append(tr);
      }
      const tw = el("div", "it-table-wrap kt-ae-wrap");
      tw.append(t);
      nodes.push(tw);
    }
    if (ae.source) nodes.push(el("p", "muted kt-stamp", ae.source));
    return section("Tolérance", ...nodes);
  }

  // Retour à la ligne approximatif pour le texte SVG (≈ 6,4 px par caractère à 12 px)
  function wrap(text, px, size) {
    const max = Math.max(8, Math.floor(px / ((size || 12) * 0.53)));
    const out = [];
    let line = "";
    for (const w of String(text || "").split(/\s+/).filter(Boolean)) {
      if (line && (line + " " + w).length > max) { out.push(line); line = w; } else line = line ? line + " " + w : w;
    }
    if (line) out.push(line);
    return out;
  }
  const ARM = ["kt-k0", "kt-k1", "kt-k2"];

  // Boîte de texte : titre en gras puis lignes, hauteur calculée
  function textBox(g, x, y, w, title, lines, cls) {
    const lh = 16, pad = 10;
    const titleLines = wrap(title, w - 2 * pad, 13);
    const h = pad * 2 + titleLines.length * lh + lines.length * lh + (lines.length ? 4 : 0);
    g.append(svg("rect", { x, y, width: w, height: h, class: "kt-box " + (cls || "") }));
    let cy = y + pad + 12;
    for (const t of titleLines) { g.append(svg("text", { x: x + pad, y: cy, class: "kt-box-title" }, t)); cy += lh; }
    cy += 4;
    for (const t of lines) { g.append(svg("text", { x: x + pad, y: cy, class: "kt-box-text" }, t)); cy += lh; }
    return h;
  }
  const measure = (w, title, lines) => 20 + wrap(title, w - 20, 13).length * 16 + lines.length * 16 + (lines.length ? 4 : 0);
  const arrow = (g, x1, y1, x2, y2) => g.append(svg("line", { x1, y1, x2, y2, class: "kt-arrow", "marker-end": "url(#kt-head)" }));

  // Schéma de l'étude : population → randomisation → bras → critères
  function studyScheme(r, width) {
    const de = r.design || {};
    const arms = de.arms || [];
    if (!arms.length) return null;
    const horizontal = width >= 680;
    const W = horizontal ? Math.min(width, 980) : Math.min(width, 520);
    const randomized = de.randomization && !/^aucune/i.test(de.randomization);
    const ratio = randomized ? de.randomization.split(" ")[0] : "";
    const popW = horizontal ? W * 0.29 : W;
    const armW = horizontal ? W * 0.36 : W;
    const epW = horizontal ? W - popW - armW - 130 : W;
    const bullets = (w) => (de.inclusion && de.inclusion.length ? de.inclusion : [de.population]).flatMap((t) => wrap(t, w - 32).map((l, i) => (i ? "   " : "• ") + l));
    const armLines = (a, w) => {
      const lines = [];
      if (a.n) lines.push(`n = ${a.n}`);
      for (const x of a.regimen || []) lines.push(...wrap(x.dose && x.dose.length <= 24 && x.dose !== "—" ? `${x.drug} ${x.dose}` : x.drug, w - 20));
      return lines;
    };
    const epLines = (w) => [...wrap(de.primary, w - 20)].concat(de.secondary ? ["", ...wrap("Secondaires : " + de.secondary, w - 20)] : []);
    const popLines = bullets(popW), epL = epLines(epW);
    const popH = measure(popW, "Population", popLines), epH = measure(epW, "Critère principal", epL);
    const armHs = arms.map((a) => measure(armW, a.name, armLines(a, armW)));
    const armsH = armHs.reduce((s, h) => s + h, 0) + (arms.length - 1) * 12;
    const H = horizontal ? Math.max(popH, armsH, epH) + 8 : popH + 70 + armsH + 40 + epH + 8;
    const g = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "kt-svg kt-scheme", role: "img", "aria-label": `Schéma de l'étude ${r.acronym}` });
    const defs = svg("defs");
    const m = svg("marker", { id: "kt-head", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" });
    m.append(svg("path", { d: "M0,0 L10,5 L0,10 z", class: "kt-arrow-head" }));
    defs.append(m);
    g.append(defs);
    const circle = (cx, cy) => {
      if (!randomized) return g.append(svg("text", { x: cx, y: cy + 4, class: "kt-box-text", "text-anchor": "middle" }, arms.length > 1 ? "cohortes" : ""));
      g.append(svg("circle", { cx, cy, r: 22, class: "kt-rand" }));
      g.append(svg("text", { x: cx, y: cy - 2, class: "kt-rand-txt", "text-anchor": "middle" }, "R"));
      g.append(svg("text", { x: cx, y: cy + 12, class: "kt-rand-sub", "text-anchor": "middle" }, ratio));
    };
    if (horizontal) {
      const mid = H / 2;
      textBox(g, 0, mid - popH / 2, popW, "Population", popLines, "pop");
      const rx = popW + 45;
      arrow(g, popW, mid, rx - (randomized ? 24 : 30), mid);
      circle(rx, mid);
      const ax = popW + 90;
      let y = mid - armsH / 2;
      arms.forEach((a, i) => {
        const h = armHs[i], cy = y + h / 2;
        g.append(svg("path", { d: `M${rx + (randomized ? 22 : 28)},${mid} C${rx + 40},${mid} ${ax - 30},${cy} ${ax - 2},${cy}`, class: "kt-arrow", "marker-end": "url(#kt-head)" }));
        textBox(g, ax, y, armW, a.name, armLines(a, armW), "arm " + ARM[i % 3]);
        arrow(g, ax + armW, cy, W - epW - 2, cy);
        y += h + 12;
      });
      textBox(g, W - epW, mid - epH / 2, epW, "Critère principal", epL, "ep");
    } else {
      textBox(g, 0, 0, W, "Population", popLines, "pop");
      const cx = W / 2;
      arrow(g, cx, popH, cx, popH + 22);
      circle(cx, popH + 46);
      let y = popH + 70;
      arms.forEach((a, i) => {
        textBox(g, 0, y, W, a.name, armLines(a, W), "arm " + ARM[i % 3]);
        y += armHs[i] + 12;
      });
      arrow(g, cx, y - 12, cx, y + 26);
      textBox(g, 0, y + 28, W, "Critère principal", epL, "ep");
    }
    const f = figure([r.phase, de.randomization && randomized ? "randomisation " + de.randomization : "", de.stratification && randomized ? "stratification : " + de.stratification : ""].filter(Boolean).join(" · "), g);
    f.classList.add("kt-scheme-fig");
    return f;
  }

  // Schémas thérapeutiques par bras, avec copie en texte
  function regimens(r) {
    const arms = ((r.design || {}).arms || []).filter((a) => (a.regimen || []).length);
    if (!arms.length) return null;
    const wrapEl = el("div", "kt-rx-grid");
    arms.forEach((a, i) => {
      const box = el("div", "kt-rx " + ARM[i % 3]);
      const h = el("h4", null, a.name);
      if (a.n) h.append(el("span", "muted", ` · n = ${a.n}`));
      const t = el("table", "it-table kt-rx-table");
      t.append(el("thead"), el("tbody"));
      const tr = el("tr");
      ["Médicament", "Dose", "Voie", "Schéma", "Durée"].forEach((x) => tr.append(el("th", null, x)));
      t.tHead.append(tr);
      for (const x of a.regimen) {
        const row = el("tr");
        [x.drug, x.dose, x.route, x.schedule, x.duration].forEach((v, j) => {
          const c = el(j ? "td" : "th", null, v || "");
          c.dataset.label = ["Médicament", "Dose", "Voie", "Schéma", "Durée"][j];
          row.append(c);
        });
        t.tBodies[0].append(row);
      }
      const tw = el("div", "it-table-wrap");
      tw.append(t);
      box.append(h, tw);
      wrapEl.append(box);
    });
    const de = r.design || {};
    // Seul le traitement expérimental est copié : bras marqués control: true exclus ; à défaut de marquage,
    // le premier bras d'une étude randomisée est considéré comme expérimental.
    const flagged = arms.some((a) => "control" in a);
    const randomized = arms.length > 1 && de.randomization && !/aucun/i.test(de.randomization);
    const exp = flagged ? arms.filter((a) => !a.control) : randomized ? arms.slice(0, 1) : arms;
    const partial = exp.length < arms.length;
    const label = partial ? "Copier le traitement expérimental" : exp.length > 1 ? "Copier les schémas" : "Copier le schéma";
    const text = () => [r.acronym + (partial ? " : traitement expérimental" : exp.length > 1 ? " : schémas thérapeutiques" : " : schéma thérapeutique")].concat(exp.map((a) =>
      [a.name + (a.n ? ` (n = ${a.n})` : "")].concat(a.regimen.map((x) => "- " + [x.drug, x.dose, x.route, x.schedule, x.duration].filter((v) => v && v !== "—").join(", "))).join("\n"))).join("\n\n");
    const copy = button(label, "btn btn-outline ug-copy", async (e) => {
      try { await navigator.clipboard.writeText(text()); e.target.textContent = "Copié"; } catch (x) { e.target.textContent = "Copie impossible"; }
      setTimeout(() => (e.target.textContent = label), 1500);
    });
    const nodes = [wrapEl];
    if (de.treatment_notes) nodes.push(el("p", "kt-rx-note", de.treatment_notes));
    if (de.sources_note) nodes.push(el("p", "muted kt-stamp", de.sources_note));
    nodes.push(copy);
    const s = section("Traitements de l'étude", ...nodes);
    s.classList.add("kt-rx-section");
    return s;
  }

  // Courbe de survie reconstruite : interpolation exponentielle entre les points publiés (médianes, taux à date fixe)
  function survival(points) {
    const pts = [[0, 100]].concat([...points].sort((a, b) => a[0] - b[0])).filter((p, i, a) => !i || p[0] > a[i - 1][0]);
    const last = pts[pts.length - 1], prev = pts[pts.length - 2];
    const tailRate = Math.log(prev[1] / Math.max(last[1], 0.01)) / (last[0] - prev[0]);
    const at = (t) => {
      for (let i = 1; i < pts.length; i++) {
        const [t0, s0] = pts[i - 1], [t1, s1] = pts[i];
        if (t <= t1) return s0 * Math.pow(Math.max(s1, 0.01) / s0, (t - t0) / (t1 - t0));
      }
      return last[1] * Math.exp(-tailRate * (t - last[0]));
    };
    return { at, end: last[0], pts: pts.slice(1) };
  }

  // Courbes de survie. Deux cas :
  // - digitized : points relevés sur la figure publiée (pas mensuel), tracés en escalier, avec les effectifs à risque ;
  // - sinon : reconstruction à partir des seules valeurs publiées (médianes, taux), extrapolée en pointillés.
  function kmFigure(k, W) {
    const arms = (k.arms || []).filter((a) => (a.points || []).length);
    if (!arms.length) return null;
    const digitized = !!k.digitized;
    const curves = digitized ? null : arms.map((a) => survival(a.points));
    const ends = arms.map((a, i) => (digitized ? a.points[a.points.length - 1][0] : curves[i].end));
    const xmax = k.xmax || Math.ceil(Math.max(...ends) * 1.3 / 6) * 6;
    const risk = digitized && k.atrisk && (k.atrisk.times || []).length ? k.atrisk : null;
    const L = 40, R = 12, T = 14, B = 40;
    const plotH = Math.round(W * 0.56);
    const riskH = risk ? 22 + arms.length * 16 : 0;
    const H = plotH + riskH;
    const x = (t) => L + (t / xmax) * (W - L - R);
    const y = (s) => T + (1 - s / 100) * (plotH - T - B);
    const g = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "kt-svg kt-km", role: "img", "aria-label": `${k.label} : courbes ${digitized ? "digitalisées" : "reconstruites"}` });
    for (const s of [0, 25, 50, 75, 100]) {
      g.append(svg("line", { x1: L, x2: W - R, y1: y(s), y2: y(s), class: s === 50 ? "kt-grid mid" : "kt-grid" }));
      g.append(svg("text", { x: L - 6, y: y(s) + 4, class: "kt-tick", "text-anchor": "end" }, s));
    }
    const ticks = risk ? risk.times.filter((t, i) => risk.times.length <= 13 || i % 2 === 0) : [];
    const step = xmax <= 24 ? 3 : xmax <= 36 ? 6 : 12;
    const xt = ticks.length ? ticks : Array.from({ length: Math.floor(xmax / step) + 1 }, (_, i) => i * step);
    for (const t of xt) g.append(svg("text", { x: x(t), y: plotH - B + 16, class: "kt-tick", "text-anchor": "middle" }, t));
    g.append(svg("line", { x1: L, x2: W - R, y1: y(0), y2: y(0), class: "kt-axis-line" }));
    g.append(svg("line", { x1: L, x2: L, y1: T, y2: y(0), class: "kt-axis-line" }));
    g.append(svg("text", { x: (L + W - R) / 2, y: plotH - 6, class: "kt-axis", "text-anchor": "middle" }, "Mois"));
    const dt = xmax / 90;
    const path = (c, from, to) => {
      let d = `M${x(from).toFixed(1)},${y(c.at(from)).toFixed(1)}`;
      for (let t = from + dt; t < to + dt / 2; t += dt) d += `H${x(Math.min(t, to)).toFixed(1)}V${y(c.at(Math.min(t, to))).toFixed(1)}`;
      return d;
    };
    const stairs = (pts) => {
      let d = `M${x(0).toFixed(1)},${y(100).toFixed(1)}`;
      for (const [t, s] of pts) if (t <= xmax) d += `H${x(t).toFixed(1)}V${y(s).toFixed(1)}`;
      return d;
    };
    const dot = (i, t, s, label) => {
      const c = svg("circle", { cx: x(t), cy: y(s), r: 3.5, class: "kt-dot " + ARM[i % 3] });
      c.append(svg("title", null, `${arms[i].arm} : ${num(s)} % à ${num(t)} mois${label ? " (" + label + ")" : ""}`));
      g.append(c);
    };
    arms.forEach((a, i) => {
      if (digitized) {
        g.append(svg("path", { d: stairs(a.points), class: "kt-curve " + ARM[i % 3] }));
        if (typeof a.median === "number" && a.median <= xmax) g.append(svg("line", { x1: x(a.median), x2: x(a.median), y1: y(50), y2: y(0), class: "kt-median " + ARM[i % 3] }));
        for (const [t, s] of a.marks || []) dot(i, t, s, "valeur publiée");
        return;
      }
      const c = curves[i], end = Math.min(c.end, xmax);
      g.append(svg("path", { d: path(c, 0, end), class: "kt-curve " + ARM[i % 3] }));
      if (end < xmax) g.append(svg("path", { d: path(c, end, xmax), class: "kt-curve extra " + ARM[i % 3] }));
      for (const [t, s] of c.pts) {
        if (s === 50) g.append(svg("line", { x1: x(t), x2: x(t), y1: y(50), y2: y(0), class: "kt-median " + ARM[i % 3] }));
        dot(i, t, s);
      }
    });
    if (k.hr) g.append(svg("text", { x: W - R - 4, y: T + 14, class: "kt-val", "text-anchor": "end" }, k.hr));
    if (risk) {
      const top = plotH + 4;
      g.append(svg("text", { x: 0, y: top + 10, class: "kt-axis" }, "Patients à risque"));
      arms.forEach((a, i) => {
        const yy = top + 26 + i * 16;
        g.append(svg("rect", { x: 0, y: yy - 9, width: 14, height: 4, class: "kt-risk-swatch " + ARM[i % 3] }));
        (risk.counts[i] || []).forEach((n, j) => {
          const t = risk.times[j];
          if (n == null || t > xmax || !ticks.includes(t)) return;
          g.append(svg("text", { x: x(t), y: yy - 4, class: "kt-tick kt-risk", "text-anchor": "middle" }, n));
        });
      });
    }
    const legend = el("ul", "kt-legend");
    arms.forEach((a, i) => {
      const li = el("li", ARM[i % 3]);
      let m;
      if (digitized) m = typeof a.median === "number" ? "médiane " + med(a.median) + " mois" : "médiane non atteinte";
      else { const p = (a.points || []).find((q) => q[1] === 50); m = p ? "médiane " + med(p[0]) + " mois" : "médiane non publiée"; }
      li.append(el("span", "kt-swatch"), `${a.arm} · ${m}`);
      legend.append(li);
    });
    const f = el("figure", "kt-fig kt-km-fig");
    const cap = el("figcaption");
    cap.append(digitized
      ? `Courbe digitalisée à partir de la figure publiée : ${k.source}. Points : valeurs publiées ; précision de la digitalisation ±1-2 points.`
      : `Courbe reconstruite à partir des valeurs publiées (points) : ${k.source}. Pointillés : extrapolation à risque constant. Ne remplace pas la figure originale.`);
    f.append(el("p", "kt-km-title", `${EP[k.ep] || k.ep} · ${k.label}`), g, legend, cap);
    return f;
  }

  // Forest plot en échelle logarithmique
  function forestPlot(outs) {
    const rows = outs.filter((o) => o.hr != null && o.lo != null && o.hi != null);
    if (!rows.length) return null;
    const W = 640, rowH = 34, top = 10, left = 230, right = 120, H = top + rows.length * rowH + 48;
    const min = Math.min(0.05, ...rows.map((o) => o.lo)), max = Math.max(1.5, ...rows.map((o) => o.hi));
    const x = (v) => left + (Math.log(v) - Math.log(min)) / (Math.log(max) - Math.log(min)) * (W - left - right);
    const g = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "kt-svg", role: "img", "aria-label": "Forest plot des hazard ratios" });
    g.append(svg("line", { x1: x(1), x2: x(1), y1: top - 4, y2: H - 40, class: "kt-ref" }));
    rows.forEach((o, i) => {
      const y = top + i * rowH + rowH / 2;
      const lbl = `${EP[o.ep] || o.ep} · ${o.label}`;
      g.append(svg("text", { x: 0, y: y + 4, class: "kt-lbl" }, lbl.length > 36 ? lbl.slice(0, 35) + "…" : lbl));
      g.append(svg("line", { x1: x(o.lo), x2: x(o.hi), y1: y, y2: y, class: "kt-ci" }));
      g.append(svg("rect", { x: x(o.hr) - 5, y: y - 5, width: 10, height: 10, class: "kt-hr" }));
      g.append(svg("text", { x: W - right + 8, y: y + 4, class: "kt-val" }, `${hr(o.hr)} (${hr(o.lo)}–${hr(o.hi)})`));
    });
    for (const t of [0.1, 0.25, 0.5, 1].filter((v) => v >= min && v <= max)) {
      g.append(svg("text", { x: x(t), y: H - 26, class: "kt-tick", "text-anchor": "middle" }, num(t)));
    }
    g.append(svg("text", { x: x(1) - 6, y: H - 6, class: "kt-axis", "text-anchor": "end" }, "← favorise le bras expérimental"));
    return g;
  }

  // Barres horizontales (médianes en mois ou taux en %)
  function bars(items, unit, fixedMax) {
    const W = 640, rowH = 30, left = 230, H = items.length * rowH + 8;
    const max = fixedMax || Math.max(...items.map((i) => i.value || 0)) * 1.15 || 1;
    const g = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "kt-svg", role: "img", "aria-label": items.map((i) => `${i.label} ${i.nr ? "non atteinte" : i.value + " " + unit}`).join(", ") });
    items.forEach((it, i) => {
      const y = 4 + i * rowH;
      const w = it.nr ? (W - left - 90) : Math.max(2, (it.value / max) * (W - left - 90));
      g.append(svg("text", { x: 0, y: y + 17, class: "kt-lbl" }, it.label.length > 34 ? it.label.slice(0, 33) + "…" : it.label));
      g.append(svg("rect", { x: left, y: y + 3, width: w, height: 20, class: "kt-bar" + (i === 0 ? " first" : "") + (it.nr ? " nr" : "") }));
      g.append(svg("text", { x: left + w + 6, y: y + 18, class: "kt-val" }, it.nr ? "non atteinte" : `${unit === "mois" ? med(it.value) : num(it.value)} ${unit}`));
    });
    return g;
  }

  // ----- Administration -----
  const EDITABLE = ["slug", "acronym", "title", "clinic", "diagnosis", "markers", "lines", "drugs", "phase", "design", "outcomes", "km", "safety", "ae", "summary", "strengths", "limitations", "practice", "practice_text", "refs"];
  const TEMPLATE = {
    slug: "nom-de-l-etude", acronym: "NOM", title: "Traitement A vs traitement B, population", clinic: "Thoracique", diagnosis: "", markers: "", lines: ["1L"], drugs: "",
    phase: "Phase III",
    design: {
      population: "", inclusion: ["Critère 1", "Critère 2"], randomization: "1:1", stratification: "", primary: "", secondary: "",
      arms: [{ name: "Bras A", n: null, regimen: [{ drug: "", dose: "", route: "IV", schedule: "J1, toutes les 3 semaines", duration: "" }] },
             { name: "Bras B", n: null, regimen: [{ drug: "", dose: "", route: "IV", schedule: "", duration: "" }] }],
      treatment_notes: ""
    },
    outcomes: [{ ep: "OS", label: "Survie globale", hr: null, lo: null, hi: null, p: null, arms: [{ arm: "Bras A", median: null, rate: null }, { arm: "Bras B", median: null, rate: null }] }],
    km: [{ ep: "OS", label: "Survie globale", source: "Médianes et taux publiés : auteur année", hr: "HR 0,00 (0,00–0,00)", xmax: 36,
           arms: [{ arm: "Bras A", points: [[10.5, 50], [24, 22]] }, { arm: "Bras B", points: [[7.0, 50], [24, 12]] }] }],
    safety: "", ae: { arms: ["Bras A", "Bras B"], grade: "Grade ≥ 3", rows: [["Nausées", 30, 1.5, 25, 1.0]], source: "Source : publication, tableau X" },
    summary: "", strengths: "", limitations: "", practice: "oui", practice_text: "", refs: [{ label: "", pmid: "", doi: "", journal: "", year: null }]
  };

  function adminBar(r) {
    const bar = el("div", "btn-row kt-admin");
    bar.append(button("Modifier", "btn btn-outline ug-copy", () => edit(r)));
    bar.append(button(r.status === "draft" ? "Publier" : "Repasser en brouillon", "btn ug-copy", () => patch(r, { status: r.status === "draft" ? "published" : "draft" })));
    bar.append(button("Marquer comme relu par moi", "btn btn-outline ug-copy", () => patch(r, { reviewed_by: state.me, reviewed_at: new Date().toISOString().slice(0, 10) })));
    bar.append(button("Dupliquer", "btn btn-outline ug-copy", () => edit(null, Object.assign(pick(r), { slug: r.slug + "-copie" }))));
    bar.append(button("Supprimer", "btn btn-outline ug-copy lt-danger", async () => {
      if (!confirm(`Supprimer la fiche ${r.acronym} ?`)) return;
      const { error } = await sb.from("key_trials").delete().eq("id", r.id);
      if (error) return alert("Suppression refusée : " + error.message);
      await refresh();
    }));
    return bar;
  }

  const pick = (r) => Object.fromEntries(EDITABLE.map((k) => [k, r[k] == null ? (k === "lines" ? [] : null) : r[k]]));

  async function patch(r, values) {
    const { error } = await sb.from("key_trials").update(values).eq("id", r.id);
    if (error) return alert("Enregistrement refusé : " + error.message);
    await refresh(r.slug);
  }

  function edit(r, preset) {
    state.editing = r;
    $("kt-form-title").textContent = r ? `Modifier ${r.acronym}` : "Nouvelle fiche";
    $("kt-json").value = JSON.stringify(r ? pick(r) : (preset || TEMPLATE), null, 2);
    $("kt-form-msg").textContent = "";
    $("kt-dialog").showModal();
  }

  async function save(e) {
    e.preventDefault();
    const out = $("kt-form-msg");
    const err = (t) => { out.className = "form-msg error"; out.textContent = t; };
    let rec;
    try { rec = JSON.parse($("kt-json").value); } catch (x) { return err("JSON invalide : " + x.message); }
    rec = Object.fromEntries(Object.entries(rec).filter(([k]) => EDITABLE.includes(k)));
    if (!/^[a-z0-9-]{2,60}$/.test(rec.slug || "")) return err("slug : lettres minuscules, chiffres et tirets.");
    if (!rec.acronym || !rec.title) return err("acronym et title sont obligatoires.");
    if (rec.lines && !rec.lines.every((l) => LINE_LABEL[l])) return err("lines : valeurs autorisées neoadj, adj, 1L, 2L, 3L.");
    if (rec.practice && !PRACTICE[rec.practice]) return err("practice : oui, partiel ou non.");
    if (rec.km != null && !(Array.isArray(rec.km) && rec.km.every((k) => Array.isArray(k.arms) && k.arms.every((a) => Array.isArray(a.points) && a.points.every((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite) && p[1] >= 0 && p[1] <= 100)))))
      return err("km : liste de courbes { ep, label, source, arms: [{ arm, points: [[mois, %], …] }] }, % entre 0 et 100.");
    if (rec.km == null) rec.km = [];
    if (rec.ae != null && !(typeof rec.ae === "object" && !Array.isArray(rec.ae) && Array.isArray(rec.ae.arms || []) && (rec.ae.rows || []).every((x) => Array.isArray(x) && typeof x[0] === "string" && x.length === 1 + 2 * (rec.ae.arms || []).length)))
      return err("ae : { arms: [noms des bras], rows: [[effet, tous grades bras 1, grade ≥ 3 bras 1, …]] } ; deux valeurs par bras.");
    if (rec.ae == null) rec.ae = {};
    out.className = "form-msg"; out.textContent = "Enregistrement…";
    const q = state.editing ? sb.from("key_trials").update(rec).eq("id", state.editing.id) : sb.from("key_trials").insert(Object.assign(rec, { status: "draft" }));
    const { error } = await q;
    if (error) return err(error.code === "23505" ? "Ce slug existe déjà." : "Refusé : " + error.message);
    $("kt-dialog").close();
    await refresh(rec.slug);
  }

  async function refresh(openSlug) {
    await load();
    setupFilters();
    search();
    if (openSlug) {
      const d = document.getElementById("trial-" + openSlug);
      if (d) { d.open = true; d.scrollIntoView({ behavior: "smooth", block: "start" }); }
    }
  }

  // ----- Filtres -----
  function setupFilters() {
    const sel = $("f-clinic");
    const count = (c) => state.rows.filter((r) => norm(r.clinic) === norm(c)).length;
    const first = el("option", null, `Toutes les cliniques (${state.rows.length})`);
    first.value = "";
    sel.replaceChildren(first, ...BLOCS.map(([bloc, list]) => {
      const g = el("optgroup"); g.label = bloc;
      g.append(...list.map((c) => { const o = el("option", null, `${c} (${count(c)})`); o.value = norm(c); o.disabled = !count(c); return o; }));
      return g;
    }));
    sel.value = state.clinic;
    const box = $("ug-lines");
    const make = (v, label) => {
      const b = button(label, "ug-chip", () => { state.line = state.line === v ? "" : v; setupFilters(); search(); });
      b.setAttribute("aria-pressed", String(state.line === v));
      return b;
    };
    box.replaceChildren(make("", "Toutes lignes"), ...LINES.map(([v, l]) => make(v, l)));
    const fill = (id, values) => $(id).replaceChildren(...[...new Set(values)].sort().map((v) => { const o = el("option"); o.value = v; return o; }));
    fill("dx-list", state.rows.map((r) => r.diagnosis).filter(Boolean));
    fill("mk-list", state.rows.flatMap((r) => (r.markers || "").split(";").map((m) => m.trim())).filter(Boolean));
  }

  // ----- Démarrage -----
  (async () => {
    if (!sb) return ($("ug-status").textContent = "Service indisponible.");
    const { data } = await sb.auth.getSession();
    if (!data.session) return (location.href = "/fr/the-hive.html");
    $("logout").addEventListener("click", async () => { await sb.auth.signOut(); location.href = "/fr/"; });
    const { data: profile } = await sb.from("profiles").select("role, full_name, first_name, last_name").eq("id", data.session.user.id).single();
    const role = profile ? profile.role : "member";
    const { data: canUse } = await sb.rpc("has_tool", { p_tool: "trials" });
    if (role !== "admin" && canUse !== true) return ($("ug-status").textContent = "Cet outil ne fait pas partie de vos accès. Contactez l'administrateur si besoin.");
    state.admin = role === "admin";
    state.me = [profile.first_name, profile.last_name].filter(Boolean).join(" ") || profile.full_name || data.session.user.email;
    try { await load(); } catch (e) { return ($("ug-status").textContent = "Chargement impossible : " + e.message); }
    if (!state.rows.length && !state.admin) return ($("ug-status").textContent = "Les premières fiches sont en cours de relecture.");
    $("ug-status").hidden = true;
    $("ug-tool").hidden = false;
    if (state.admin) {
      $("kt-new").hidden = false;
      $("kt-new").addEventListener("click", () => edit(null));
      $("kt-form").addEventListener("submit", save);
      $("kt-cancel").addEventListener("click", () => $("kt-dialog").close());
    }
    for (const id of ["q", "f-dx", "f-mk"]) $(id).addEventListener("input", search);
    $("f-clinic").addEventListener("change", (e) => { state.clinic = e.target.value; search(); });
    setupFilters();
    search();
    const slug = new URLSearchParams(location.search).get("t");
    if (slug) { const d = document.getElementById("trial-" + slug); if (d) { d.open = true; d.scrollIntoView(); } }
  })();
})();
