// Key trials : une fiche par étude clé, recherchable par clinique, diagnostic, drivers et ligne.
// Les graphiques (forest plot des HR, médianes, taux) sont générés à partir des chiffres de la fiche.
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

    // Design
    const de = r.design || {};
    const dl = el("dl", "ug-dl kt-design");
    const fact = (k, v) => { if (v) dl.append(el("dt", null, k), el("dd", null, v)); };
    fact("Type", r.phase);
    fact("Population", de.population);
    fact("Randomisation", de.randomization);
    const n = (de.arms || []).reduce((s, a) => s + (a.n || 0), 0) || de.total;
    fact("Bras", (de.arms || []).map((a) => a.name + (a.n ? ` (n = ${a.n})` : "")).join(" vs ") + (n ? ` · total ${n}` : ""));
    fact("Critère principal", de.primary);
    fact("Remarques", de.notes);
    fact("Traitements", r.drugs && r.drugs.split(";").map((x) => x.trim()).join(", "));
    b.append(section("Design", dl));

    // Résultats : graphiques + tableau
    const outs = r.outcomes || [];
    const charts = el("div", "kt-charts");
    const forest = forestPlot(outs);
    if (forest) { const f = figure("Hazard ratios (IC)", forest); f.classList.add("wide"); charts.append(f); }
    for (const o of outs) {
      const med = (o.arms || []).filter((a) => a.median != null || a.nr);
      if (med.length) charts.append(figure(`${o.label} : médianes${o.timepoint ? " · " + o.timepoint : ""}`, bars(med.map((a) => ({ label: a.arm, value: a.median, nr: a.nr })), "mois")));
      const rates = (o.arms || []).filter((a) => a.rate != null);
      if (rates.length) charts.append(figure(`${o.label}${o.note ? " · " + o.note.toLowerCase() : o.timepoint ? " · " + o.timepoint : ""}`, bars(rates.map((a) => ({ label: a.arm, value: a.rate })), "%", 100)));
    }
    b.append(section("Résultats", charts, table(outs)));
    if (r.safety) b.append(section("Tolérance", el("p", null, r.safety)));

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
  const EDITABLE = ["slug", "acronym", "title", "clinic", "diagnosis", "markers", "lines", "drugs", "phase", "design", "outcomes", "safety", "summary", "strengths", "limitations", "practice", "practice_text", "refs"];
  const TEMPLATE = {
    slug: "nom-de-l-etude", acronym: "NOM", title: "Traitement A vs traitement B, population", clinic: "Thoracique", diagnosis: "", markers: "", lines: ["1L"], drugs: "",
    phase: "Phase III", design: { population: "", randomization: "1:1", arms: [{ name: "Bras A", n: null }, { name: "Bras B", n: null }], primary: "" },
    outcomes: [{ ep: "OS", label: "Survie globale", hr: null, lo: null, hi: null, p: null, arms: [{ arm: "Bras A", median: null, rate: null }, { arm: "Bras B", median: null, rate: null }] }],
    safety: "", summary: "", strengths: "", limitations: "", practice: "oui", practice_text: "", refs: [{ label: "", pmid: "", doi: "", journal: "", year: null }]
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
    if (!["admin", "clinician", "assistant"].includes(role)) return ($("ug-status").textContent = "Cet espace est réservé aux membres validés de The Hive.");
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
