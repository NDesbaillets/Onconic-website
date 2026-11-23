// Circuits de validation des absences : constructeur visuel (colonnes d'étapes simultanées), circuits alternatifs, simulateur et journal.
// Modification réservée à l'administration et à la direction (contrôlé aussi en base) ; les médecins cadres consultent le circuit en lecture seule
// (les fonctions d'écriture refusent leurs appels). Les validateurs restent désignés par clinique dans /admin/absences.html ; cette page règle les étapes, leur ordre et leurs conditions.
(function () {
  const cfg = window.ONCONIC_CONFIG || {};
  const sb = window.supabase && cfg.supabaseUrl ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey) : null;
  const $ = (id) => document.getElementById(id);
  const CV = window.CircuitView;
  const ROLES = { clinician: "médecin assistant", cdc: "CDC", cadre: "médecin cadre", direction: "direction", admin: "admin", assistant: "assistante", nurse: "infirmier·ère", pharmacist: "pharmacien·ne" };
  const KINDS = [["vacances", "vacances"], ["congres", "congrès"], ["autre", "autre"]];
  const KIND_NAME = { vacances: "vacances", congres: "congrès", autre: "autre" };
  const TYPE_NAME = { preavis: "Pré-avis", clinique: "Validateurs de clinique", visa: "Visa de la direction", personnes: "Personnes désignées", direction: "Direction", groupe: "Groupe par rôle" };
  const TYPE_TAG = { preavis: "pré-avis", clinique: "clinique", visa: "visa", personnes: "personnes", direction: "direction", groupe: "groupe" };
  // Types proposés dans la palette ; les types uniques sont grisés quand ils figurent déjà dans le circuit
  const PALETTE = [
    { kind: "clinique", title: "Validateurs de clinique", sub: "désignés par clinique ; une seule par circuit", unique: true },
    { kind: "direction", title: "Direction", sub: "membres de la direction ; plusieurs possibles", unique: false },
    { kind: "visa", title: "Visa de la direction", sub: "signe le PDF ; un seul par circuit", unique: true },
    { kind: "personnes", title: "Personnes désignées", sub: "choisies une à une", unique: false },
    { kind: "groupe", title: "Groupe par rôle", sub: "tous les membres d'un ou plusieurs rôles", unique: false },
  ];

  function el(tag, cls, txt) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }
  const pill = (txt, cls) => el("span", "cc-pill" + (cls ? " " + cls : ""), txt);
  const REASONS = CV.REASONS;
  const ROLE_CODES = ["clinician", "cdc", "cadre", "assistant", "pharmacist", "admin", "direction", "nurse"];
  const state = { overview: null, pre: null, cols: [], orig: "", circuits: [], sel: null, detail: null, assign: { member: new Set(), role: new Set(), clinic: new Set() }, assignOrig: "", who: [], req: 0, selected: null, drag: null, ro: false };
  const current = () => state.circuits.find((c) => c.id === state.sel) || state.circuits[0] || { id: null, name: "", is_default: true };
  const plural = (n, one, many) => n + " " + (n > 1 ? many : one);

  // ----- Avertissements et cliniques -----
  function warnings(o) {
    const box = $("cc-warn");
    const list = o.warnings || [];
    $("cc-warn-count").textContent = "(" + list.length + ")";
    $("cc-warn-box").classList.toggle("has", list.length > 0);
    if (!list.length) return box.replaceChildren(el("p", "cc-hint", "Aucun problème de configuration"));
    const ul = el("ul");
    for (const w of list) ul.append(el("li", null, w));
    box.replaceChildren(ul);
  }

  function table(o) {
    const t = $("cc-table");
    $("cc-clinics-count").textContent = "(" + (o.clinics || []).length + ")";
    const head = el("tr");
    for (const h of ["Clinique", "Membres", "Validateurs", "Les demandes vont à"]) head.append(el("th", null, h));
    const thead = el("thead"); thead.append(head);
    const body = el("tbody");
    for (const c of o.clinics || []) {
      const tr = el("tr");
      tr.append(el("td", null, c.clinic), el("td", null, String(c.members)));
      const v = el("td");
      if (!(c.validators || []).length) v.append(el("span", "muted", "Aucun"));
      for (const x of c.validators || []) {
        const p = pill(x.name + (x.role === "direction" ? " (direction)" : ""), x.active ? "" : "off");
        if (!x.active) p.title = x.reason;
        v.append(p);
        if (!x.active) v.append(el("span", "cc-reason", "(" + x.reason + ") "));
      }
      tr.append(v);
      tr.append(el("td", c.goes_to === "validators" ? "" : "amber", c.goes_to === "validators" ? "Validateurs (" + c.active_count + ")" : "Directement au visa"));
      body.append(tr);
    }
    t.replaceChildren(thead, body);
  }

  // ----- Modèle d'édition : pré-avis à part, puis colonnes d'étapes simultanées -----
  function mk(s) {
    const kind = s.kind;
    return {
      kind, label: s.label || TYPE_NAME[kind] || "", rule: kind === "visa" ? "any" : s.rule === "any" ? "any" : "all",
      blocking: kind === "preavis" ? false : kind === "visa" ? true : !!s.blocking, active: !!s.active,
      persons: (s.persons || []).map((p) => (typeof p === "string" ? p : p.id)),
      roles: Array.isArray(s.roles) ? [...s.roles] : [], scope: s.scope === "all" ? "all" : "clinic",
      kinds: Array.isArray(s.kinds) && s.kinds.length ? [...s.kinds] : null, min_days: s.min_days || null, pdf_slot: s.pdf_slot || null,
      on_demand: (kind === "personnes" || kind === "groupe") && !!s.on_demand,
    };
  }
  function newStep(kind) {
    const base = { kind, label: TYPE_NAME[kind], rule: kind === "visa" || kind === "direction" ? "any" : "all", blocking: true, active: kind === "clinique" || kind === "direction" || kind === "visa" };
    if (kind === "preavis") { base.label = "Pré-avis de la direction"; base.blocking = false; base.active = true; base.rule = "all"; }
    return mk(base);
  }
  const colOf = (s) => (s.col != null && s.col !== "" ? Number(s.col) : s.pos);
  function load(steps) {
    const list = [...(steps || [])].sort((a, b) => a.pos - b.pos);
    const pre = list.find((s) => s.kind === "preavis");
    state.pre = pre ? mk(pre) : null;
    const groups = new Map();
    for (const s of list) {
      if (s.kind === "preavis") continue;
      const c = colOf(s);
      if (!groups.has(c)) groups.set(c, []);
      groups.get(c).push(mk(s));
    }
    state.cols = [...groups.entries()].sort((a, b) => a[0] - b[0]).map((g) => g[1]);
    state.selected = null;
  }
  const snapshot = () => JSON.stringify({ pre: state.pre, cols: state.cols });
  function cleanCols() { state.cols = state.cols.filter((c) => c.length); }
  const allSteps = () => state.cols.flat();
  function locate(s) {
    for (let i = 0; i < state.cols.length; i++) { const j = state.cols[i].indexOf(s); if (j >= 0) return [i, j]; }
    return [-1, -1];
  }
  // Colonnes numérotées 10, 20… dans l'ordre affiché, positions qui suivent. Lève une erreur lisible si une étape est incomplète.
  function serialize() {
    const out = [];
    const wire = (s, col, pos) => {
      const label = String(s.label || "").trim();
      if (!label) throw new Error("Chaque étape doit avoir un libellé.");
      if (s.kinds && !s.kinds.length) throw new Error("Étape « " + label + " » : cochez au moins un motif.");
      if (s.min_days != null && !(Number.isInteger(s.min_days) && s.min_days >= 1 && s.min_days <= 365)) throw new Error("Étape « " + label + " » : la durée minimale va de 1 à 365 jours ouvrables.");
      if (s.kind === "groupe" && s.active && !s.roles.length) throw new Error("Étape « " + label + " » : cochez au moins un rôle.");
      if (s.on_demand) {
        // étape sur décision de la direction : dans une colonne après celle du visa (le visa doit être actif)
        const vi = state.cols.filter((c) => c.length).findIndex((c) => c.some((x) => x.kind === "visa" && x.active));
        if (vi < 0 || !(col / 10 - 1 > vi)) throw new Error("Étape « " + label + " » : « sur décision de la direction » demande une colonne après celle du visa de la direction (visa actif).");
      }
      const o = {
        pos, col, kind: s.kind, label, rule: s.kind === "visa" ? "any" : s.rule, blocking: s.kind === "preavis" ? false : s.kind === "visa" ? true : s.blocking, active: s.active,
        persons: s.kind === "personnes" ? s.persons : [], kinds: s.kinds && s.kinds.length < 3 ? s.kinds : null, min_days: s.min_days,
        pdf_slot: s.kind === "personnes" || s.kind === "direction" ? s.pdf_slot : null,
        on_demand: !!s.on_demand && (s.kind === "personnes" || s.kind === "groupe"),
      };
      if (o.on_demand) o.blocking = true;
      if (s.kind === "groupe") { o.roles = s.roles; o.scope = s.scope; }
      return o;
    };
    if (state.pre) out.push(wire(state.pre, 0, 0));
    let pos = 0;
    state.cols.filter((c) => c.length).forEach((c, i) => c.forEach((s) => out.push(wire(s, 10 * (i + 1), (pos += 10)))));
    return out;
  }
  function dirty() {
    const d = snapshot() !== state.orig;
    $("cc-dirty").hidden = !d;
    $("cc-save").disabled = !d; $("cc-cancel").disabled = !d;
  }
  function say(id, txt, kind) { const m = $(id); m.className = "form-msg" + (kind ? " " + kind : ""); m.textContent = txt || ""; }
  function changed() { renderBuilder(); dirty(); }

  // ----- Constructeur : rendu -----
  function memberName(id) {
    const m = ((state.overview && state.overview.members) || []).find((x) => x.id === id);
    if (m) return m.name;
    for (const st of (state.detail && state.detail.steps) || []) for (const p of st.persons || []) if (p.id === id) return p.name || id;
    return id;
  }
  function memberLabel(m) { return m.name + " · " + (ROLES[m.role] || m.role) + (m.clinics && m.clinics.length ? " · " + m.clinics.join(", ") : ""); }
  function shortList(list) {
    if (!list.length) return "";
    return list.slice(0, 3).join(", ") + (list.length > 3 ? " +" + (list.length - 3) : "");
  }
  function directionNames() { return ((state.overview && state.overview.direction) || []).filter((d) => d.has_tool).map((d) => d.name); }
  function whoLine(s) {
    if (s.kind === "clinique") return "Validateurs désignés par clinique";
    if (s.kind === "direction" || s.kind === "visa") return directionNames().length ? "Direction : " + shortList(directionNames()) : "Aucun membre de la direction";
    if (s.kind === "personnes") return s.persons.length ? shortList(s.persons.map(memberName)) : s.on_demand ? "Aucune personne désignée : l'envoi restera impossible" : "Aucune personne désignée";
    if (s.kind === "groupe") return (s.roles.length ? shortList(s.roles.map((r) => ROLES[r] || r)) : "Aucun rôle") + " · " + (s.scope === "all" ? "tout le service" : "même clinique");
    return "";
  }
  function condPills(s) {
    const out = [];
    if (Array.isArray(s.kinds) && s.kinds.length && s.kinds.length < 3) out.push(s.kinds.map((k) => KIND_NAME[k] || k).join(", "));
    if (s.min_days) out.push("≥" + s.min_days + " j");
    return out;
  }
  function card(s) {
    const c = el("div", "cc-card k-" + s.kind + (s.active ? "" : " inactive") + (s.blocking ? "" : " soft") + (s.on_demand ? " od" : "") + (state.selected === s ? " selected" : ""));
    c.tabIndex = 0; c.draggable = !state.ro; c.setAttribute("role", "button");
    c.setAttribute("aria-label", "Étape « " + s.label + " » (" + TYPE_TAG[s.kind] + (s.active ? "" : ", désactivée") + ") : " + (state.ro ? "voir les réglages" : "ouvrir les réglages"));
    const top = el("div", "cc-card-top");
    top.append(el("span", "cc-tag", TYPE_TAG[s.kind]), el("span", "cc-card-label", s.label));
    c.append(top);
    const pills = el("div", "cc-pills");
    if (s.kind !== "visa") pills.append(pill(s.rule === "any" ? "un seul" : "tous"));
    if (!s.blocking) pills.append(pill("consultatif", "dash"));
    if (s.on_demand) pills.append(pill("sur décision de la direction", "dash"));
    for (const t of condPills(s)) pills.append(pill(t, "cond"));
    if (s.pdf_slot === "chef_service") pills.append(pill("PDF", "cond"));
    if (!s.active) pills.append(pill("désactivée", "off"));
    c.append(pills);
    const who = whoLine(s);
    if (who) c.append(el("div", "cc-card-who", who));
    c.addEventListener("click", () => openPanel(s));
    c.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); openPanel(s); } });
    if (state.ro) return c;
    c.addEventListener("dragstart", (ev) => {
      state.drag = s;
      try { ev.dataTransfer.setData("text/plain", "etape"); ev.dataTransfer.effectAllowed = "move"; } catch (e) { /* navigateurs restrictifs */ }
      c.classList.add("dragging");
      $("cc-builder").classList.add("dragging");
    });
    c.addEventListener("dragend", () => { state.drag = null; c.classList.remove("dragging"); $("cc-builder").classList.remove("dragging"); clearOver(); });
    c.addEventListener("dragover", (ev) => { if (!state.drag || state.drag === s) return; ev.preventDefault(); ev.stopPropagation(); clearOver(); c.classList.add("over-before"); });
    c.addEventListener("drop", (ev) => { ev.preventDefault(); ev.stopPropagation(); const d = state.drag; clearOver(); if (d && d !== s) moveTo(d, { before: s }); });
    return c;
  }
  function clearOver() { for (const e of document.querySelectorAll(".over, .over-before")) e.classList.remove("over", "over-before"); }
  function dropTarget(node, target) {
    node.addEventListener("dragover", (ev) => { if (!state.drag) return; ev.preventDefault(); clearOver(); node.classList.add("over"); });
    node.addEventListener("dragleave", (ev) => { if (!node.contains(ev.relatedTarget)) node.classList.remove("over"); });
    node.addEventListener("drop", (ev) => { ev.preventDefault(); const d = state.drag; clearOver(); if (d) moveTo(d, target()); });
  }
  function gap(i) {
    const g = el("div", "cc-gap" + (i === 0 || i === state.cols.length ? " edge" : ""));
    const b = el("button", "cc-plus", "+"); b.type = "button";
    b.setAttribute("aria-label", i === 0 ? "Ajouter une colonne au début" : i === state.cols.length ? "Ajouter une colonne à la fin" : "Insérer une colonne entre les colonnes " + i + " et " + (i + 1));
    b.addEventListener("click", (ev) => { ev.stopPropagation(); openPalette(b, { gap: i }); });
    g.append(b);
    dropTarget(g, () => ({ gap: i }));
    return g;
  }
  function colEl(col, i) {
    const c = el("div", "cc-col");
    c.setAttribute("role", "group"); c.setAttribute("aria-label", "Colonne " + (i + 1));
    c.append(el("div", "cc-col-head", "Colonne " + (i + 1) + (col.length > 1 ? " · simultanées" : "")));
    const stack = el("div", "cc-stack");
    for (const s of col) stack.append(card(s));
    c.append(stack);
    if (state.ro) return c;
    const add = el("button", "cc-add", "+"); add.type = "button";
    add.setAttribute("aria-label", "Ajouter une étape simultanée dans la colonne " + (i + 1)); add.title = "Ajouter une étape simultanée";
    add.addEventListener("click", (ev) => { ev.stopPropagation(); openPalette(add, { col }); });
    c.append(add);
    dropTarget(c, () => ({ col }));
    return c;
  }
  function renderPre() {
    const box = $("cc-pre");
    const lab = el("label", "cc-switch");
    const cb = el("input"); cb.type = "checkbox"; cb.setAttribute("role", "switch"); cb.checked = !!(state.pre && state.pre.active);
    cb.disabled = state.ro;
    cb.addEventListener("change", () => {
      if (state.ro) return;
      if (!state.pre) state.pre = newStep("preavis");
      state.pre.active = cb.checked;
      renderPre(); dirty();
    });
    lab.append(cb, el("span", "cc-track"), el("span", "cc-switch-text", "Pré-avis de la direction (en parallèle, consultatif)"));
    box.replaceChildren(lab);
    box.classList.toggle("off", !(state.pre && state.pre.active));
    const dn = directionNames();
    box.append(el("span", "cc-pre-who", dn.length ? "Direction : " + shortList(dn) : "Aucun membre de la direction"));
  }
  function renderBuilder() {
    cleanCols();
    const box = $("cc-builder");
    if (state.ro) {
      // lecture seule : colonnes reliées par des flèches fixes, aucun point d'insertion
      const kids = [];
      state.cols.forEach((col, i) => { if (i) kids.push(el("div", "cc-gap sim")); kids.push(colEl(col, i)); });
      box.replaceChildren(...(kids.length ? kids : [el("p", "cc-hint", "Aucune étape dans ce circuit.")]));
    } else if (!state.cols.length) {
      const g = gap(0);
      box.replaceChildren(el("p", "cc-hint", "Aucune étape : ajoutez une première colonne."), g);
    } else {
      const kids = [];
      state.cols.forEach((col, i) => { kids.push(gap(i), colEl(col, i)); });
      kids.push(gap(state.cols.length));
      box.replaceChildren(...kids);
    }
    renderPre();
  }

  // ----- Constructeur : déplacements -----
  // cible : { col: tableau } (à la fin), { before: étape } ou { gap: index } (nouvelle colonne)
  function moveTo(s, target) {
    const [ci, si] = locate(s);
    if (ci < 0) return;
    state.cols[ci].splice(si, 1);
    if (target.gap != null) state.cols.splice(target.gap, 0, [s]);
    else if (target.before) { const [bi, bj] = locate(target.before); state.cols[bi].splice(bj, 0, s); }
    else target.col.push(s);
    state.selected = s;
    changed(); if (state.selected === s && !$("cc-panel").hidden) buildPanel(s);
  }
  function canShift(s, d) {
    const [ci] = locate(s);
    if (ci < 0) return false;
    if (state.cols[ci].length > 1) return true;
    return ci + d >= 0 && ci + d < state.cols.length;
  }
  function shift(s, d) {
    const [ci, si] = locate(s);
    if (!canShift(s, d)) return;
    if (state.cols[ci].length === 1) { const t = state.cols[ci]; state.cols[ci] = state.cols[ci + d]; state.cols[ci + d] = t; }
    else { state.cols[ci].splice(si, 1); state.cols.splice(d < 0 ? ci : ci + 1, 0, [s]); }
    changed(); buildPanel(s);
  }
  function canJoin(s, d) { const [ci] = locate(s); return ci >= 0 && ci + d >= 0 && ci + d < state.cols.length; }
  function join(s, d) {
    const [ci, si] = locate(s);
    if (!canJoin(s, d)) return;
    state.cols[ci].splice(si, 1);
    state.cols[ci + d].push(s);
    changed(); buildPanel(s);
  }

  // ----- Palette -----
  function openPalette(anchor, target) {
    const pal = $("cc-palette");
    const used = new Set(allSteps().map((s) => s.kind));
    pal.replaceChildren(el("div", "cc-pal-title", target.gap != null ? "Nouvelle colonne" : "Étape simultanée"));
    for (const it of PALETTE) {
      const b = el("button", "cc-pal-item"); b.type = "button"; b.setAttribute("role", "menuitem");
      const off = it.unique && used.has(it.kind);
      b.append(el("strong", null, it.title), el("span", null, off ? "déjà présente dans ce circuit" : it.sub));
      if (off) { b.disabled = true; }
      b.addEventListener("click", () => {
        closePalette();
        const s = newStep(it.kind);
        if (target.gap != null) state.cols.splice(target.gap, 0, [s]); else target.col.push(s);
        state.selected = s;
        changed(); openPanel(s);
      });
      pal.append(b);
    }
    pal.hidden = false;
    pal.dataset.anchor = anchor.getAttribute("aria-label");
    const r = anchor.getBoundingClientRect(), w = pal.offsetWidth, h = pal.offsetHeight;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
    const top = r.bottom + 4 + h > window.innerHeight ? Math.max(8, r.top - h - 4) : r.bottom + 4;
    pal.style.left = left + "px"; pal.style.top = top + "px";
    const first = pal.querySelector("button:not(:disabled)");
    if (first) first.focus();
  }
  function closePalette() { $("cc-palette").hidden = true; }

  // ----- Panneau de réglages -----
  function field(label, control, cls) {
    const l = el("label", "cc-field" + (cls ? " " + cls : ""));
    l.append(el("span", null, label), control);
    return l;
  }
  function check(label, checked, onchange) {
    const l = el("label", "cc-check");
    const c = el("input"); c.type = "checkbox"; c.checked = checked;
    c.addEventListener("change", () => onchange(c.checked));
    l.append(c, el("span", null, label));
    return l;
  }
  function personsPicker(s) {
    const box = el("div", "cc-persons");
    const known = new Map();
    for (const m of state.overview.members || []) known.set(m.id, memberLabel(m));
    for (const st of (state.detail && state.detail.steps) || []) for (const p of st.persons || []) if (!known.has(p.id)) known.set(p.id, p.name || p.id);
    if (state.ro) for (const id of [...known.keys()]) if (!s.persons.includes(id)) known.delete(id);
    const filter = el("input"); filter.type = "search"; filter.placeholder = "Filtrer par nom"; filter.setAttribute("aria-label", "Filtrer les personnes");
    const list = el("div", "cc-person-list");
    const rows = [];
    const count = el("span", "cc-hint", plural(s.persons.length, "désignée", "désignées"));
    for (const [id, label] of [...known].sort((a, b) => a[1].localeCompare(b[1], "fr"))) {
      const row = check(label, s.persons.includes(id), (on) => {
        s.persons = on ? [...new Set([...s.persons, id])] : s.persons.filter((x) => x !== id);
        count.textContent = plural(s.persons.length, "désignée", "désignées");
        changed();
      });
      row.dataset.name = label.toLowerCase();
      rows.push(row); list.append(row);
    }
    filter.addEventListener("input", () => { const q = filter.value.trim().toLowerCase(); for (const r of rows) r.hidden = !!q && !r.dataset.name.includes(q); });
    box.append(field("Personnes désignées", filter), count, list);
    return box;
  }
  function openPanel(s) {
    closePalette();
    state.selected = s;
    renderBuilder();
    buildPanel(s);
    $("cc-panel").hidden = false;
    $("cc-tool").classList.add("has-panel");
    $("cc-scrim").hidden = false;
    const cardEl = document.querySelector(".cc-card.selected");
    if (cardEl && cardEl.scrollIntoView) cardEl.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  function closePanel() {
    state.selected = null;
    $("cc-panel").hidden = true; $("cc-scrim").hidden = true;
    $("cc-tool").classList.remove("has-panel");
    renderBuilder();
  }
  function buildPanel(s) {
    const body = $("cc-panel-body");
    $("cc-panel-title").textContent = "Étape : " + TYPE_NAME[s.kind];
    const kids = [];
    const label = el("input"); label.type = "text"; label.maxLength = 80; label.value = s.label; label.setAttribute("aria-label", "Libellé de l'étape");
    label.addEventListener("input", () => { s.label = label.value; changed(); });
    kids.push(field("Libellé", label));
    kids.push(check("Étape active", s.active, (on) => { s.active = on; changed(); }));
    if (s.kind !== "visa") {
      const row = el("div", "cc-row2");
      const rule = el("select");
      for (const [v, t] of [["all", "Tous doivent valider"], ["any", "Un seul suffit"]]) { const o = el("option", null, t); o.value = v; rule.append(o); }
      rule.value = s.rule;
      rule.addEventListener("change", () => { s.rule = rule.value; changed(); });
      const bl = el("select");
      for (const [v, t] of [["1", "Bloquant"], ["0", "Consultatif"]]) { const o = el("option", null, t); o.value = v; bl.append(o); }
      bl.value = s.blocking ? "1" : "0";
      bl.addEventListener("change", () => { s.blocking = bl.value === "1"; changed(); });
      if (s.on_demand) { bl.value = "1"; bl.disabled = true; }
      row.append(field("Règle", rule), field("Type d'avis", bl));
      kids.push(row);
    } else kids.push(el("p", "cc-hint", "Un seul visa suffit ; il est bloquant et signe le formulaire PDF."));

    const cond = el("fieldset", "cc-cond-box");
    cond.append(el("legend", null, "Conditions (vide = toujours)"));
    const kinds = s.kinds || KINDS.map((k) => k[0]);
    const crow = el("div", "cc-checks");
    for (const [k, t] of KINDS) {
      crow.append(check(t, kinds.includes(k), (on) => {
        const cur = new Set(s.kinds || KINDS.map((x) => x[0]));
        if (on) cur.add(k); else cur.delete(k);
        s.kinds = cur.size === 3 ? null : [...cur];
        changed();
      }));
    }
    const md = el("input"); md.type = "number"; md.min = "1"; md.max = "365"; md.step = "1"; md.inputMode = "numeric"; md.placeholder = "toujours"; md.value = s.min_days || "";
    md.addEventListener("input", () => { s.min_days = md.value === "" ? null : Number(md.value); changed(); });
    cond.append(crow, field("À partir de (jours ouvrables)", md));
    kids.push(cond);

    if (s.kind === "personnes" || s.kind === "groupe") {
      kids.push(check("Sur décision de la direction", !!s.on_demand, (on) => { s.on_demand = on; if (on) s.blocking = true; changed(); buildPanel(s); }));
      kids.push(el("p", "cc-hint", "Étape sautée par défaut : le visa conclut la demande. Elle n'est sollicitée que si la direction choisit « Envoyer à la cheffe de service » en donnant son visa. À placer dans une colonne après celle du visa."));
    }
    if (s.kind === "personnes") kids.push(personsPicker(s));
    if (s.kind === "groupe") {
      const fs = el("fieldset", "cc-cond-box");
      fs.append(el("legend", null, "Rôles du groupe"));
      const rc = el("div", "cc-checks");
      for (const r of ROLE_CODES) {
        rc.append(check(ROLES[r] || r, s.roles.includes(r), (on) => { s.roles = on ? [...new Set([...s.roles, r])] : s.roles.filter((x) => x !== r); changed(); }));
      }
      fs.append(rc);
      const sc = el("select");
      for (const [v, t] of [["clinic", "Même clinique que le demandeur"], ["all", "Tout le service"]]) { const o = el("option", null, t); o.value = v; sc.append(o); }
      sc.value = s.scope;
      sc.addEventListener("change", () => { s.scope = sc.value; changed(); });
      kids.push(fs, field("Périmètre", sc), el("p", "cc-hint", "Le demandeur est exclu ; 200 personnes au plus."));
    }
    if (s.kind === "personnes" || s.kind === "direction") {
      kids.push(check("Avis du chef de service (remplit cette case du formulaire PDF)", s.pdf_slot === "chef_service", (on) => {
        for (const x of allSteps()) if (x.pdf_slot === "chef_service") x.pdf_slot = null;
        s.pdf_slot = on ? "chef_service" : null;
        changed();
      }));
    }
    if (s.kind === "clinique") kids.push(el("p", "cc-hint", "Les validateurs sont désignés par clinique dans « Absences : valideurs »."));

    if (state.ro) {
      // lecture seule : aucun déplacement ni suppression, tous les champs verrouillés (sauf le filtre de recherche)
      for (const k of kids) for (const c of [k, ...k.querySelectorAll("input, select, button")]) if (c.matches && c.matches("input:not([type=search]), select, button")) c.disabled = true;
      kids.unshift(el("p", "cc-hint", "Réglages en lecture seule."));
      body.replaceChildren(...kids);
      return;
    }
    const pos = el("fieldset", "cc-cond-box");
    pos.append(el("legend", null, "Position"));
    const mv = el("div", "cc-moves");
    const mvBtn = (txt, ok, fn) => { const b = el("button", "cc-b", txt); b.type = "button"; b.disabled = !ok; b.addEventListener("click", fn); return b; };
    mv.append(
      mvBtn("← colonne précédente", canShift(s, -1), () => shift(s, -1)),
      mvBtn("colonne suivante →", canShift(s, 1), () => shift(s, 1)),
      mvBtn("avec la colonne précédente", canJoin(s, -1), () => join(s, -1)),
      mvBtn("avec la colonne suivante", canJoin(s, 1), () => join(s, 1)),
    );
    pos.append(mv);
    kids.push(pos);

    const del = el("button", "cc-b danger", "Supprimer l'étape"); del.type = "button";
    del.addEventListener("click", () => {
      if (!confirm("Supprimer l'étape « " + (s.label || "sans libellé") + " » du circuit ?")) return;
      const [ci, si] = locate(s);
      if (ci >= 0) state.cols[ci].splice(si, 1);
      closePanel(); dirty();
    });
    kids.push(del);
    body.replaceChildren(...kids);
  }

  // ----- Enregistrement -----
  async function save() {
    if (state.ro) return;
    say("cc-ed-msg", "");
    let payload;
    try { payload = serialize(); } catch (e) { return say("cc-ed-msg", e.message, "error"); }
    if (!confirm("Les demandes déjà envoyées gardent leur circuit ; les nouvelles suivront celui-ci.")) return;
    $("cc-save").disabled = true;
    const { data, error } = await sb.rpc("absence_circuit_save", { p_steps: payload, p_circuit: state.sel });
    if (error) { dirty(); return say("cc-ed-msg", error.message, "error"); }
    state.detail = data;
    await refreshOverview();
    loadSteps(data.steps);
    renderAssign();
    log((data && data.log) || []);
    say("cc-ed-msg", "Circuit enregistré.", "ok");
    if (data && data.warning) { const m = $("cc-ed-msg"); m.append(" "); m.append(el("span", "cc-warn-text", data.warning)); }
  }
  function loadSteps(steps) {
    load(steps);
    state.orig = snapshot();
    closePanelQuiet();
    renderBuilder(); dirty();
  }
  function closePanelQuiet() { $("cc-panel").hidden = true; $("cc-scrim").hidden = true; $("cc-tool").classList.remove("has-panel"); }
  function cancel() {
    const o = JSON.parse(state.orig);
    state.pre = o.pre; state.cols = o.cols; state.selected = null;
    say("cc-ed-msg", ""); closePanelQuiet(); renderBuilder(); dirty();
  }

  // ----- Journal -----
  const stampFmt = new Intl.DateTimeFormat("fr-CH", { timeZone: "Europe/Zurich", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  function stamp(iso) {
    const p = stampFmt.formatToParts(new Date(iso)).reduce((o, x) => (o[x.type] = x.value, o), {});
    return p.day + "." + p.month + "." + p.year + " " + p.hour + ":" + p.minute;
  }
  function log(rows) {
    const box = $("cc-log");
    if (!rows.length) return box.replaceChildren(el("p", "cc-hint", "Aucune modification enregistrée."));
    const ul = el("ul", "cc-log-list");
    for (const r of rows.slice(0, 20)) ul.append(el("li", null, stamp(r.at) + " · " + (r.by_name || "membre inconnu") + " · " + (r.summary || "")));
    box.replaceChildren(ul);
  }

  // ----- Simulateur -----
  function nextMonday() {
    const d = new Date(); d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7));
    return d;
  }
  const iso = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  const fr = (s) => s.split("-").reverse().join(".");

  async function simulate(draft) {
    if (state.ro) draft = false; // un cadre simule seulement les circuits enregistrés
    const sel = $("cc-member");
    const msg = $("cc-msg"); msg.className = "form-msg"; msg.textContent = "";
    $("cc-result").replaceChildren();
    if (!sel.value || !$("cc-from").value || !$("cc-to").value) { msg.className = "form-msg error"; msg.textContent = "Choisissez un membre et deux dates."; return; }
    const from = $("cc-from").value, to = $("cc-to").value, kind = $("cc-kind").value;
    const args = { p_user: sel.value, p_from: from, p_to: to, p_kind: kind };
    if (draft) {
      try { args.p_steps = serialize(); } catch (e) { say("cc-ed-msg", e.message, "error"); return; }
      args.p_circuit = state.sel;
    }
    const { data, error } = await sb.rpc("absence_circuit_simulate", args);
    if (error) {
      msg.className = "form-msg error"; msg.textContent = "Simulation impossible : " + error.message;
      if (draft) say("cc-ed-msg", "Simulation impossible : " + error.message, "error");
      return;
    }
    result(data, from, to, draft);
    $("cc-result").scrollIntoView({ block: "nearest" });
  }
  function form(o) {
    const sel = $("cc-member");
    sel.replaceChildren(...(o.members || []).map((m) => {
      const opt = el("option", null, memberLabel(m));
      opt.value = m.id; return opt;
    }));
    const mon = nextMonday(), fri = new Date(mon); fri.setDate(mon.getDate() + 4);
    $("cc-from").value = iso(mon); $("cc-to").value = iso(fri);
    $("cc-to").min = $("cc-from").value;
    $("cc-from").addEventListener("change", () => { $("cc-to").min = $("cc-from").value; if (!$("cc-to").value || $("cc-to").value < $("cc-from").value) $("cc-to").value = $("cc-from").value; });
    $("cc-form").addEventListener("submit", (ev) => { ev.preventDefault(); simulate(false); });
    $("cc-sim-draft").addEventListener("click", () => simulate(true));
  }

  function result(r, from, to, draft) {
    const box = $("cc-result");
    const head = el("p", "cc-res-head", (draft ? "Circuit en cours de modification (non enregistré) · " : "Circuit enregistré · ") + r.member.name + " (" + (ROLES[r.member.role] || r.member.role) + ") · " + ((r.clinics || []).length ? r.clinics.join(", ") : "aucune clinique à ces dates") + " · " + (KIND_NAME[r.kind] || r.kind) + " · du " + fr(from) + " au " + fr(to));
    const kids = [head, CV.applied(r), ...CV.flow(r)];
    if (draft && r.resolved && r.circuit && r.resolved.id !== r.circuit.id) kids.push(el("p", "cc-hint", "Ce membre suit en réalité le circuit « " + r.resolved.name + " » (" + (REASONS[r.resolved.reason] || r.resolved.reason) + ")."));
    kids.push(...CV.notes(r));
    box.replaceChildren(...kids);
  }

  // ----- Circuits : sélecteur et gestion -----
  function renderTabs() {
    const box = $("cc-tabs");
    box.replaceChildren(...state.circuits.map((c) => {
      const b = el("button", "cc-tab" + (c.id === state.sel ? " active" : ""), c.name);
      b.type = "button"; b.setAttribute("role", "tab"); b.setAttribute("aria-selected", c.id === state.sel ? "true" : "false");
      b.addEventListener("click", () => selectCircuit(c.id));
      return b;
    }));
    const c = current();
    $("cc-rename").hidden = c.is_default; $("cc-delete").hidden = c.is_default;
    const alt = state.circuits.filter((x) => !x.is_default), i = alt.findIndex((x) => x.id === c.id);
    $("cc-up").hidden = c.is_default; $("cc-down").hidden = c.is_default;
    $("cc-up").disabled = i <= 0; $("cc-down").disabled = i < 0 || i >= alt.length - 1;
    $("cc-flow-title").textContent = "Circuit : " + c.name;
    $("cc-assign-box").hidden = c.is_default;
    const filter = $("cc-who-circuit"), keep = filter.value;
    filter.replaceChildren(...[["", "Tous les circuits"], ...state.circuits.map((x) => [String(x.id), x.name])].map(([v, t]) => { const o = el("option", null, t); o.value = v; return o; }));
    filter.value = [...filter.options].some((o) => o.value === keep) ? keep : "";
  }
  function confirmLeave() { return (snapshot() === state.orig && assignSnapshot() === state.assignOrig) || confirm("Des modifications ne sont pas enregistrées. Les abandonner ?"); }
  async function selectCircuit(id) {
    if (id === state.sel) return;
    if (!confirmLeave()) return;
    state.sel = id;
    say("cc-ed-msg", ""); say("cc-as-msg", ""); say("cc-box-msg", "");
    await loadCircuit();
  }
  async function loadCircuit() {
    const tok = ++state.req;
    const { data, error } = await sb.rpc("absence_circuit_get", { p_circuit: state.sel });
    if (tok !== state.req) return; // réponse d'un clic plus ancien : ignorée
    if (error) return say("cc-ed-msg", "Chargement impossible : " + error.message, "error");
    state.detail = data;
    renderTabs();
    loadSteps(data.steps);
    loadAssign(data.assignments || []);
    log(data.log || []);
  }
  async function refreshOverview() {
    const { data: o } = await sb.rpc("absence_circuit_overview");
    if (o) { state.overview = o; state.circuits = o.circuits || state.circuits; if (!state.circuits.some((c) => c.id === state.sel)) state.sel = (current() || {}).id; warnings(o); table(o); renderTabs(); }
    await loadWho();
  }

  let boxMode = null;
  function openBox(mode) {
    if (state.ro) return;
    boxMode = mode;
    const c = current();
    $("cc-box").hidden = false;
    $("cc-box-title").textContent = mode === "create" ? "Nouveau circuit" : "Renommer « " + c.name + " »";
    $("cc-box-name").value = mode === "rename" ? c.name : "";
    $("cc-box-copy-wrap").hidden = mode !== "create";
    const copy = $("cc-box-copy");
    copy.replaceChildren(...state.circuits.map((x) => { const o = el("option", null, "Copier : " + x.name); o.value = String(x.id); return o; }));
    copy.value = String(state.sel);
    say("cc-box-msg", "");
    $("cc-box-name").focus();
  }
  function closeBox() { boxMode = null; $("cc-box").hidden = true; say("cc-box-msg", ""); }
  async function submitBox(ev) {
    ev.preventDefault();
    if (state.ro) return;
    const name = $("cc-box-name").value.trim();
    if (!name) return say("cc-box-msg", "Indiquez un nom (60 caractères au plus).", "error");
    if (boxMode === "create") {
      if (!confirmLeave()) return;
      const { data, error } = await sb.rpc("absence_circuit_create", { p_name: name, p_copy_from: Number($("cc-box-copy").value) || null });
      if (error) return say("cc-box-msg", error.message, "error");
      closeBox(); await refreshOverview(); state.sel = Number(data); await loadCircuit();
      say("cc-ed-msg", "Circuit créé : attribuez-le puis ajustez ses étapes.", "ok");
    } else {
      const { error } = await sb.rpc("absence_circuit_rename", { p_circuit: state.sel, p_name: name });
      if (error) return say("cc-box-msg", error.message, "error");
      // renommage : seul le nom affiché change, les étapes et attributions en cours d'édition sont conservées
      closeBox(); await refreshOverview();
    }
  }
  async function deleteCircuit() {
    if (state.ro) return;
    const c = current();
    if (c.is_default) return;
    if (!confirm("Supprimer le circuit « " + c.name + " » ? Ses membres suivront le circuit général pour leurs nouvelles demandes ; les demandes en cours gardent leur circuit.")) return;
    const { error } = await sb.rpc("absence_circuit_delete", { p_circuit: c.id });
    if (error) return say("cc-ed-msg", error.message, "error");
    state.orig = snapshot(); state.assignOrig = assignSnapshot();
    state.sel = null; await refreshOverview(); state.sel = (state.circuits.find((x) => x.is_default) || state.circuits[0]).id; await loadCircuit();
  }
  async function moveCircuit(d) {
    if (state.ro) return;
    const alt = state.circuits.filter((x) => !x.is_default).map((x) => x.id), i = alt.indexOf(state.sel);
    if (i < 0 || i + d < 0 || i + d >= alt.length) return;
    [alt[i], alt[i + d]] = [alt[i + d], alt[i]];
    const { error } = await sb.rpc("absence_circuit_reorder", { p_ids: alt });
    if (error) return say("cc-ed-msg", error.message, "error");
    await refreshOverview();
  }

  // ----- Attributions : « Qui suit ce circuit » -----
  const assignSnapshot = () => JSON.stringify(["member", "role", "clinic"].map((k) => [...state.assign[k]].sort()));
  function loadAssign(list) {
    state.assign = { member: new Set(), role: new Set(), clinic: new Set() };
    for (const a of list) state.assign[a.type].add(a.target);
    state.assignOrig = assignSnapshot();
    renderAssign();
  }
  // cibles déjà prises par un autre circuit : nom de ce circuit
  function takenBy(type, target) {
    for (const c of state.circuits) if (c.id !== state.sel) for (const a of c.assignments || []) if (a.type === type && a.target === target) return c.name;
    return null;
  }
  function pickList(type, title, items) {
    const fs = el("fieldset", "cc-cond-box cc-as-set");
    fs.append(el("legend", null, title));
    const filter = el("input"); filter.type = "search"; filter.placeholder = "Filtrer"; filter.setAttribute("aria-label", "Filtrer : " + title);
    const list = el("div", "cc-person-list"), rows = [];
    const count = el("span", "cc-hint");
    const upd = () => { const n = state.assign[type].size; count.textContent = state.ro ? n + (n > 1 ? " attribuées" : " attribuée") : n + " coché" + (n > 1 ? "s" : ""); $("cc-as-save").disabled = assignSnapshot() === state.assignOrig; $("cc-as-dirty").hidden = assignSnapshot() === state.assignOrig; };
    for (const it of items) {
      if (state.ro && !state.assign[type].has(it.id)) continue;
      const other = takenBy(type, it.id);
      const row = check(it.label + (other ? " · déjà dans « " + other + " »" : ""), state.assign[type].has(it.id), (on) => {
        if (state.ro) return;
        if (on) state.assign[type].add(it.id); else state.assign[type].delete(it.id);
        upd();
      });
      if (state.ro) row.querySelector("input").disabled = true;
      row.dataset.name = it.label.toLowerCase();
      rows.push(row); list.append(row);
    }
    filter.addEventListener("input", () => { const q = filter.value.trim().toLowerCase(); for (const r of rows) r.hidden = !!q && !r.dataset.name.includes(q); });
    fs.append(filter, count, list);
    upd();
    return fs;
  }
  function renderAssign() {
    const o = state.overview || {};
    const members = [...(o.members || [])].sort((a, b) => a.name.localeCompare(b.name, "fr")).map((m) => ({ id: m.id, label: memberLabel(m) }));
    const roles = ROLE_CODES.map((r) => ({ id: r, label: ROLES[r] || r }));
    const clinics = (o.clinics || []).map((c) => ({ id: c.clinic, label: c.clinic }));
    $("cc-as-lists").replaceChildren(pickList("member", "Membres", members), pickList("role", "Rôles", roles), pickList("clinic", "Cliniques", clinics));
  }
  async function saveAssign() {
    if (state.ro) return;
    say("cc-as-msg", "");
    const c = current();
    if (c.is_default) return;
    $("cc-as-save").disabled = true;
    const { error } = await sb.rpc("absence_circuit_assign_all", { p_circuit: c.id, p_members: [...state.assign.member], p_roles: [...state.assign.role], p_clinics: [...state.assign.clinic] });
    // dans tous les cas, l'écran est remis d'accord avec la base
    await refreshOverview();
    const { data } = await sb.rpc("absence_circuit_get", { p_circuit: c.id });
    if (data && c.id === state.sel) { state.detail = data; loadAssign(data.assignments || []); log(data.log || []); }
    if (error) return say("cc-as-msg", error.message, "error");
    say("cc-as-msg", "Attributions enregistrées.", "ok");
  }

  // ----- Qui suit quel circuit -----
  async function loadWho() {
    const { data, error } = await sb.rpc("absence_circuit_who");
    if (error) return ($("cc-who-msg").textContent = "Chargement impossible : " + error.message);
    state.who = data || [];
    $("cc-who-count").textContent = "(" + state.who.length + ")";
    renderWho();
  }
  function renderWho() {
    const q = $("cc-who-q").value.trim().toLowerCase(), cid = $("cc-who-circuit").value;
    const t = $("cc-who-table");
    const head = el("tr");
    for (const h of ["Membre", "Rôle", "Cliniques", "Circuit", "Raison"]) head.append(el("th", null, h));
    const thead = el("thead"); thead.append(head);
    const body = el("tbody");
    const rows = state.who.filter((w) => (!cid || String(w.circuit_id) === cid) && (!q || (w.name || "").toLowerCase().includes(q) || (w.circuit_name || "").toLowerCase().includes(q)));
    for (const w of rows) {
      const tr = el("tr");
      const reason = el("td", null, REASONS[w.reason] || w.reason);
      if (w.conflict) { const p = pill("conflit", "warn"); p.title = "Plusieurs cliniques mènent à des circuits différents : le mieux placé s'applique"; reason.append(" ", p); }
      tr.append(el("td", null, w.name || ""), el("td", null, ROLES[w.role] || w.role), el("td", null, (w.clinics || []).join(", ")), el("td", null, w.circuit_name || ""), reason);
      body.append(tr);
    }
    t.replaceChildren(thead, body);
    $("cc-who-msg").textContent = rows.length ? rows.length + " membre" + (rows.length > 1 ? "s" : "") : "Aucun membre ne correspond.";
  }

  // Médecin cadre : lecture seule. Les boutons d'écriture disparaissent ; la base refuse de toute façon les appels d'écriture.
  function readOnly() {
    $("cc-tool").classList.add("cc-ro");
    $("cc-ro-note").hidden = false;
    for (const id of ["cc-tools", "cc-box", "cc-bar", "cc-as-actions", "cc-palette"]) $(id).hidden = true;
    $("cc-hint-flow").textContent = "Les étapes d'une même colonne sont simultanées ; les colonnes se suivent de gauche à droite. Cliquez une étape pour voir ses réglages.";
    $("cc-note").textContent = "Le circuit général s'applique à tous, sauf aux membres, rôles et cliniques attribués à un circuit alternatif (priorité : membre, rôle, clinique, puis général). Un administrateur peut valider à toute étape.";
    $("cc-eyebrow").textContent = "Absences";
    $("cc-back").textContent = "← Absences";
    $("cc-back").href = "/app/absences.html";
    $("cc-assign-hint").textContent = "Membres, rôles et cliniques qui suivent ce circuit.";
    $("cc-form").querySelector("button[type=submit]").textContent = "Simuler";
    document.title = "Circuit de validation des absences · Onconic";
  }

  (async () => {
    if (!sb) return ($("ug-status").textContent = "Service indisponible.");
    const { data } = await sb.auth.getSession();
    if (!data.session) return (location.href = "/fr/the-hive.html");
    $("logout").addEventListener("click", async () => { await sb.auth.signOut(); location.href = "/fr/"; });
    const { data: role } = await sb.rpc("current_role_name");
    if (role !== "admin" && role !== "direction" && role !== "cadre") return ($("ug-status").textContent = "Page réservée à l'administration et aux médecins cadres.");
    state.ro = role === "cadre";
    const { data: o, error } = await sb.rpc("absence_circuit_overview");
    if (error) return ($("ug-status").textContent = "Chargement impossible : " + error.message);
    state.overview = o; state.circuits = o.circuits || [];
    state.sel = (state.circuits.find((c) => c.is_default) || state.circuits[0] || {}).id;
    $("ug-status").hidden = true;
    $("cc-tool").hidden = false;
    warnings(o); table(o); form(o);
    if (state.ro) readOnly();
    $("cc-save").addEventListener("click", save);
    $("cc-cancel").addEventListener("click", cancel);
    $("cc-new").addEventListener("click", () => openBox("create"));
    $("cc-rename").addEventListener("click", () => openBox("rename"));
    $("cc-delete").addEventListener("click", deleteCircuit);
    $("cc-up").addEventListener("click", () => moveCircuit(-1));
    $("cc-down").addEventListener("click", () => moveCircuit(1));
    $("cc-box").addEventListener("submit", submitBox);
    $("cc-box-cancel").addEventListener("click", closeBox);
    $("cc-as-save").addEventListener("click", saveAssign);
    $("cc-who-q").addEventListener("input", renderWho);
    $("cc-who-circuit").addEventListener("change", renderWho);
    $("cc-panel-close").addEventListener("click", closePanel);
    $("cc-scrim").addEventListener("click", closePanel);
    document.addEventListener("keydown", (ev) => {
      if (ev.key !== "Escape") return;
      if (!$("cc-palette").hidden) closePalette(); else if (!$("cc-panel").hidden) closePanel();
    });
    document.addEventListener("click", (ev) => { const p = $("cc-palette"); if (!p.hidden && !p.contains(ev.target)) closePalette(); });
    renderTabs();
    await loadCircuit();
    await loadWho();
  })();
})();
