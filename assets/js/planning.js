// Planning admin : grille collaborateurs × demi-journées (jours ouvrables), postes en couleur, couverture, export Excel.
// Édition par les cadres administratifs (et admin, direction) ; lecture pour les autres membres CHUV, motifs sensibles masqués.
// Toutes les lectures et écritures passent par les fonctions plan_* de la base (aucun accès direct aux tables).
(function () {
  const cfg = window.ONCONIC_CONFIG || {};
  const sb = window.supabase && cfg.supabaseUrl ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey) : null;
  const EXCELJS = "https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js";
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  const say = (node, text, kind) => { node.textContent = text; node.className = "form-msg" + (kind ? " " + kind : ""); };

  const TEAMS = { AM: "Assistantes médecins", SEC: "Secrétariat", DESK: "Desk et back office", ENCAD: "Encadrement", AUTRE: "Autres" };
  const MASK = { code: "ABS", label: "Absent·e", bg: "#D9D9D9", fg: "#333333" };
  const GREY = "#D9D9D9";
  const DOW = ["di", "lu", "ma", "me", "je", "ve", "sa"];
  const MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
  const SLOTS = ["lu", "ma", "me", "je", "ve"];

  // ----- Dates (heure locale, jamais d'UTC pour les jours) -----
  const pad = (n) => String(n).padStart(2, "0");
  const iso = (d) => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  const parse = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d, 12); };
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const monday = (d) => addDays(d, -((d.getDay() + 6) % 7));
  const fmt = (d) => pad(d.getDate()) + "." + pad(d.getMonth() + 1) + "." + d.getFullYear();
  const fmtS = (s) => (s ? fmt(parse(s)) : "…");
  const today = () => { const t = new Date(); t.setHours(12, 0, 0, 0); return t; };
  const workdays = (from, to) => { const out = []; for (let d = new Date(from); d <= to; d = addDays(d, 1)) if (d.getDay() % 6) out.push(new Date(d)); return out; };
  const slot = (d, h) => (d.getDay() - 1) * 2 + h;

  // Jours fériés : calcul vaudois du module partagé vd-holidays.js (même que l'app Absences) et fériés ajoutés à la main par la direction
  // (calendar_feries, lus au démarrage sur trois ans puis à la demande quand la fenêtre affichée en sort). Si la lecture échoue, la page reste
  // utilisable avec les seuls fériés calculés et un message discret le signale.
  const VD = window.OnconicHolidays;
  const feries = VD.createExtra(async (from, to) => {
    const { data, error } = await sb.rpc("calendar_feries", { p_from: from, p_to: to });
    if (error) throw error;
    return data || [];
  });
  const holidayOf = (d) => feries.holidayOf(iso(d));
  function feriesWarn(on) {
    let w = $("pl-feries-warn");
    if (!on) { if (w) w.remove(); return; }
    if (!w) {
      w = el("p", "muted pl-feries-warn", "Les fériés ajoutés par la direction n'ont pas pu être chargés : les jours fériés affichés peuvent être incomplets.");
      w.id = "pl-feries-warn"; w.setAttribute("role", "status");
      $("pl-tool").prepend(w);
    }
  }
  // Charge les fériés manuels de la plage [from, to] (Date) si elle sort de ce qui est déjà lu ; ne lève jamais d'exception
  async function ensureFeries(from, to, pad) {
    const ok = await feries.ensure(iso(from), iso(to), { pad: pad || 0 });
    feriesWarn(!ok);
    return ok;
  }

  // ----- État -----
  const st = {
    editor: false, codes: [], by: {}, coverage: [], staff: [], cells: new Map(), abs: new Map(),
    span: 10, winLen: 42, start: monday(today()), tool: null, anchor: null, painting: null, undo: [], onlyMe: false,
    accounts: null, loaded: null
  };
  const key = (id, day, h) => id + "|" + day + "|" + h;
  const codeOf = (id, d, h) => st.cells.get(key(id, iso(d), h)) || "";
  const inPeriod = (p, d) => (!p.start_date || iso(d) >= p.start_date) && (!p.end_date || iso(d) <= p.end_date);
  const isOff = (p, d, h) => (p.off || []).includes(slot(d, h));
  const nameOf = (p) => p.first_name + " " + p.last_name;
  const isAbs = (c) => !!(st.by[c] && st.by[c].kind === "absence") || c === "ABS";

  function days() {
    if (st.span === "month") return workdays(new Date(st.start.getFullYear(), st.start.getMonth(), 1, 12), new Date(st.start.getFullYear(), st.start.getMonth() + 1, 0, 12));
    if (st.span === "window") return workdays(st.start, addDays(st.start, st.winLen - 1));
    return workdays(st.start, addDays(st.start, st.span === 5 ? 4 : 11));
  }

  async function fetchGrid(from, to) {
    const { data, error } = await sb.rpc("plan_grid", { p_from: iso(from), p_to: iso(to) });
    if (error) throw error;
    return data;
  }
  function absorb(g, replaceFrom, replaceTo) {
    st.editor = !!g.editor;
    st.codes = g.codes || [];
    st.by = Object.fromEntries(st.codes.map((c) => [c.code, c]));
    st.coverage = g.coverage || [];
    const known = new Map(st.staff.map((s) => [s.id, s]));
    // _ord : rang reçu du serveur (ordre du tableur). Un chargement complet le renumérote ; une plage ajoutée garde le rang déjà connu
    (g.staff || []).forEach((s, i) => { s._ord = replaceFrom || !known.has(s.id) ? i : known.get(s.id)._ord; known.set(s.id, s); });
    st.staff = [...known.values()];
    if (replaceFrom) {
      for (const k of [...st.cells.keys()]) { const d = k.split("|")[1]; if (d >= replaceFrom && d <= replaceTo) st.cells.delete(k); }
      for (const k of [...st.abs.keys()]) { const d = k.split("|")[1]; if (d >= replaceFrom && d <= replaceTo) st.abs.delete(k); }
    }
    for (const [id, day, h, code] of g.cells || []) st.cells.set(key(id, day, h), code);
    // Absences de l'app Absences (comptes reliés) : affichées là où aucune case n'est posée à la main
    for (const [id, day, code, status] of g.absences || []) st.abs.set(id + "|" + day, [code, status]);
  }
  async function load() {
    const ds = days();
    const from = ds[0], to = ds[ds.length - 1];
    try {
      const [g] = await Promise.all([fetchGrid(from, to), ensureFeries(from, to, 366)]);
      st.staff = [];
      absorb(g, iso(from), iso(to));
      st.loaded = [iso(from), iso(to)];
    } catch (e) { return say($("pl-status"), "Chargement impossible : " + e.message, "error"); }
    $("pl-status").hidden = true;
    $("pl-tool").hidden = false;
    $("pl-tools").hidden = !st.editor;
    $("pl-reader").hidden = st.editor;
    $("pl-only-me-wrap").hidden = !st.staff.some((s) => s.me);
    $("pl-feed").hidden = !st.staff.some((s) => s.me);
    if (st.editor) renderPalette();
    renderLegend();
    render();
  }

  // ----- Grille -----
  // Toute liste de personnes passe par OnconicSort après réception (nom de famille par défaut, au choix : prénom) ; sans le module, l'ordre reçu
  // « sheet » : ordre du tableur (champ « Ordre dans l'export Excel », celui du serveur) ; mode propre à cette liste
  const SORT_MODES = ["family", "first", "sheet"], SORT_EXTRA = { sheet: "Ordre du tableur" };
  const sortMode = () => (window.OnconicSort ? window.OnconicSort.getMode("planning-personnel", SORT_MODES, Object.keys(SORT_EXTRA)) : "family");
  const sheetOrder = (list) => Array.from(list).sort((a, b) => (a._ord == null ? 1e9 : a._ord) - (b._ord == null ? 1e9 : b._ord) || a.id - b.id);
  const sortStaff = (list, mode) => (mode === "sheet" ? sheetOrder(list) : window.OnconicSort ? window.OnconicSort.sortPeople(list, { mode }) : Array.from(list));
  function visible(mode) {
    const team = $("pl-team").value, q = $("pl-q").value.trim().toLowerCase();
    const [a, b] = st.loaded;
    return sortStaff(st.staff, mode || sortMode()).filter((p) => (!team || p.team === team) && (!q || nameOf(p).toLowerCase().includes(q)) && (!st.onlyMe || p.me)
      && (!p.start_date || p.start_date <= b) && (!p.end_date || p.end_date >= a));
  }
  function shown(p, code) {
    if (!code) return null;
    if (code === "ABS") return MASK;
    return st.by[code] || { code, label: code, bg: "#FFFFFF", fg: "#000000" };
  }
  // Absence reliée (app Absences) pour une demi-journée sans case posée : [code, statut] ou null
  const absAt = (p, d, h) => (!codeOf(p.id, d, h) && !holidayOf(d) && !isOff(p, d, h) && st.abs.get(p.id + "|" + iso(d))) || null;
  function paintCell(td, p, d, h) {
    let code = codeOf(p.id, d, h);
    const ab = absAt(p, d, h);
    if (ab) code = ab[0];
    const c = shown(p, code), hol = holidayOf(d), off = isOff(p, d, h), out = !inPeriod(p, d);
    td.classList.toggle("pl-out", out && !c);
    td.classList.toggle("pl-fromabs", !!ab);
    td.classList.toggle("pl-req", !!ab && ab[1] === "requested");
    td.textContent = c ? c.code + (ab && ab[1] === "requested" ? "?" : "") : "";
    td.style.background = c ? c.bg : out ? "" : hol || off ? GREY : "";
    td.style.color = c ? c.fg : "";
    td.title = nameOf(p) + " · " + DOW[d.getDay()] + " " + fmt(d) + (h ? " après-midi" : " matin") +
      (c ? " · " + (c.label || c.code) : out ? " · hors période" : hol ? " · " + hol : off ? " · jour off habituel" : "") +
      (ab ? (ab[1] === "requested" ? " · demande d'absence en attente (app Absences)" : " · absence validée (app Absences)") : "");
  }
  function render() {
    const ds = days(), ps = visible(sortMode()), t = $("pl-grid");
    $("pl-range").textContent = st.span === "month" ? MONTHS[st.start.getMonth()] + " " + st.start.getFullYear() : fmt(ds[0]) + " – " + fmt(ds[ds.length - 1]);
    const narrow = st.span === "window" && st.winLen >= 91;
    const head0 = el("tr", "pl-months"), head1 = el("tr"), head2 = el("tr");
    const th0 = el("th", "pl-name pl-corner", "Collaborateur·rice"); th0.rowSpan = 3; head0.append(th0);
    for (let i = 0; i < ds.length;) {
      let j = i; while (j + 1 < ds.length && ds[j + 1].getMonth() === ds[i].getMonth()) j++;
      const th = el("th", "pl-month" + (i ? " pl-mon" : ""), MONTHS[ds[i].getMonth()] + " " + ds[i].getFullYear()); th.colSpan = (j - i + 1) * 2; head0.append(th);
      i = j + 1;
    }
    const todayIso = iso(today());
    for (const d of ds) {
      const hol = holidayOf(d);
      const th = el("th", "pl-day" + (d.getDay() === 1 ? " pl-mon" : "") + (hol ? " pl-hol" : "") + (iso(d) === todayIso ? " pl-today" : ""));
      th.colSpan = 2;
      if (narrow) th.append(el("b", null, String(d.getDate())));
      else th.append(el("span", null, DOW[d.getDay()]), el("b", null, pad(d.getDate()) + "." + pad(d.getMonth() + 1)));
      th.title = DOW[d.getDay()] + " " + fmt(d) + (hol ? " · " + hol : "");
      head1.append(th);
      head2.append(el("th", "pl-h" + (d.getDay() === 1 ? " pl-mon" : ""), narrow ? "" : "M"), el("th", "pl-h", narrow ? "" : "A"));
    }
    const thead = el("thead"); thead.append(head0, head1, head2);
    t.classList.toggle("pl-narrow", narrow);
    const tbody = el("tbody");
    for (const team of Object.keys(TEAMS)) {
      const members = ps.filter((p) => p.team === team);
      if (!members.length) continue;
      const g = el("tr", "pl-group"); g.append(el("th", "pl-name", TEAMS[team] + " (" + members.length + ")"));
      const fill = el("td"); fill.colSpan = ds.length * 2; g.append(fill); tbody.append(g);
      for (const p of members) {
        const tr = el("tr", p.me ? "pl-me" : null);
        const th = el("th", "pl-name");
        const nm = el(st.editor ? "button" : "span", "pl-who", nameOf(p));
        if (st.editor) { nm.type = "button"; nm.dataset.p = p.id; }
        if (p.status === "temporaire") th.append(el("span", "pl-temp", "temp."));
        th.append(nm, el("small", null, [p.status === "temporaire" ? "mission " + fmtS(p.start_date) + " – " + fmtS(p.end_date) : "", p.pct + " %",
          p.bloc != null ? (p.bloc ? "bloc " + p.bloc : "flottant") : "", p.resp ? "resp. " + p.resp : ""].filter(Boolean).join(" · ")));
        tr.append(th);
        for (const d of ds) for (const h of [0, 1]) {
          const td = el("td", "pl-c" + (h === 0 && d.getDay() === 1 ? " pl-mon" : "") + (h === 1 ? " pl-pm" : ""));
          td.dataset.p = p.id; td.dataset.d = iso(d); td.dataset.h = h;
          paintCell(td, p, d, h);
          tr.append(td);
        }
        tbody.append(tr);
      }
    }
    if (!ps.length) { const tr = el("tr"); const td = el("td", "muted", "Aucune ligne à afficher."); td.colSpan = ds.length * 2 + 1; tr.append(td); tbody.append(tr); }
    // Couverture : présents par ligne de couverture et par demi-journée, sur tout l'effectif chargé
    const tfoot = el("tfoot");
    if (st.coverage.length) {
      const ft = el("tr", "pl-group"); ft.append(el("th", "pl-name", "Couverture (min.)")); const ff = el("td"); ff.colSpan = ds.length * 2; ft.append(ff); tfoot.append(ft);
      for (const row of st.coverage) {
        const set = new Set(row.codes || []);
        const tr = el("tr", "pl-cov"); tr.append(el("th", "pl-name", row.label + " (" + row.min + ")"));
        for (const d of ds) for (const h of [0, 1]) {
          const td = el("td", "pl-c" + (h === 0 && d.getDay() === 1 ? " pl-mon" : "") + (h === 1 ? " pl-pm" : ""));
          if (holidayOf(d)) { td.style.background = GREY; tr.append(td); continue; }
          const n = countOf(set, d, h);
          td.textContent = n;
          if (n < row.min) { td.classList.add("pl-low"); td.title = row.label + " : " + n + " présent·e·s, minimum " + row.min; }
          tr.append(td);
        }
        tfoot.append(tr);
      }
    }
    t.replaceChildren(thead, tbody, tfoot);
  }
  const countOf = (set, d, h) => st.staff.reduce((n, p) => n + (set.has(codeOf(p.id, d, h)) ? 1 : 0), 0);

  // ----- Écriture : file d'attente, envoi par lot -----
  let queue = [], timer = null;
  function setLocal(id, day, h, code, batch) {
    const k = key(id, day, h), prev = st.cells.get(k) || "";
    if (prev === code) return false;
    if (prev === "ABS") return false; // motif masqué : jamais modifié à l'aveugle
    batch.push([id, day, h, prev]);
    if (code) st.cells.set(k, code); else st.cells.delete(k);
    queue.push({ s: id, d: day, h, c: code });
    return true;
  }
  function flushSoon() { clearTimeout(timer); timer = setTimeout(flush, 350); }
  async function flush() {
    if (!queue.length) return;
    const batch = queue; queue = [];
    say($("pl-save"), "Enregistrement…");
    for (let i = 0; i < batch.length; i += 4000) {
      const { error } = await sb.rpc("plan_set_cells", { p_changes: batch.slice(i, i + 4000) });
      if (error) { say($("pl-save"), "Non enregistré : " + error.message + " La grille est rechargée.", "error"); await load(); return; }
    }
    say($("pl-save"), "Enregistré (" + batch.length + " demi-journée" + (batch.length > 1 ? "s" : "") + ").", "ok");
  }
  function pushUndo(batch) { if (batch.length) { st.undo.push(batch); $("pl-undo").disabled = false; } }
  function undo() {
    const b = st.undo.pop();
    if (!b) return;
    for (const [id, day, h, prev] of b.slice().reverse()) {
      const k = key(id, day, h);
      if (prev) st.cells.set(k, prev); else st.cells.delete(k);
      queue.push({ s: id, d: day, h, c: prev });
    }
    $("pl-undo").disabled = !st.undo.length;
    render(); flushSoon();
  }

  // ----- Peinture -----
  const grid = $("pl-grid");
  function apply(td, batch, erase) {
    const p = st.staff.find((x) => x.id === Number(td.dataset.p)), d = parse(td.dataset.d), h = Number(td.dataset.h);
    if (!p || !inPeriod(p, d)) return;
    if (setLocal(p.id, td.dataset.d, h, erase ? "" : st.tool, batch)) paintCell(td, p, d, h);
  }
  grid.addEventListener("contextmenu", (e) => { if (st.editor && e.target.closest("td.pl-c[data-p]")) e.preventDefault(); });
  grid.addEventListener("pointerdown", (e) => {
    if (!st.editor) return;
    const td = e.target.closest("td.pl-c[data-p]");
    if (!td) return;
    e.preventDefault();
    const erase = e.button === 2 || st.tool === "";
    if (!erase && !st.tool) return say($("pl-save"), "Choisissez d'abord un code dans la palette.", "error");
    const batch = [];
    const an = st.anchor && grid.querySelector('td[data-p="' + st.anchor.p + '"][data-d="' + st.anchor.d + '"][data-h="' + st.anchor.h + '"]');
    if (e.shiftKey && an) {
      const rows = [...grid.querySelectorAll("tbody tr")].filter((r) => r.querySelector("td[data-p]"));
      const r0 = rows.findIndex((r) => r.contains(an)), r1 = rows.findIndex((r) => r.contains(td));
      const c0 = [...an.parentNode.children].indexOf(an), c1 = [...td.parentNode.children].indexOf(td);
      for (let r = Math.min(r0, r1); r <= Math.max(r0, r1); r++)
        for (let c = Math.min(c0, c1); c <= Math.max(c0, c1); c++) apply(rows[r].children[c], batch, erase);
      pushUndo(batch); render(); flushSoon(); return;
    }
    st.anchor = { p: td.dataset.p, d: td.dataset.d, h: td.dataset.h };
    st.painting = { batch, erase };
    apply(td, batch, erase);
  });
  grid.addEventListener("pointerover", (e) => {
    if (!st.painting) return;
    const td = e.target.closest("td.pl-c[data-p]");
    if (td) apply(td, st.painting.batch, st.painting.erase);
  });
  window.addEventListener("pointerup", () => {
    if (!st.painting) return;
    pushUndo(st.painting.batch);
    st.painting = null; render(); flushSoon();
  });
  document.addEventListener("keydown", (e) => { if ((e.ctrlKey || e.metaKey) && e.key === "z" && st.editor && !e.target.closest("input, select, dialog")) { e.preventDefault(); undo(); } });
  $("pl-undo").addEventListener("click", undo);

  // ----- Palette et légende -----
  function chip(c, tag) {
    const b = el(tag || "span", "pl-chip", c.code); b.style.background = c.bg; b.style.color = c.fg; b.title = c.label || c.code; return b;
  }
  function renderPalette() {
    const box = $("pl-palette"); box.replaceChildren();
    const active = st.codes.filter((c) => c.active);
    for (const g of [...new Set(active.map((c) => c.grp))]) {
      const f = el("div", "pl-pgroup"); f.append(el("span", "pl-plabel", g));
      for (const c of active.filter((x) => x.grp === g)) {
        const b = chip(c, "button"); b.type = "button"; if (st.tool === c.code) b.classList.add("on");
        b.addEventListener("click", () => { st.tool = c.code; renderPalette(); });
        f.append(b);
      }
      box.append(f);
    }
    const f = el("div", "pl-pgroup"); f.append(el("span", "pl-plabel", "Effacer"));
    const gm = el("button", "pl-chip pl-eraser" + (st.tool === "" ? " on" : ""), "Gomme"); gm.type = "button";
    gm.addEventListener("click", () => { st.tool = ""; renderPalette(); });
    f.append(gm); box.append(f);
  }
  function renderLegend() {
    const box = $("pl-legend"); box.replaceChildren(el("h2", null, "Légende"));
    const list = el("div", "pl-leg");
    for (const c of st.codes.filter((x) => x.active)) { const i = el("span", "pl-legi"); i.append(chip(c), c.label || ""); list.append(i); }
    if (!st.editor) { const i = el("span", "pl-legi"); i.append(chip(MASK), "Absence (motif non affiché)"); list.append(i); }
    const i = el("span", "pl-legi"); const s = el("span", "pl-chip", ""); s.style.background = GREY; i.append(s, "Jour off habituel ou jour férié"); list.append(i);
    const j = el("span", "pl-legi"); const t = el("span", "pl-chip pl-fromabs", "V"); t.style.background = (st.by.V || {}).bg || "#FF0000"; t.style.color = (st.by.V || {}).fg || "#FFFFFF";
    j.append(t, "Cadre pointillé : absence venue de l'app Absences ; « ? » : demande en attente"); list.append(j);
    box.append(list);
  }

  // ----- Fiche : effectif, semaine type, absence sur une période -----
  let cur = null;
  function codeOptions(sel, filter, blank) {
    sel.replaceChildren();
    if (blank != null) { const o = el("option", null, blank); o.value = ""; sel.append(o); }
    for (const c of st.codes.filter(filter)) { const o = el("option", null, c.code + (c.label ? " · " + c.label : "")); o.value = c.code; sel.append(o); }
  }
  async function accounts() {
    if (st.accounts) return st.accounts;
    const { data } = await sb.rpc("plan_accounts");
    st.accounts = data || [];
    return st.accounts;
  }
  async function openPerson(p, note) {
    cur = p;
    const isNew = !p.id;
    $("pl-person-title").textContent = isNew ? "Nouvelle ligne" : nameOf(p);
    $("pl-person-meta").textContent = isNew ? "Collaborateur·rice fixe, temporaire en mission ou remplacement. Une ligne temporaire n'apparaît que pendant sa mission." :
      TEAMS[p.team] + " · " + p.pct + " %" + (p.account ? " · compte Onconic : " + p.account : "");
    $("pf-team").replaceChildren(...Object.entries(TEAMS).map(([k, v]) => { const o = el("option", null, v); o.value = k; return o; }));
    $("pf-first").value = p.first_name || ""; $("pf-last").value = p.last_name || ""; $("pf-team").value = p.team || "AUTRE";
    $("pf-bloc").value = p.bloc == null ? "" : String(p.bloc); $("pf-pct").value = p.pct || 100; $("pf-resp").value = p.resp || "";
    $("pf-status").value = p.status || "fixe"; $("pf-from").value = p.start_date || ""; $("pf-to").value = p.end_date || ""; $("pf-pos").value = p.position || "";
    const acc = $("pf-account"); acc.replaceChildren(el("option", null, "aucun"));
    acc.firstChild.value = "";
    for (const a of (window.OnconicSort ? window.OnconicSort.sortPeople(await accounts(), { mode: "family" }) : await accounts())) { const o = el("option", null, a.name || a.id); o.value = a.id; acc.append(o); }
    acc.value = p.user_id || "";
    const off = $("pf-off"); off.replaceChildren(el("span"), ...SLOTS.map((s) => el("b", null, s)));
    const wk = $("pl-week"); wk.replaceChildren(el("span"), ...SLOTS.map((s) => el("b", null, s)));
    for (const h of [0, 1]) {
      off.append(el("b", null, h ? "après-midi" : "matin"));
      wk.append(el("b", null, h ? "après-midi" : "matin"));
      for (let d = 0; d < 5; d++) {
        const l = el("label", "pl-offc"); const cb = el("input"); cb.type = "checkbox"; cb.dataset.slot = d * 2 + h; cb.checked = (p.off || []).includes(d * 2 + h);
        l.append(cb, "off"); off.append(l);
        const s = el("select"); s.dataset.slot = d * 2 + h;
        codeOptions(s, (c) => c.active || (p.week || [])[d * 2 + h] === c.code, "—");
        s.value = (p.week || [])[d * 2 + h] || "";
        wk.append(s);
      }
    }
    $("pl-plan-part").hidden = isNew;
    $("pl-hist").hidden = isNew; $("pl-hist").open = false; $("pl-hist-list").replaceChildren();
    codeOptions($("pl-abs-code"), (c) => c.kind === "absence" && c.active);
    const ds = days();
    $("pl-wk-from").value = p.start_date && p.start_date > iso(ds[0]) ? p.start_date : iso(ds[0]);
    $("pl-wk-to").value = p.end_date || iso(addDays(ds[0], 27));
    $("pl-abs-from").value = iso(ds[0]); $("pl-abs-to").value = iso(ds[0]);
    say($("pl-person-msg"), note || "", note ? "ok" : "");
    if (!$("pl-person").open) $("pl-person").showModal();
  }
  $("pl-hist").addEventListener("toggle", async () => {
    if (!$("pl-hist").open || !cur || !cur.id) return;
    const box = $("pl-hist-list"); box.replaceChildren(el("p", "muted", "Chargement…"));
    const { data, error } = await sb.rpc("plan_history", { p_staff: cur.id, p_limit: 200 });
    if (error) return box.replaceChildren(el("p", "form-msg error", error.message));
    if (!data.length) return box.replaceChildren(el("p", "muted", "Aucune modification enregistrée."));
    const tb = el("table", "pl-histtab");
    const hr = el("tr"); ["Quand", "Qui", "Demi-journée", "Avant", "Après"].forEach((t) => hr.append(el("th", null, t))); tb.append(hr);
    for (const r of data) {
      const tr = el("tr");
      [new Date(r.at).toLocaleString("fr-CH", { dateStyle: "short", timeStyle: "short" }), r.actor, fmtS(r.day) + (r.half ? " après-midi" : " matin"), r.old_code || "—", r.new_code || "—"]
        .forEach((t) => tr.append(el("td", null, t)));
      tb.append(tr);
    }
    box.replaceChildren(tb);
  });
  grid.addEventListener("click", (e) => { const b = e.target.closest("button.pl-who"); if (b) openPerson(st.staff.find((p) => p.id === Number(b.dataset.p))); });
  $("pl-add").addEventListener("click", () => {
    const ds = days();
    openPerson({ team: "DESK", pct: 100, status: "temporaire", start_date: iso(ds[0]), end_date: iso(addDays(ds[0], 27)), off: [], week: [] });
  });
  $("pf-save").addEventListener("click", async () => {
    const msg = $("pl-person-msg");
    const body = {
      id: cur.id || null, first_name: $("pf-first").value.trim(), last_name: $("pf-last").value.trim(), team: $("pf-team").value,
      bloc: $("pf-bloc").value, pct: $("pf-pct").value, resp: $("pf-resp").value.trim(), status: $("pf-status").value,
      start_date: $("pf-from").value, end_date: $("pf-to").value, position: $("pf-pos").value, user_id: $("pf-account").value,
      off: [...$("pf-off").querySelectorAll("input")].filter((c) => c.checked).map((c) => Number(c.dataset.slot)),
      week: [...$("pl-week").querySelectorAll("select")].sort((a, b) => a.dataset.slot - b.dataset.slot).map((s) => s.value)
    };
    if (!body.first_name || !body.last_name) return say(msg, "Prénom et nom sont nécessaires.", "error");
    if (body.status === "temporaire" && (!body.start_date || !body.end_date)) return say(msg, "Une mission temporaire a une date de début et de fin.", "error");
    if (body.start_date && body.end_date && body.end_date < body.start_date) return say(msg, "La fin précède le début.", "error");
    const { data: id, error } = await sb.rpc("plan_staff_save", { p: body });
    if (error) return say(msg, error.message, "error");
    const wasNew = !cur.id;
    await load();
    const p = st.staff.find((x) => x.id === id);
    if (p) openPerson(p, wasNew ? "Ligne créée. Appliquez maintenant sa semaine type sur la période voulue." : "Fiche enregistrée.");
    else { $("pl-person").close(); say($("pl-save"), "Fiche enregistrée (hors de la période affichée).", "ok"); }
  });
  // Changements calculés sur une plage qui peut dépasser la fenêtre affichée : les cases existantes sont chargées d'abord
  async function ensureLoaded(from, to) {
    const [a, b] = st.loaded;
    await ensureFeries(from, to);
    if (iso(from) >= a && iso(to) <= b) return;
    const g = await fetchGrid(from, to);
    absorb(g);
  }
  $("pl-wk-apply").addEventListener("click", async () => {
    const msg = $("pl-person-msg");
    const week = [...$("pl-week").querySelectorAll("select")].sort((a, b) => a.dataset.slot - b.dataset.slot).map((s) => s.value);
    const a = $("pl-wk-from").value, b = $("pl-wk-to").value;
    if (!a || !b || b < a) return say(msg, "Période invalide.", "error");
    if (parse(b) - parse(a) > 400 * 864e5) return say(msg, "Période trop longue (400 jours au plus).", "error");
    try { await ensureLoaded(parse(a), parse(b)); } catch (e) { return say(msg, e.message, "error"); }
    const batch = [];
    for (const d of workdays(parse(a), parse(b))) {
      if (holidayOf(d) || !inPeriod(cur, d)) continue;
      for (const h of [0, 1]) {
        const prev = codeOf(cur.id, d, h);
        if (prev && isAbs(prev)) continue;
        setLocal(cur.id, iso(d), h, isOff(cur, d, h) ? "" : week[slot(d, h)], batch);
      }
    }
    pushUndo(batch); render(); await flush();
    say(msg, batch.length + " demi-journée(s) mise(s) à jour du " + fmtS(a) + " au " + fmtS(b) + ". Pensez à « Enregistrer la fiche » pour garder cette semaine type.", "ok");
  });
  $("pl-abs-apply").addEventListener("click", async () => {
    const msg = $("pl-person-msg");
    const a = $("pl-abs-from").value, b = $("pl-abs-to").value, ha = Number($("pl-abs-from-h").value), hb = Number($("pl-abs-to-h").value), code = $("pl-abs-code").value;
    if (!code || !a || !b || b < a || (a === b && hb < ha)) return say(msg, "Période invalide.", "error");
    try { await ensureLoaded(parse(a), parse(b)); } catch (e) { return say(msg, e.message, "error"); }
    const batch = [];
    for (const d of workdays(parse(a), parse(b))) {
      if (holidayOf(d) || !inPeriod(cur, d)) continue;
      for (const h of [0, 1]) {
        if ((iso(d) === a && h < ha) || (iso(d) === b && h > hb) || isOff(cur, d, h)) continue;
        setLocal(cur.id, iso(d), h, code, batch);
      }
    }
    pushUndo(batch); render(); await flush();
    say(msg, (st.by[code] || {}).label + " saisi·e : " + batch.length + " demi-journée(s) (jours off et fériés exclus).", "ok");
  });

  // ----- Copier une semaine -----
  $("pl-copy").addEventListener("click", () => {
    const a = monday(days()[0]);
    $("pl-copy-src").textContent = "Semaine du " + fmt(a) + " au " + fmt(addDays(a, 4)) + ", pour les " + visible().length + " lignes affichées (filtres actifs).";
    $("pl-copy-dlg").showModal();
  });
  $("pl-copy-dlg").addEventListener("close", async () => {
    if ($("pl-copy-dlg").returnValue !== "ok") return;
    const src = monday(days()[0]), n = Math.min(12, Math.max(1, Number($("pl-copy-n").value) || 1)), keep = $("pl-copy-keep").checked;
    try { await ensureLoaded(src, addDays(src, n * 7 + 4)); } catch (e) { return say($("pl-save"), e.message, "error"); }
    const batch = [];
    for (const p of visible()) for (let w = 1; w <= n; w++) for (let i = 0; i < 5; i++) {
      const sd = addDays(src, i), td = addDays(src, w * 7 + i);
      if (holidayOf(td) || !inPeriod(p, td)) continue;
      for (const h of [0, 1]) {
        const code = codeOf(p.id, sd, h), prev = codeOf(p.id, td, h);
        if (code && isAbs(code)) continue;
        if (keep && prev && isAbs(prev)) continue;
        setLocal(p.id, iso(td), h, code, batch);
      }
    }
    pushUndo(batch); render(); flush();
  });

  // ----- Codes et couleurs -----
  const td = (node, cls) => { const c = el("td", cls); c.append(node); return c; };
  function codeRow(c) {
    const row = el("tr");
    const code = el("input"); code.value = c.code || ""; code.maxLength = 8; code.disabled = !!c.code; code.placeholder = "CODE"; code.setAttribute("aria-label", "Code");
    const label = el("input"); label.value = c.label || ""; label.placeholder = "Libellé"; label.maxLength = 120; label.setAttribute("aria-label", "Libellé");
    const grp = el("input"); grp.value = c.grp || ""; grp.placeholder = "Groupe"; grp.maxLength = 60; grp.setAttribute("aria-label", "Groupe");
    const bg = el("input"); bg.type = "color"; bg.value = (c.bg || "#FFFFFF").toLowerCase(); bg.setAttribute("aria-label", "Couleur de fond");
    const fg = el("input"); fg.type = "color"; fg.value = (c.fg || "#000000").toLowerCase(); fg.setAttribute("aria-label", "Couleur du texte");
    const kind = el("select"); [["poste", "poste"], ["absence", "absence"]].forEach(([v, l]) => { const o = el("option", null, l); o.value = v; kind.append(o); }); kind.value = c.kind || "poste";
    const pv = el("input"); pv.type = "checkbox"; pv.checked = !!c.private; pv.setAttribute("aria-label", "Privé");
    const av = el("input"); av.type = "checkbox"; av.checked = c.active !== false; av.setAttribute("aria-label", "Actif");
    const pos = el("input"); pos.type = "number"; pos.value = c.position != null ? c.position : 900; pos.setAttribute("aria-label", "Ordre");
    const save = el("button", "btn btn-outline", "Enregistrer"); save.type = "button";
    save.addEventListener("click", async () => {
      const body = { code: code.value.trim().toUpperCase(), label: label.value.trim(), grp: grp.value.trim(), bg: bg.value.toUpperCase(), fg: fg.value.toUpperCase(),
        kind: kind.value, private: pv.checked, active: av.checked, position: pos.value };
      if (!/^[A-Z0-9][A-Z0-9-]{0,7}$/.test(body.code)) return say($("pl-codes-msg"), "Code : 1 à 8 lettres majuscules, chiffres ou tirets.", "error");
      save.disabled = true;
      const { error } = await sb.rpc("plan_code_save", { p: body });
      save.disabled = false;
      if (error) return say($("pl-codes-msg"), error.message, "error");
      say($("pl-codes-msg"), "Code " + body.code + " enregistré.", "ok");
      code.disabled = true;
      await load();
    });
    row.append(td(code, "pl-c-code"), td(label), td(grp), td(bg, "pl-c-color"), td(fg, "pl-c-color"), td(kind, "pl-c-kind"),
      td(pv, "pl-c-check"), td(av, "pl-c-check"), td(pos, "pl-c-num"), td(save, "pl-c-act"));
    return row;
  }
  function tableOf(heads, rows) {
    const wrap = el("div", "pl-tabwrap"), t = el("table", "pl-tab"), th = el("thead"), hr = el("tr"), tb = el("tbody");
    heads.forEach((h) => hr.append(el("th", null, h)));
    th.append(hr); tb.append(...rows); t.append(th, tb); wrap.append(t);
    return wrap;
  }
  $("pl-codes").addEventListener("click", () => {
    $("pl-codes-list").replaceChildren(tableOf(["Code", "Libellé", "Groupe", "Fond", "Texte", "Type", "Privé", "Actif", "Ordre", ""], st.codes.map(codeRow)));
    say($("pl-codes-msg"), "");
    $("pl-codes-dlg").showModal();
  });
  $("pl-code-add").addEventListener("click", () => {
    const r = codeRow({}); $("pl-codes-list").querySelector("tbody").append(r);
    r.scrollIntoView({ block: "nearest" }); r.querySelector("input").focus();
  });

  // ----- Couverture -----
  function minRow(r) {
    const row = el("tr");
    const label = el("input"); label.value = r.label || ""; label.placeholder = "ex. AM bloc 1"; label.maxLength = 60; label.setAttribute("aria-label", "Libellé");
    const codes = el("input"); codes.value = (r.codes || []).join(", "); codes.placeholder = "ex. AM1, AM2"; codes.setAttribute("aria-label", "Codes comptés");
    const min = el("input"); min.type = "number"; min.min = 0; min.max = 50; min.value = r.min != null ? r.min : 1; min.setAttribute("aria-label", "Minimum");
    const del = el("button", "btn btn-outline", "Retirer"); del.type = "button"; del.addEventListener("click", () => row.remove());
    row.append(td(label), td(codes), td(min, "pl-c-num"), td(del, "pl-c-act"));
    return row;
  }
  $("pl-min").addEventListener("click", () => {
    $("pl-mins").replaceChildren(tableOf(["Ligne", "Codes comptés (séparés par des virgules)", "Minimum", ""], st.coverage.map(minRow)));
    say($("pl-min-msg"), ""); $("pl-min-dlg").showModal();
  });
  $("pl-min-add").addEventListener("click", () => { const r = minRow({}); $("pl-mins").querySelector("tbody").append(r); r.querySelector("input").focus(); });
  $("pl-min-save").addEventListener("click", async () => {
    const rows = [...$("pl-mins").querySelectorAll("tbody tr")].map((r) => {
      const [l, c, m] = r.querySelectorAll("input");
      return { label: l.value.trim(), codes: c.value.split(/[,;\s]+/).map((x) => x.trim().toUpperCase()).filter(Boolean), min: Number(m.value) || 0 };
    }).filter((r) => r.label);
    const { error } = await sb.rpc("plan_coverage_save", { p_rows: rows });
    if (error) return say($("pl-min-msg"), error.message, "error");
    $("pl-min-dlg").close();
    st.coverage = rows; render();
  });

  // ----- « Mon planning » : abonnement agenda -----
  async function showFeed(reset) {
    const msg = $("pl-feed-msg");
    const { data, error } = await sb.rpc("plan_calendar_token", { p_reset: !!reset });
    if (error) return say(msg, error.message, "error");
    const url = cfg.supabaseUrl + "/functions/v1/plan-feed?t=" + data;
    $("pl-feed-url").value = url;
    $("pl-feed-webcal").href = url.replace(/^https:/, "webcal:");
    say(msg, reset ? "Nouveau lien créé : l'ancien ne fonctionne plus (ni pour vos autres agendas Onconic)." : "", reset ? "ok" : "");
  }
  $("pl-feed").addEventListener("click", async () => { $("pl-feed-dlg").showModal(); await showFeed(false); });
  $("pl-feed-copy").addEventListener("click", async (e) => {
    try { await navigator.clipboard.writeText($("pl-feed-url").value); e.target.textContent = "Copié"; } catch (x) { $("pl-feed-url").select(); }
  });
  $("pl-feed-reset").addEventListener("click", () => { if (confirm("Créer un nouveau lien ? Les agendas abonnés avec l'ancien lien (planning, absences, congrès) cesseront d'être mis à jour.")) showFeed(true); });

  // ----- Navigation -----
  function seg(attr, fn) {
    for (const b of document.querySelectorAll("[data-" + attr + "]")) b.addEventListener("click", () => {
      for (const x of document.querySelectorAll("[data-" + attr + "]")) x.classList.toggle("on", x === b);
      fn(b.dataset[attr]); load();
    });
  }
  seg("span", (v) => {
    st.span = v === "month" || v === "window" ? v : Number(v);
    $("pl-win-wrap").hidden = v !== "window";
    st.start = v === "month" ? new Date(st.start.getFullYear(), st.start.getMonth(), 1, 12) : monday(st.start);
  });
  $("pl-winlen").addEventListener("change", (e) => { st.winLen = Number(e.target.value); load(); });
  function move(dir) {
    if (st.span === "month") st.start = new Date(st.start.getFullYear(), st.start.getMonth() + dir, 1, 12);
    else if (st.span === "window") st.start = st.winLen >= 91 ? monday(new Date(st.start.getFullYear(), st.start.getMonth() + dir, st.start.getDate(), 12)) : addDays(st.start, 7 * dir);
    else st.start = addDays(st.start, dir * (st.span === 5 ? 7 : 14));
    load();
  }
  $("pl-prev").addEventListener("click", () => move(-1));
  $("pl-next").addEventListener("click", () => move(1));
  $("pl-today").addEventListener("click", () => { const t = today(); st.start = st.span === "month" ? new Date(t.getFullYear(), t.getMonth(), 1, 12) : monday(t); load(); });
  for (const [k, v] of Object.entries(TEAMS)) { const o = el("option", null, v); o.value = k; $("pl-team").append(o); }
  $("pl-team").addEventListener("change", render);
  $("pl-q").addEventListener("input", render);
  if (window.OnconicSort && $("pl-sort-slot")) $("pl-sort-slot").replaceChildren(window.OnconicSort.control("planning-personnel", { modes: SORT_MODES, extra: SORT_EXTRA, onChange: render }));
  $("pl-only-me").addEventListener("change", (e) => { st.onlyMe = e.target.checked; render(); });

  // ----- Excel -----
  function loadScript(src, global) {
    return new Promise((ok, ko) => {
      if (window[global]) return ok();
      const s = document.createElement("script");
      s.src = src; s.onload = ok; s.onerror = () => ko(new Error("chargement d'ExcelJS impossible"));
      document.head.append(s);
    });
  }
  const argb = (hex) => "FF" + String(hex || "#FFFFFF").replace("#", "").toUpperCase();
  const fill = (hex) => ({ type: "pattern", pattern: "solid", fgColor: { argb: argb(hex) } });

  $("pl-xlsx").addEventListener("click", async () => {
    const msg = $("pl-xlsx-msg");
    const a = $("pl-x-from").value, b = $("pl-x-to").value;
    if (!a || !b || b < a) return (msg.textContent = "Choisissez une période.");
    if (parse(b) - parse(a) > 400 * 864e5) return (msg.textContent = "Période trop longue (400 jours au plus).");
    msg.textContent = "Préparation…";
    try {
      await loadScript(EXCELJS, "ExcelJS");
      const [g] = await Promise.all([fetchGrid(parse(a), parse(b)), ensureFeries(parse(a), parse(b))]);
      const by = Object.fromEntries((g.codes || []).map((c) => [c.code, c]));
      const cells = new Map((g.cells || []).map(([id, day, h, code]) => [key(id, day, h), code]));
      const abs = new Map((g.absences || []).map(([id, day, code, status]) => [id + "|" + day, [code, status]]));
      const ds = workdays(parse(a), parse(b));
      const wb = new window.ExcelJS.Workbook();
      const ws = wb.addWorksheet("Planning", { views: [{ state: "frozen", xSplit: 6, ySplit: 2 }] });
      const thin = { style: "thin", color: { argb: "FFBFBFBF" } };
      ["Resp.", "%", "Bloc", "Titre", "Prénom", "Nom"].forEach((h, i) => { const c = ws.getCell(1, i + 1); c.value = h; c.font = { bold: true }; ws.mergeCells(1, i + 1, 2, i + 1); c.alignment = { vertical: "middle" }; });
      ds.forEach((d, j) => {
        const col = 7 + j * 2;
        ws.mergeCells(1, col, 1, col + 1);
        const c = ws.getCell(1, col); c.value = DOW[d.getDay()] + " " + fmt(d);
        c.alignment = { horizontal: "center", textRotation: 90 }; c.font = { bold: true, size: 8 };
        if (holidayOf(d)) { c.fill = fill(GREY); c.note = holidayOf(d); }
        ws.getCell(2, col).value = "M"; ws.getCell(2, col + 1).value = "A";
        for (const k of [col, col + 1]) { ws.getCell(2, k).alignment = { horizontal: "center" }; ws.getCell(2, k).font = { size: 8 }; ws.getColumn(k).width = 4.3; }
      });
      ws.getRow(1).height = 70;
      [8, 5, 6, 9, 12, 14].forEach((w, i) => (ws.getColumn(i + 1).width = w));
      let r = 3;
      const staff = (g.staff || []);
      const codeAt = (p, d, h) => cells.get(key(p.id, iso(d), h)) || "";
      const absAtX = (p, d, h) => (!codeAt(p, d, h) && !holidayOf(d) && !isOff(p, d, h) && abs.get(p.id + "|" + iso(d))) || null;
      for (const team of Object.keys(TEAMS)) for (const p of staff.filter((x) => x.team === team)) {
        [p.resp, p.pct, p.bloc == null ? "" : p.bloc === 0 ? "*" : p.bloc, team + (p.status === "temporaire" ? " (temp.)" : ""), p.first_name, p.last_name.toUpperCase()]
          .forEach((v, i) => (ws.getCell(r, i + 1).value = v));
        ds.forEach((d, j) => {
          for (const h of [0, 1]) {
            const ab = absAtX(p, d, h), code = codeAt(p, d, h) || (ab ? ab[0] : ""), def = code === "ABS" ? MASK : by[code];
            const c = ws.getCell(r, 7 + j * 2 + h);
            c.alignment = { horizontal: "center" }; c.font = { size: 8, italic: !!ab, color: { argb: argb(def ? def.fg : "#000000") } };
            c.border = { top: thin, bottom: thin, left: h ? thin : { style: "medium" }, right: thin };
            if (code) {
              c.value = code + (ab && ab[1] === "requested" ? "?" : "");
              c.fill = ab && ab[1] === "requested" ? { type: "pattern", pattern: "lightGray", fgColor: { argb: argb(def ? def.bg : "#FFFFFF") }, bgColor: { argb: "FFFFFFFF" } } : fill(def ? def.bg : "#FFFFFF");
              if (ab) c.note = ab[1] === "requested" ? "Demande d'absence en attente (app Absences)" : "Absence validée (app Absences)";
            }
            else if (!inPeriod(p, d)) c.fill = { type: "pattern", pattern: "lightUp", fgColor: { argb: "FFBFBFBF" }, bgColor: { argb: "FFFFFFFF" } };
            else if (holidayOf(d) || isOff(p, d, h)) c.fill = fill(GREY);
          }
        });
        r++;
      }
      if ((g.coverage || []).length) {
        r++;
        const tc = ws.getCell(r, 1); tc.value = "Couverture par demi-journée (minimum entre parenthèses)"; tc.font = { bold: true }; ws.mergeCells(r, 1, r, 6);
        r++;
        for (const row of g.coverage) {
          const set = new Set(row.codes || []);
          const lc = ws.getCell(r, 1); lc.value = row.label + " (" + row.min + ")"; ws.mergeCells(r, 1, r, 6); lc.font = { bold: true, size: 9 };
          ds.forEach((d, j) => {
            for (const h of [0, 1]) {
              const c = ws.getCell(r, 7 + j * 2 + h);
              c.alignment = { horizontal: "center" }; c.border = { top: thin, bottom: thin, left: h ? thin : { style: "medium" }, right: thin };
              if (holidayOf(d)) { c.fill = fill(GREY); continue; }
              const n = staff.reduce((k, p) => k + (set.has(codeAt(p, d, h)) ? 1 : 0), 0), low = n < row.min;
              c.value = n; c.font = { size: 8, bold: low, color: { argb: low ? "FFB3261E" : "FF333333" } }; c.fill = fill(low ? "#F8D7D5" : "#F2F4F8");
            }
          });
          r++;
        }
      }
      const lg = wb.addWorksheet("Légende");
      lg.getColumn(1).width = 26; lg.getColumn(2).width = 8; lg.getColumn(3).width = 46;
      lg.addRow(["Groupe", "Code", "Signification"]).font = { bold: true };
      for (const c of (g.codes || []).filter((x) => x.active)) { const row = lg.addRow([c.grp, c.code, c.label]); row.getCell(2).fill = fill(c.bg); row.getCell(2).font = { color: { argb: argb(c.fg) } }; }
      if (!g.editor) { const row = lg.addRow(["Absences", "ABS", "Absence (motif non affiché)"]); row.getCell(2).fill = fill(MASK.bg); }
      const gr = lg.addRow(["", "", "Jour off habituel ou jour férié"]); gr.getCell(2).fill = fill(GREY);
      lg.addRow(["", "", "Code en italique : absence venue de l'app Absences ; « ? » : demande en attente de validation"]);
      lg.addRow([]); lg.addRow(["* sera attribué à l'un des blocs selon les besoins du jour ou de la semaine"]);
      const buf = await wb.xlsx.writeBuffer();
      const link = document.createElement("a");
      link.href = URL.createObjectURL(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
      link.download = "planning-admin-" + a + "-" + b + ".xlsx";
      document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 2000);
      msg.textContent = "Fichier téléchargé (" + ds.length + " jours ouvrables).";
    } catch (e) { msg.textContent = "Export impossible : " + e.message; }
  });

  // ----- Import du tableur actuel (une ligne par personne, deux colonnes par jour ouvrable) -----
  let plan = null;
  const cellText = (v) => (v == null ? "" : typeof v === "object" ? String(v.text || v.result || (v.richText ? v.richText.map((t) => t.text).join("") : "")) : String(v)).trim();
  const hexOf = (c) => { const a = c && c.fill && c.fill.fgColor && c.fill.fgColor.argb; return a && /^[0-9A-F]{8}$/i.test(a) ? "#" + a.slice(2).toUpperCase() : null; };
  const textColor = (hex) => { const n = parseInt(hex.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255; return (r * 299 + g * 587 + b * 114) / 1000 < 140 ? "#FFFFFF" : "#000000"; };
  function splitName(first, full) {
    if (first) return [first, full];
    const parts = full.split(/\s+/).filter(Boolean);
    const up = parts.filter((w) => w.length > 1 && w === w.toUpperCase() && /[A-ZÀ-Ý]/.test(w));
    if (up.length && up.length < parts.length) return [parts.filter((w) => !up.includes(w)).join(" "), up.map((w) => w[0] + w.slice(1).toLowerCase()).join(" ")];
    return [parts.slice(0, -1).join(" ") || parts[0], parts.length > 1 ? parts[parts.length - 1] : "?"];
  }
  async function readWorkbook(file) {
    await loadScript(EXCELJS, "ExcelJS");
    const wb = new window.ExcelJS.Workbook();
    await wb.xlsx.load(await file.arrayBuffer());
    const ws = wb.worksheets[0];
    const head = {};
    ws.getRow(1).eachCell((c, col) => { const t = cellText(c.value).toLowerCase().replace(/\.$/, ""); if (t) head[t] = col; });
    const col = (n) => head[n];
    const dates = [];
    // Une date par jour, sur deux colonnes fusionnées (matin, après-midi) : seule la première colonne de la fusion compte
    ws.getRow(1).eachCell((c, cn) => {
      if (!(c.value instanceof Date) || (c.isMerged && c.master && c.master.address !== c.address)) return;
      const d = c.value, day = new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12);
      if (dates.length && iso(dates[dates.length - 1][1]) === iso(day)) return;
      dates.push([cn, day]);
    });
    if (!dates.length || !col("nom")) throw new Error("format non reconnu (ligne 1 : Resp., %, Bloc, Titre, Prénom, Nom, puis les dates)");
    // Légende (2e feuille) : libellé en colonne A, codes colorés sur la même ligne
    const legend = {};
    if (wb.worksheets[1]) wb.worksheets[1].eachRow((row) => {
      const label = cellText(row.getCell(1).value);
      row.eachCell((c, cn) => { const t = cellText(c.value).toUpperCase(); if (cn > 1 && /^[A-Z0-9][A-Z0-9-]{0,7}$/.test(t)) legend[t] = { label, bg: hexOf(c) }; });
    });
    const people = [], cells = [], seen = {};
    const teamOf = (t) => { t = t.toUpperCase(); return ["AM", "SEC", "DESK", "ENCAD"].includes(t) ? t : t === "UTI" ? "DESK" : "AUTRE"; };
    ws.eachRow((row, rn) => {
      if (rn === 1) return;
      const full = cellText(row.getCell(col("nom")).value), first = col("prénom") ? cellText(row.getCell(col("prénom")).value) : "";
      if (!full && !first) return;
      const [fn, ln] = splitName(first, full);
      const blocRaw = col("bloc") ? cellText(row.getCell(col("bloc")).value) : "";
      const pctRaw = col("%") ? Number(cellText(row.getCell(col("%")).value)) : NaN;
      const p = { first_name: fn.slice(0, 80), last_name: ln.slice(0, 80), team: teamOf(col("titre") ? cellText(row.getCell(col("titre")).value) : ""),
        bloc: /^[1-3]$/.test(blocRaw) ? Number(blocRaw) : null, pct: pctRaw >= 5 && pctRaw <= 100 ? pctRaw : 100,
        resp: col("resp") ? cellText(row.getCell(col("resp")).value).slice(0, 80) : "", position: people.length + 1, cells: [] };
      for (const [cn, d] of dates) {
        if (!(d.getDay() % 6)) continue;
        for (const h of [0, 1]) {
          const c = row.getCell(cn + h), t = cellText(c.value).toUpperCase();
          if (!t || !/^[A-Z0-9][A-Z0-9-]{0,7}$/.test(t)) continue;
          p.cells.push([iso(d), h, t]);
          if (!seen[t]) seen[t] = hexOf(c);
        }
      }
      people.push(p);
    });
    return { people, seen, legend, from: dates[0][1], to: dates[dates.length - 1][1] };
  }
  $("pl-import").addEventListener("click", () => { plan = null; $("pl-import-file").value = ""; $("pl-import-preview").replaceChildren(); $("pl-import-go").disabled = true; say($("pl-import-msg"), ""); $("pl-import-dlg").showModal(); });
  $("pl-import-file").addEventListener("change", async (e) => {
    const f = e.target.files[0]; if (!f) return;
    say($("pl-import-msg"), "Lecture…"); $("pl-import-go").disabled = true;
    try { plan = await readWorkbook(f); } catch (x) { plan = null; return say($("pl-import-msg"), "Lecture impossible : " + x.message, "error"); }
    // Rapprochement par nom avec l'effectif présent sur la période du fichier (pas de doublon si l'import est relancé)
    const to = plan.to - plan.from > 399 * 864e5 ? addDays(plan.from, 399) : plan.to;
    const all = await fetchGrid(plan.from, to).catch(() => null);
    const existing = new Map(((all && all.staff) || st.staff).map((s) => [(s.first_name + " " + s.last_name).toLowerCase(), s]));
    plan.match = plan.people.map((p) => existing.get((p.first_name + " " + p.last_name).toLowerCase()) || null);
    plan.newCodes = Object.keys(plan.seen).filter((c) => !st.by[c]);
    const nCells = plan.people.reduce((n, p) => n + p.cells.length, 0);
    const box = el("div", "pl-import-sum");
    box.append(el("p", null, `${plan.people.length} personnes (${plan.match.filter(Boolean).length} déjà présentes, ${plan.match.filter((m) => !m).length} nouvelles), ${nCells} demi-journées remplies, du ${fmt(plan.from)} au ${fmt(plan.to)}.`));
    box.append(el("p", null, plan.newCodes.length ? `Codes ajoutés au catalogue : ${plan.newCodes.join(", ")}.` : "Aucun code nouveau."));
    $("pl-import-preview").replaceChildren(box);
    say($("pl-import-msg"), "Vérifiez le résumé, puis cliquez sur « Importer ».");
    $("pl-import-go").disabled = false;
  });
  $("pl-import-go").addEventListener("click", async () => {
    if (!plan) return;
    const msg = $("pl-import-msg"); $("pl-import-go").disabled = true;
    try {
      for (const c of plan.newCodes) {
        const lg = plan.legend[c] || {}, bg = lg.bg || plan.seen[c] || "#FFFFFF";
        const { error } = await sb.rpc("plan_code_save", { p: { code: c, label: lg.label || "", grp: "À définir", bg, fg: textColor(bg), kind: "poste", position: 950 } });
        if (error) throw error;
      }
      const changes = [];
      for (let i = 0; i < plan.people.length; i++) {
        const p = plan.people[i], m = plan.match[i];
        say(msg, `Effectif : ${i + 1}/${plan.people.length}…`);
        let id = m && m.id;
        if (!id) {
          const { data, error } = await sb.rpc("plan_staff_save", { p: { first_name: p.first_name, last_name: p.last_name, team: p.team, bloc: p.bloc == null ? "" : p.bloc, pct: p.pct, resp: p.resp, status: "fixe", position: p.position } });
          if (error) throw error;
          id = data;
        }
        for (const [day, h, code] of p.cells) changes.push({ s: id, d: day, h, c: code });
      }
      for (let i = 0; i < changes.length; i += 4000) {
        say(msg, `Planning : ${Math.min(i + 4000, changes.length)}/${changes.length} demi-journées…`);
        const { error } = await sb.rpc("plan_set_cells", { p_changes: changes.slice(i, i + 4000) });
        if (error) throw error;
      }
      say(msg, `Import terminé : ${changes.length} demi-journées. Complétez les libellés des codes « À définir » dans « Codes et couleurs ».`, "ok");
      st.accounts = null;
      await load();
    } catch (x) { say(msg, "Import interrompu : " + x.message + " (ce qui précède est enregistré ; relancer l'import ne crée pas de doublon).", "error"); }
    $("pl-import-go").disabled = false;
  });

  // ----- Démarrage -----
  (async () => {
    if (!sb) return say($("pl-status"), "Service indisponible.", "error");
    const { data } = await sb.auth.getSession();
    if (!data.session) return (location.href = "/fr/the-hive.html");
    $("logout").addEventListener("click", async () => { await sb.auth.signOut(); location.href = "/fr/"; });
    const { data: tools } = await sb.rpc("my_tools");
    if (!(tools || []).includes("planning")) return say($("pl-status"), "Le planning admin est réservé aux membres du CHUV.");
    const t = today();
    await ensureFeries(addDays(t, -366), addDays(t, 1100));
    $("pl-x-from").value = iso(new Date(t.getFullYear(), t.getMonth(), 1, 12));
    $("pl-x-to").value = iso(new Date(t.getFullYear(), t.getMonth() + 1, 0, 12));
    await load();
  })();
})();
