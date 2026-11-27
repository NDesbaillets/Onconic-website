// Absences : demandes (vacances, congrès, autre), planning mensuel, validation par les cadres, export Word.
// Toute la logique métier (droits, chevauchements, statuts) est en base (supabase/absences.sql) ; cette page affiche et appelle les fonctions.
(function () {
  const cfg = window.ONCONIC_CONFIG || {};
  const sb = window.supabase && cfg.supabaseUrl ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey) : null;
  const DOCX = "https://cdn.jsdelivr.net/npm/docx@9.5.1/dist/index.iife.js";
  const EXCELJS = "https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js";
  const PREFS_KEY = "onconic.absences.v1";

  const MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
  const DOW = ["D", "L", "M", "M", "J", "V", "S"];
  const KINDS = { vacances: ["Vacances", "V"], congres: ["Congrès", "C"], autre: ["Autre", "A"] };
  const STATUS = { draft: "Brouillon (non envoyé)", requested: "En cours de validation", approved: "Validée", rejected: "Refusée", cancelled: "Annulée" };
  const DECISION = { approved: "Validée", rejected: "Refusée", change_approved: "Changement accepté", change_rejected: "Changement refusé" };

  const $ = (id) => document.getElementById(id);
  const state = {
    ctx: null, people: [], clinics: [], month: null, cache: new Map(), cur: null, view: "month", win: { start: null }, ov: { clinic: "", year: new Date().getFullYear() }, prefs: { scope: "mine", ids: [], rows: 20, order: [], winLen: 42 },
    mine: [], mineWarn: null, agendaCtx: null, agendaStatus: {}, agendaFilter: "todo", secOf: [], todo: [], rejected: [], who: "", drafts: [], approvals: new Map(), whoApprovals: new Map(),
    todoLoaded: false, todoTried: false, todoAt: 0, detailTok: 0, tempScope: null, comments: new Map(), mini: { sel: null, shifts: new Map(), open: new Set(), drawn: "", stamp: 0 }
  };

  // ----- Utilitaires -----
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
  const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const plur = (n, one, many) => `${n} ${n > 1 ? many : one}`;
  function say(node, text, kind) { node.className = "form-msg" + (kind ? " " + kind : ""); node.textContent = text; }
  // Pastille discrète du numéro de demande (AAAA-NNNN), seulement si la demande en a un
  function addNo(head, no) { if (no) head.append(el("span", "ab-no", "N° " + no)); }

  // Dates en chaînes AAAA-MM-JJ, sans fuseau horaire
  const pd = (s) => { const [y, m, d] = String(s).slice(0, 10).split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); };
  const iso = (d) => d.toISOString().slice(0, 10);
  const todayIso = () => { const t = new Date(); return iso(new Date(Date.UTC(t.getFullYear(), t.getMonth(), t.getDate()))); };
  const fmtCH = (s) => String(s).slice(0, 10).split("-").reverse().join(".");
  const period = (a, b) => (a === b ? fmtCH(a) : `${fmtCH(a)} – ${fmtCH(b)}`);
  const monthStart = (y, m) => iso(new Date(Date.UTC(y, m, 1)));
  const monthEnd = (y, m) => iso(new Date(Date.UTC(y, m + 1, 0)));
  // Jours fériés vaudois d'une année (calculés, Pâques par l'algorithme de Meeus) : date ISO -> nom
  const holCache = new Map();
  function easter(y) {
    const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
    return new Date(Date.UTC(y, month - 1, day));
  }
  function holidays(y) {
    if (holCache.has(y)) return holCache.get(y);
    const map = new Map();
    const at = (m, d) => new Date(Date.UTC(y, m, d));
    const off = (n) => { const d = easter(y); d.setUTCDate(d.getUTCDate() + n); return d; };
    const sep1 = at(8, 1).getUTCDay(); // 0 = dimanche
    const firstSunday = 1 + ((7 - sep1) % 7);
    [[at(0, 1), "Nouvel An"], [at(0, 2), "2 janvier"], [off(-2), "Vendredi saint"], [off(1), "Lundi de Pâques"], [off(39), "Ascension"],
      [off(50), "Lundi de Pentecôte"], [at(7, 1), "Fête nationale"], [at(8, firstSunday + 15), "Lundi du Jeûne fédéral"], [at(11, 25), "Noël"]]
      .forEach(([d, l]) => map.set(iso(d), l));
    holCache.set(y, map);
    return map;
  }
  const holidayOf = (day) => holidays(Number(day.slice(0, 4))).get(day);
  // Jours ouvrables (lundi à vendredi, jours fériés vaudois déduits) d'une période, éventuellement limitée à [from, to]
  function workdays(a, b, from, to) {
    let s = pd(a), e = pd(b);
    if (from && s < pd(from)) s = pd(from);
    if (to && e > pd(to)) e = pd(to);
    let n = 0;
    for (const d = new Date(s); d <= e; d.setUTCDate(d.getUTCDate() + 1)) { const w = d.getUTCDay(); if (w !== 0 && w !== 6 && !holidayOf(iso(d))) n++; }
    return n;
  }

  // ----- Préférences d'affichage (confort propre à ce navigateur) -----
  function loadPrefs() {
    try {
      const p = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
      if (p && typeof p === "object") {
        if (typeof p.scope === "string") state.prefs.scope = p.scope;
        if (Array.isArray(p.ids)) state.prefs.ids = p.ids.filter((x) => typeof x === "string");
        if (Array.isArray(p.order)) state.prefs.order = p.order.filter((x) => typeof x === "string");
        if ([0, 5, 10, 15, 20, 30, 50].includes(Number(p.rows))) state.prefs.rows = Number(p.rows);
        if ([28, 42, 91, 182].includes(Number(p.winLen))) state.prefs.winLen = Number(p.winLen);
      }
    } catch (e) { /* préférences par défaut */ }
  }
  function savePrefs() { try { localStorage.setItem(PREFS_KEY, JSON.stringify(state.prefs)); } catch (e) { /* facultatif */ } }

  // ----- Avertissements de chevauchement -----
  function conflictText(c) {
    const who = (c.others || []).join(", ");
    return `Du ${period(c.first_day, c.last_day)} : ${c.peak} membres de la clinique ${c.clinic} seraient absents en même temps (maximum prévu : ${c.max_absent})`
      + (who ? `. Déjà absent·e·s ou en demande : ${who}.` : ".");
  }
  function warnBox(conflicts, title) {
    if (!conflicts || !conflicts.length) return null;
    const box = el("div", "ab-warn");
    box.append(el("strong", null, title || "Attention : trop d'absences en même temps"));
    const ul = el("ul");
    conflicts.forEach((c) => ul.append(el("li", null, conflictText(c))));
    box.append(ul);
    return box;
  }

  // ----- Notifications push (fonction notify-absence) : sans effet visible si elles échouent -----
  // La base dépose les messages (e-mail et push) dans une boîte d'envoi ; cette fonction les expédie (sans effet visible si elle échoue)
  async function notificationStatus() {
    let panel = $("ab-notifications");
    if (!panel) { panel = el("p", "muted"); panel.id = "ab-notifications"; panel.setAttribute("role", "status"); $("ab-tool").prepend(panel); }
    try {
      const { data, error } = await sb.rpc("absence_notification_status");
      panel.textContent = error || !data ? "État des notifications indisponible. Les demandes enregistrées restent consultables." :
        `Notifications : ${data.pending} en attente, ${data.failed} en échec, ${data.sent} remises au serveur d’envoi.`;
    } catch (_) { panel.textContent = "État des notifications indisponible."; }
  }
  async function mailer() {
    try { await sb.functions.invoke("notify-absence", { body: {} }); } catch (_) { /* le traitement périodique reprend les messages */ }
    await notificationStatus();
  }

  // ----- Données -----
  async function loadRange(from, to) {
    const key = `${from}|${to}`;
    if (state.cache.has(key)) return state.cache.get(key);
    const [{ data, error }, calRes] = await Promise.all([
      sb.rpc("absence_grid", { p_from: from, p_to: to }),
      sb.rpc("absence_calendar", { p_from: from, p_to: to })
    ]);
    if (error) throw error;
    const cal = (calRes.data || []).map((c) => Object.assign(c, { start_date: String(c.start_date).slice(0, 10), end_date: String(c.end_date).slice(0, 10) }));
    const byUser = new Map();
    for (const a of data || []) {
      a.start_date = String(a.start_date).slice(0, 10); a.end_date = String(a.end_date).slice(0, 10);
      if (!byUser.has(a.user_id)) byUser.set(a.user_id, []);
      byUser.get(a.user_id).push(a);
    }
    const out = { byUser, cal };
    state.cache.set(key, out);
    return out;
  }
  const loadMonth = () => loadRange(monthStart(state.month.y, state.month.m), monthEnd(state.month.y, state.month.m));
  async function refreshPending() {
    const { data } = await sb.rpc("absence_pending_count");
    const n = Number(data) || 0;
    $("ab-todo-n").textContent = n ? String(n) : "";
    $("ab-t-todo").setAttribute("aria-label", n ? `À valider, ${plur(n, "demande", "demandes")}` : "À valider");
  }

  // ----- Sélection des personnes affichées -----
  const sharesClinic = (p, list) => (p.clinics || []).some((c) => list.includes(c));
  // Tri des personnes (module name-sort.js) : nom de famille par défaut, choix mémorisé sur cet appareil
  const SORT_MODES = ["family", "first", "role", "clinic"];
  const sortMode = () => (window.OnconicSort ? window.OnconicSort.getMode("absences", SORT_MODES) : "family");
  const compareNames = (a, b, mode) => (window.OnconicSort
    ? window.OnconicSort.compareNames(a, b, mode, { roleOrder: ROLE_ORDER })
    : String(a.name).localeCompare(String(b.name), "fr"));
  function selection() {
    const me = state.ctx.me;
    const { scope, ids } = state.prefs;
    let list;
    if (state.tempScope) { const set = new Set(state.tempScope.ids); list = state.people.filter((p) => set.has(p.id)); }
    else if (scope === "all") list = state.people.slice();
    else if (scope === "custom") { const set = new Set(ids); list = state.people.filter((p) => set.has(p.id)); }
    else if (scope === "mine") {
      const mine = state.ctx.clinics || [];
      list = state.people.filter((p) => p.is_me || sharesClinic(p, mine));
    } else list = state.people.filter((p) => (p.clinics || []).includes(scope));
    // Ordre choisi par le membre (« Ordre d'affichage »), puis moi en tête et tri choisi (nom de famille par défaut)
    const rank = new Map(state.prefs.order.map((id, i) => [id, i]));
    const r = (p) => (rank.has(p.id) ? rank.get(p.id) : Infinity);
    return list.sort((a, b) => (r(a) - r(b)) || (b.is_me - a.is_me) || compareNames(a, b, sortMode()));
  }

  // ----- Ordre d'affichage des personnes sélectionnées -----
  function setOrder(ids) { state.prefs.order = ids; savePrefs(); renderGrid(); renderOrder(); }
  function move(id, to) {
    const ids = selection().map((p) => p.id);
    const from = ids.indexOf(id);
    if (from < 0 || to < 0 || to >= ids.length || to === from) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    setOrder(ids);
    const btn = document.querySelector(`#ab-order-list [data-id="${id}"] .ab-ord-up`) || document.querySelector(`#ab-order-list [data-id="${id}"] .ab-ord-down`);
    if (btn) btn.focus();
  }
  function renderOrder() {
    const box = $("ab-order-list");
    if (!box) return;
    const list = selection();
    box.replaceChildren();
    $("ab-order-reset").hidden = !state.prefs.order.length;
    if (!list.length) { box.append(el("li", "muted", "Aucune personne sélectionnée.")); return; }
    list.forEach((p, i) => {
      const li = el("li", "ab-ord-item");
      li.dataset.id = p.id;
      li.draggable = true;
      li.append(el("span", "ab-ord-grip", "⋮⋮"), el("span", "ab-ord-name", p.name + (p.is_me ? " (moi)" : "")));
      const up = button("↑", "btn btn-outline ab-ord-up", () => move(p.id, i - 1));
      up.disabled = i === 0; up.setAttribute("aria-label", `Monter ${p.name}`);
      const down = button("↓", "btn btn-outline ab-ord-down", () => move(p.id, i + 1));
      down.disabled = i === list.length - 1; down.setAttribute("aria-label", `Descendre ${p.name}`);
      li.append(up, down);
      // Glisser-déposer (ordinateur) ; les flèches restent disponibles au clavier et sur mobile
      li.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/plain", p.id); li.classList.add("dragging"); });
      li.addEventListener("dragend", () => li.classList.remove("dragging"));
      li.addEventListener("dragover", (e) => { e.preventDefault(); li.classList.add("over"); });
      li.addEventListener("dragleave", () => li.classList.remove("over"));
      li.addEventListener("drop", (e) => { e.preventDefault(); li.classList.remove("over"); move(e.dataTransfer.getData("text/plain"), i); });
      box.append(li);
    });
  }
  function fillScope() {
    const sel = $("ab-scope");
    sel.replaceChildren();
    const add = (v, l) => { const o = el("option", null, l); o.value = v; sel.append(o); };
    const mine = state.ctx.clinics || [];
    add("mine", mine.length ? `Mes cliniques (${mine.join(", ")})` : "Moi seulement (aucune clinique)");
    add("all", "Tout le monde");
    state.clinics.forEach((c) => add(c.clinic, "Clinique : " + c.clinic));
    if (state.prefs.scope === "custom") add("custom", `Sélection personnalisée (${state.prefs.ids.length})`);
    if (![...sel.options].some((o) => o.value === state.prefs.scope)) state.prefs.scope = "mine";
    sel.value = state.prefs.scope;
  }

  // ----- Planning mensuel -----
  async function renderGrid() {
    chrome();
    if (state.view === "year") return renderOverview();
    if (state.view === "window") return renderWindow();
    const { y, m } = state.month;
    $("ab-title").textContent = `${MONTHS[m][0].toUpperCase()}${MONTHS[m].slice(1)} ${y}`;
    let byUser, cal;
    try { ({ byUser, cal } = await loadMonth()); } catch (e) {
      $("ug-status").hidden = false;
      return say($("ug-status"), "Chargement du planning impossible : " + e.message, "error");
    }
    state.cur = { byUser, cal };
    const all = selection();
    const limit = state.tempScope ? 0 : state.prefs.rows;
    const people = limit ? all.slice(0, limit) : all;
    $("ab-shown").textContent = all.length
      ? `${plur(people.length, "personne affichée", "personnes affichées")}` + (all.length > people.length ? ` sur ${all.length} (augmentez « Lignes affichées » pour voir les autres)` : "")
      : "Aucune personne sélectionnée : utilisez « Choisir les personnes » ou changez de clinique.";

    const n = Number(monthEnd(y, m).slice(8));
    const today = todayIso();
    const table = el("table", "ab-grid");
    table.append(el("caption", "visually-hidden", `Absences de ${MONTHS[m]} ${y}`));
    const head = el("tr");
    const corner = el("th", "ab-name", "Collaborateur");
    corner.scope = "col";
    head.append(corner);
    for (let d = 1; d <= n; d++) {
      const day = `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      const w = pd(day).getUTCDay();
      const th = el("th", "ab-d" + (w === 0 || w === 6 || holidayOf(day) ? " ab-we" : "") + (day === today ? " ab-today" : ""));
      th.scope = "col";
      th.append(el("span", "ab-dow", DOW[w]), document.createTextNode(String(d)));
      head.append(th);
    }
    const thead = el("thead");
    thead.append(head);
    table.append(thead);
    const body = el("tbody");
    body.append(calendarRow(y, m, n, today, cal));
    for (const p of people) {
      const tr = el("tr", p.is_me ? "ab-me" : "");
      const th = el("th", "ab-name");
      th.scope = "row";
      th.append(el("span", "ab-pname", p.name + (p.is_me ? " (moi)" : "")));
      th.append(el("span", "ab-pclinic muted", (p.clinics || []).join(", ")));
      tr.append(th);
      const list = byUser.get(p.id) || [];
      for (let d = 1; d <= n; d++) {
        const day = `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
        const w = pd(day).getUTCDay();
        const td = el("td", "ab-c" + (w === 0 || w === 6 || holidayOf(day) ? " ab-we" : "") + (day === today ? " ab-today" : ""));
        const a = list.find((x) => x.start_date <= day && day <= x.end_date);
        if (a) {
          td.className += ` ab-k-${a.kind} ab-s-${a.status}` + (a.change_type ? " ab-chg" : "");
          td.textContent = KINDS[a.kind][1];
          td.dataset.id = a.id;
          td.dataset.user = p.id;
          const label = `${p.name} : ${KINDS[a.kind][0]}, ${STATUS[a.status].toLowerCase()}, ${period(a.start_date, a.end_date)}`
            + (a.change_type === "delete" ? " (suppression demandée)" : a.change_type === "modify" ? " (modification demandée)" : "");
          td.title = label;
          // Un seul arrêt clavier par plage (premier jour affiché)
          const prev = d > 1 ? `${y}-${String(m + 1).padStart(2, "0")}-${String(d - 1).padStart(2, "0")}` : null;
          if (!prev || !(a.start_date <= prev && prev <= a.end_date)) { td.tabIndex = 0; td.setAttribute("role", "button"); td.setAttribute("aria-label", label); }
        }
        tr.append(td);
      }
      body.append(tr);
    }
    table.append(body);
    $("ab-scroll").replaceChildren(table);
    $("ab-detail").hidden = true;
  }

  // Entrées de l'agenda commun pour un jour : férié vaudois (calculé), événements, congrès signalés dans Congrès,
  // vacances scolaires (saisies par l'admin ou importées)
  const CAL_LETTER = { ferie: "F", evenement: "É", congres: "★", vacances_scolaires: "S" };
  const CAL_KIND = { ferie: "Férié", evenement: "Événement", congres: "Congrès", vacances_scolaires: "Vacances scolaires" };
  function calEntries(day, cal) {
    const out = [];
    const h = holidayOf(day);
    if (h) out.push({ kind: "ferie", label: h + " (férié vaudois)", start: day, end: day });
    for (const kind of ["evenement", "congres"])
      cal.filter((c) => c.kind === kind && c.start_date <= day && day <= c.end_date).forEach((c) => out.push({ kind, label: c.label, start: c.start_date, end: c.end_date }));
    cal.filter((c) => c.kind === "vacances_scolaires" && c.start_date <= day && day <= c.end_date).forEach((c) => out.push({ kind: "vacances_scolaires", label: c.label, start: c.start_date, end: c.end_date }));
    return out;
  }
  function calendarRow(y, m, n, today, cal) {
    const tr = el("tr", "ab-cal");
    const th = el("th", "ab-name");
    th.scope = "row";
    th.append(el("span", "ab-pname", "Fériés et événements"), el("span", "ab-pclinic muted", "Vacances scolaires VD, agenda commun"));
    tr.append(th);
    for (let d = 1; d <= n; d++) {
      const day = `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      const w = pd(day).getUTCDay();
      const td = el("td", "ab-c ab-cal-c" + (w === 0 || w === 6 ? " ab-we" : "") + (day === today ? " ab-today" : ""));
      const list = calEntries(day, cal);
      if (list.length) {
        const top = list[0];
        td.className += ` ab-cal-${top.kind}`;
        td.textContent = CAL_LETTER[top.kind];
        td.dataset.cal = day;
        const label = list.map((x) => x.label).join(" ; ");
        td.title = label;
        const prev = d > 1 ? `${y}-${String(m + 1).padStart(2, "0")}-${String(d - 1).padStart(2, "0")}` : null;
        if (!prev || calEntries(prev, cal).map((x) => x.label).join() !== list.map((x) => x.label).join()) { td.tabIndex = 0; td.setAttribute("role", "button"); td.setAttribute("aria-label", `${fmtCH(day)} : ${label}`); }
      }
      tr.append(td);
    }
    return tr;
  }

  // ----- Vues : mois (par défaut), fenêtre glissante, vue d'ensemble de l'année -----
  const addD = (s, n) => iso(new Date(pd(s).getTime() + n * 864e5));
  const fmtDM = (s) => `${s.slice(8, 10)}.${s.slice(5, 7)}`;
  const mondayOf = (s) => addD(s, -((pd(s).getUTCDay() + 6) % 7));
  const addMonths = (s, n) => { const d = pd(s); const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1)); const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate(); t.setUTCDate(Math.min(d.getUTCDate(), last)); return iso(t); };
  const VIEWS = [["month", "Mois"], ["window", "Fenêtre glissante"], ["year", "Vue d'ensemble"]];
  const winMonthly = () => state.prefs.winLen >= 91;
  const winDays = () => { const out = []; for (let i = 0; i < state.prefs.winLen; i++) out.push(addD(state.win.start, i)); return out; };

  // Interface du planning selon la vue : boutons, titres, contrôles utiles seulement
  function chrome() {
    const v = state.view;
    const tb = $("ab-temp");
    tb.hidden = !state.tempScope || v === "year";
    if (state.tempScope) tb.querySelector("span").textContent = `Vue ouverte depuis À valider : ${state.tempScope.label}.`;
    $("ab-view").replaceChildren(...VIEWS.map(([k, label]) => {
      const b = button(label, "ug-chip", () => setView(k));
      b.setAttribute("aria-pressed", String(v === k));
      return b;
    }));
    $("ab-win-wrap").hidden = v !== "window";
    $("ab-ov-wrap").hidden = v !== "year";
    $("ab-winlen").value = String(state.prefs.winLen);
    for (const id of ["ab-scope", "ab-rows"]) $(id).closest("label").hidden = v === "year";
    $("ab-pick-toggle").hidden = v === "year";
    if (v === "year") $("ab-pick").hidden = true;
    $("ab-scroll").hidden = v === "year";
    $("ab-ov").hidden = v !== "year";
    document.querySelector("#ab-p-plan > .ab-legend").hidden = v === "year";
    $("ab-detail").hidden = true;
    $("ab-prev").setAttribute("aria-label", v === "year" ? "Année précédente" : v === "window" && !winMonthly() ? "Semaine précédente" : "Mois précédent");
    $("ab-next").setAttribute("aria-label", v === "year" ? "Année suivante" : v === "window" && !winMonthly() ? "Semaine suivante" : "Mois suivant");
    $("ab-scroll").setAttribute("aria-label", v === "window" ? "Planning des absences, fenêtre glissante" : "Planning mensuel des absences");
    if (v === "year") $("ab-title").textContent = String(state.ov.year);
    if (v === "window") { const d = winDays(); $("ab-title").textContent = `${fmtDM(d[0])}.${d[0].slice(0, 4)} – ${fmtDM(d[d.length - 1])}.${d[d.length - 1].slice(0, 4)}`; }
  }
  function setView(k) {
    if (k === "window" && state.view !== "window") {
      const t = todayIso();
      const first = monthStart(state.month.y, state.month.m);
      state.win.start = first.slice(0, 7) === t.slice(0, 7) ? mondayOf(t) : first;
    }
    if (k === "year" && !state.ov.clinic) state.ov.clinic = overviewClinics()[0] || "";
    state.view = k;
    renderGrid();
  }
  function shiftView(n) {
    if (state.view === "year") state.ov.year += n;
    else if (state.view === "window") state.win.start = winMonthly() ? addMonths(state.win.start, n) : addD(state.win.start, 7 * n);
    else { const d = new Date(Date.UTC(state.month.y, state.month.m + n, 1)); state.month = { y: d.getUTCFullYear(), m: d.getUTCMonth() }; }
    renderGrid();
  }
  function goToday() {
    const t = new Date();
    if (state.view === "year") state.ov.year = t.getFullYear();
    else if (state.view === "window") state.win.start = mondayOf(todayIso());
    else state.month = { y: t.getFullYear(), m: t.getMonth() };
    renderGrid();
  }
  function pickMonth(y, m) {
    if (state.view === "year") state.ov.year = y;
    else if (state.view === "window") state.win.start = monthStart(y, m);
    else state.month = { y, m };
    renderGrid();
  }
  function pickerValue() {
    if (state.view === "year") return { y: state.ov.year, m: 0 };
    if (state.view === "window") return { y: Number(state.win.start.slice(0, 4)), m: Number(state.win.start.slice(5, 7)) - 1 };
    return { y: state.month.y, m: state.month.m };
  }
  function shownLine(all, people) {
    $("ab-shown").textContent = all.length
      ? `${plur(people.length, "personne affichée", "personnes affichées")}` + (all.length > people.length ? ` sur ${all.length} (augmentez « Lignes affichées » pour voir les autres)` : "")
      : "Aucune personne sélectionnée : utilisez « Choisir les personnes » ou changez de clinique.";
  }

  // Fenêtre glissante : N semaines ou mois à partir d'une date ; une absence est une barre continue, même à cheval sur deux mois
  async function renderWindow() {
    const days = winDays();
    const len = days.length, from = days[0], to = days[len - 1];
    let byUser, cal;
    try { ({ byUser, cal } = await loadRange(from, to)); } catch (e) {
      $("ug-status").hidden = false;
      return say($("ug-status"), "Chargement du planning impossible : " + e.message, "error");
    }
    state.cur = { byUser, cal };
    const all = selection();
    const limit = state.tempScope ? 0 : state.prefs.rows;
    const people = limit ? all.slice(0, limit) : all;
    shownLine(all, people);
    $("ab-scroll").replaceChildren(buildWindow(days, byUser, cal, people));
    $("ab-detail").hidden = true;
  }
  // Tableau d'une fenêtre de jours pour des personnes données (planning et mini-planning de « À valider »).
  // opts.mini : { hl: Set de jours surlignés, reqId : personne mise en évidence, count : ligne « absents par jour » } ; sans effet sur le planning principal.
  function buildWindow(days, byUser, cal, people, opts) {
    const mini = opts || null;
    const len = days.length, from = days[0], to = days[len - 1];
    const today = todayIso();
    const narrow = !mini && len >= 91;
    const hl = mini && mini.hl;
    const hlc = (day) => (hl && hl.has(day) ? " ab-hl" : "");
    const wk = (day) => { const w = pd(day).getUTCDay(); return w === 0 || w === 6 || holidayOf(day); };
    const ms = (day, i) => (i > 0 && day.slice(8) === "01" ? " ab-ms" : "");
    const table = el("table", "ab-grid ab-win ab-w" + len + (narrow ? " ab-narrow" : len > 28 ? " ab-mid" : "") + (mini ? " ab-mini-grid" : ""));
    if (mini) table.style.minWidth = `${120 + len * 22}px`;
    table.append(el("caption", "visually-hidden", `Absences du ${fmtCH(from)} au ${fmtCH(to)}`));
    const h1 = el("tr"), h2 = el("tr");
    const corner = el("th", "ab-name", "Collaborateur");
    corner.scope = "col"; corner.rowSpan = 2;
    h1.append(corner);
    for (let i = 0; i < len;) {
      const mo = days[i].slice(0, 7);
      let j = i; while (j + 1 < len && days[j + 1].slice(0, 7) === mo) j++;
      const n = j - i + 1, mi = Number(mo.slice(5)) - 1;
      const th = el("th", "ab-mh" + ms(days[i], i), n < 4 ? "" : n < 8 ? MONTHS[mi].slice(0, 3) + "." : `${MONTHS[mi][0].toUpperCase()}${MONTHS[mi].slice(1)} ${mo.slice(0, 4)}`);
      th.colSpan = n; th.scope = "colgroup";
      h1.append(th);
      i = j + 1;
    }
    days.forEach((day, i) => {
      const d = Number(day.slice(8)), w = pd(day).getUTCDay();
      const th = el("th", "ab-d" + (wk(day) ? " ab-we" : "") + (day === today ? " ab-today" : "") + ms(day, i) + hlc(day));
      th.scope = "col"; th.title = fmtCH(day);
      if (narrow) {
        const show = w === 1 || d === 1;
        th.append(show ? document.createTextNode(String(d)) : el("span", "visually-hidden", String(d)));
      } else th.append(el("span", "ab-dow", DOW[w]), document.createTextNode(String(d)));
      h2.append(th);
    });
    const thead = el("thead"); thead.append(h1, h2); table.append(thead);
    const body = el("tbody");
    // Agenda commun : une cellule par jour
    const calTr = el("tr", "ab-cal");
    const cth = el("th", "ab-name"); cth.scope = "row";
    cth.append(el("span", "ab-pname", "Fériés et événements"), el("span", "ab-pclinic muted", "Vacances scolaires VD, agenda commun"));
    calTr.append(cth);
    days.forEach((day, i) => {
      const td = el("td", "ab-c ab-cal-c" + (pd(day).getUTCDay() % 6 === 0 ? " ab-we" : "") + (day === today ? " ab-today" : "") + ms(day, i) + hlc(day));
      const list = calEntries(day, cal);
      if (list.length) {
        const top = list[0];
        td.className += ` ab-cal-${top.kind}`;
        td.textContent = narrow ? "" : CAL_LETTER[top.kind];
        td.dataset.cal = day;
        const label = list.map((x) => x.label).join(" ; ");
        td.title = label;
        const prev = i > 0 ? days[i - 1] : null;
        if (!mini && (!prev || calEntries(prev, cal).map((x) => x.label).join() !== list.map((x) => x.label).join())) { td.tabIndex = 0; td.setAttribute("role", "button"); td.setAttribute("aria-label", `${fmtCH(day)} : ${label}`); }
      }
      calTr.append(td);
    });
    body.append(calTr);
    for (const p of people) {
      const tr = el("tr", (p.is_me ? "ab-me" : "") + (mini && mini.reqId === p.id ? " ab-req" : ""));
      const th = el("th", "ab-name"); th.scope = "row";
      th.append(el("span", "ab-pname", p.name + (p.is_me ? " (moi)" : "")), el("span", "ab-pclinic muted", (p.clinics || []).join(", ")));
      tr.append(th);
      const list = byUser.get(p.id) || [];
      for (let i = 0; i < len;) {
        const day = days[i];
        const a = list.find((x) => x.start_date <= day && day <= x.end_date);
        if (!a) {
          tr.append(el("td", "ab-c" + (wk(day) ? " ab-we" : "") + (day === today ? " ab-today" : "") + ms(day, i) + hlc(day)));
          i++;
          continue;
        }
        // Mini-planning : une barre ne traverse pas la limite des jours surlignés
        let j = i; while (j + 1 < len && days[j + 1] <= a.end_date && (!hl || hl.has(days[j + 1]) === hl.has(day))) j++;
        const span = j - i + 1, left = a.start_date < from, right = a.end_date > to;
        const td = el("td", `ab-c ab-bar-c ab-k-${a.kind} ab-s-${a.status}` + (a.change_type ? " ab-chg" : "") + ms(day, i) + hlc(day));
        td.colSpan = span;
        const name = span >= 4 ? KINDS[a.kind][0] : KINDS[a.kind][1];
        td.textContent = [left ? "◂" : "", name, span >= 8 ? `${fmtDM(a.start_date)} – ${fmtDM(a.end_date)}` : "", right ? "▸" : ""].filter(Boolean).join(" ");
        const label = `${p.name} : ${KINDS[a.kind][0]}, ${STATUS[a.status].toLowerCase()}, ${period(a.start_date, a.end_date)}`
          + (a.change_type === "delete" ? " (suppression demandée)" : a.change_type === "modify" ? " (modification demandée)" : "");
        td.title = label;
        if (!mini) { td.dataset.id = a.id; td.dataset.user = p.id; td.tabIndex = 0; td.setAttribute("role", "button"); td.setAttribute("aria-label", label); }
        tr.append(td);
        i = j + 1;
      }
      body.append(tr);
    }
    // Mini-planning : nombre de personnes absentes (demandes comprises) chaque jour ouvrable
    if (mini && mini.count) {
      const tr = el("tr", "ab-count-row");
      const th = el("th", "ab-name"); th.scope = "row";
      th.append(el("span", "ab-pname", "Absents ou en demande (personnes affichées)"));
      tr.append(th);
      days.forEach((day, i) => {
        const n = people.filter((p) => (byUser.get(p.id) || []).some((x) => x.start_date <= day && day <= x.end_date)).length;
        const td = el("td", "ab-c" + (wk(day) ? " ab-we" : "") + ms(day, i) + hlc(day), !wk(day) && n ? String(n) : "");
        if (!wk(day)) td.title = `${fmtCH(day)} : ${plur(n, "absent", "absents")}`;
        tr.append(td);
      });
      body.append(tr);
    }
    table.append(body);
    return table;
  }

  // Vue d'ensemble : une clinique sur une année, une ligne par mois, un jour par colonne, teinte selon le nombre d'absents et le seuil
  function overviewClinics() {
    const mine = new Set([...(state.ctx.clinics || []), ...(state.ctx.validates || [])]);
    return state.clinics.map((c) => c.clinic).filter((c) => state.isDir || mine.has(c));
  }
  async function renderOverview() {
    const list = overviewClinics();
    const sel = $("ab-ov-clinic");
    if (![...sel.options].map((o) => o.value).every((v, i) => v === list[i]) || sel.options.length !== list.length) {
      sel.replaceChildren(...list.map((c) => { const o = el("option", null, c); o.value = c; return o; }));
    }
    if (!list.includes(state.ov.clinic)) state.ov.clinic = (state.ctx.clinics || []).find((c) => list.includes(c)) || list[0] || "";
    sel.value = state.ov.clinic;
    const box = $("ab-ov-scroll");
    const info = $("ab-ov-info");
    $("ab-shown").textContent = "";
    if (!state.ov.clinic) { box.replaceChildren(el("p", "muted ab-ov-empty", "Aucune clinique à afficher : la vue d'ensemble porte sur vos cliniques et sur celles que vous validez.")); info.textContent = ""; return; }
    const y = state.ov.year, key = `ov|${state.ov.clinic}|${y}`;
    let rows;
    try {
      if (!state.cache.has(key)) {
        const { data, error } = await sb.rpc("absence_load", { p_clinic: state.ov.clinic, p_from: `${y}-01-01`, p_to: `${y}-12-31` });
        if (error) throw error;
        state.cache.set(key, data || []);
      }
      rows = state.cache.get(key);
    } catch (e) { return say($("ug-status"), "Chargement de la vue d'ensemble impossible : " + e.message, "error"), ($("ug-status").hidden = false); }
    const byDay = new Map(rows.map((r) => [String(r.day).slice(0, 10), r]));
    const max = rows.length ? rows[0].max_absent : 0;
    state.ovData = byDay;
    info.textContent = `${state.ov.clinic} : seuil de ${plur(max, "absent simultané", "absents simultanés")} (réglé par l'administration). Les demandes en cours comptent. Cliquez sur un jour pour voir qui est absent.`;
    const today = todayIso();
    const table = el("table", "ab-grid ab-heat");
    table.append(el("caption", "visually-hidden", `Absences de la clinique ${state.ov.clinic} en ${y}`));
    const head = el("tr");
    const corner = el("th", "ab-name", "Mois"); corner.scope = "col"; head.append(corner);
    for (let d = 1; d <= 31; d++) { const th = el("th", "ab-d", String(d)); th.scope = "col"; head.append(th); }
    const thead = el("thead"); thead.append(head); table.append(thead);
    const body = el("tbody");
    for (let m = 0; m < 12; m++) {
      const tr = el("tr");
      const th = el("th", "ab-name", `${MONTHS[m][0].toUpperCase()}${MONTHS[m].slice(1)}`); th.scope = "row"; tr.append(th);
      const n = Number(monthEnd(y, m).slice(8));
      for (let d = 1; d <= 31; d++) {
        if (d > n) { tr.append(el("td", "ab-c ab-void")); continue; }
        const day = `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
        const w = pd(day).getUTCDay();
        const r = byDay.get(day) || { n: 0 };
        const level = r.n === 0 ? 0 : r.n < max ? 1 : r.n === max ? 2 : 3;
        const td = el("td", `ab-c ab-h${level}` + (w === 0 || w === 6 || holidayOf(day) ? " ab-wk" : "") + (day === today ? " ab-today" : ""));
        if (r.n) {
          td.textContent = String(r.n);
          td.dataset.day = day; td.tabIndex = 0; td.setAttribute("role", "button");
          td.setAttribute("aria-label", `${fmtCH(day)} : ${plur(r.n, "absent", "absents")} sur un seuil de ${max}` + (level === 3 ? ", seuil dépassé" : level === 2 ? ", seuil atteint" : ""));
        } else td.title = fmtCH(day);
        tr.append(td);
      }
      body.append(tr);
    }
    table.append(body);
    box.replaceChildren(table);
    $("ab-detail").hidden = true;
  }
  function showLoadDetail(day) {
    const r = state.ovData && state.ovData.get(day);
    if (!r) return;
    const box = $("ab-detail");
    box.replaceChildren();
    const head = el("div", "ab-detail-head");
    head.append(el("strong", null, `${fmtCH(day)} · ${state.ov.clinic}`), el("span", "ug-badge" + (r.n > r.max_absent ? " ug-warn" : ""), `${plur(r.n, "absent", "absents")} sur un seuil de ${r.max_absent}`));
    box.append(head);
    const names = r.names || [];
    if (names.length) { const ul = el("ul", "ab-ov-names"); names.forEach((n) => ul.append(el("li", null, n))); box.append(ul); }
    if (names.length < r.n) box.append(el("p", "muted", `${plur(r.n - names.length, "autre personne n'est pas nommée", "autres personnes ne sont pas nommées")} (visibilité choisie par la personne).`));
    const go = button("Ouvrir ce mois dans le planning", "btn btn-outline", () => { state.month = { y: Number(day.slice(0, 4)), m: Number(day.slice(5, 7)) - 1 }; state.view = "month"; renderGrid(); });
    box.append(go);
    box.hidden = false;
  }

  function showCalDetail(day) {
    const { cal } = state.cur;
    const box = $("ab-detail");
    box.replaceChildren();
    box.append(el("strong", null, fmtCH(day)));
    calEntries(day, cal).forEach((x) => {
      const row = el("p");
      row.append(el("span", "ug-badge", CAL_KIND[x.kind]), document.createTextNode(" " + x.label + (x.kind === "ferie" ? "" : ` · ${period(x.start, x.end)}`)));
      box.append(row);
    });
    box.hidden = false;
  }

  async function showDetail(userId, id) {
    const people = new Map(state.people.map((p) => [p.id, p]));
    const a = (state.cur.byUser.get(userId) || []).find((x) => String(x.id) === String(id));
    if (!a) return;
    const p = people.get(userId);
    const pending = a.status === "requested" || !!a.change_type;
    const tok = ++state.detailTok;
    // Décision possible : la demande figure dans « À valider » de cette personne. Chargée à la demande (une seule tentative par session,
    // sauf pour un validateur, dont la liste est rafraîchie si elle date de plus de 60 s)
    const validator = state.isDir || state.ctx.validates.length > 0;
    const stale = state.todoLoaded && validator && Date.now() - state.todoAt > 60000;
    if (pending && (!state.todoTried || stale)) {
      state.todoTried = true;
      const box0 = $("ab-detail");
      box0.replaceChildren(el("p", "muted", "Chargement…")); box0.hidden = false;
      try {
        const { data, error } = await sb.rpc("absence_to_validate");
        if (!error) { state.todoLoaded = true; state.todoAt = Date.now(); state.todo = normTodo(data); }
      } catch (_) { /* pas de décision proposée */ }
      if (tok !== state.detailTok) return;
    }
    const t = pending ? state.todo.find((x) => String(x.id) === String(a.id)) : null;
    const box = $("ab-detail");
    box.replaceChildren();
    const head = el("div", "ab-detail-head");
    head.append(el("strong", null, p ? p.name : "Collaborateur"), el("span", `ug-badge ab-st ab-st-${a.status}`, STATUS[a.status]), el("span", "ug-badge", KINDS[a.kind][0]));
    addNo(head, a.request_no);
    box.append(head);
    box.append(el("p", null, `${period(a.start_date, a.end_date)} · ${plur(workdays(a.start_date, a.end_date), "jour ouvrable", "jours ouvrables")}`));
    if (a.note) box.append(el("p", "muted", "Précision : " + a.note));
    if (t) {
      const prog = t.progress || [];
      box.append(el("p", "muted", prog.length ? `Validation : ${approvalCount(prog)} sur ${prog.length}` : "Validation par l'administration"), approvalsBlock(prog));
    } else if (p && p.is_me && pending) {
      const rows = state.approvals.get(String(a.id)) || [];
      box.append(el("p", "muted", rows.length ? `Validation : ${approvalCount(rows)} sur ${rows.length}` : "Validation par l'administration"), approvalsBlock(rows));
    }
    if (a.change_type === "delete") box.append(el("p", "muted", "Suppression demandée, en attente de décision."));
    if (a.change_type === "modify") box.append(el("p", "muted", `Modification demandée : ${period(String(a.change_start).slice(0, 10), String(a.change_end).slice(0, 10))}, en attente de décision.`));
    if (t) {
      const ops = opinionsBlock(t.opinions);
      if (ops) box.append(ops);
      const w = warnBox(t.conflicts, "Attention : trop d'absences en même temps si vous validez");
      if (w) box.append(w);
      box.append(...decisionControls(t, async (msg) => {
        await afterChange();
        const done = el("p", "form-msg ok", msg); done.setAttribute("role", "status");
        box.replaceChildren(done); box.hidden = false;
      }));
    }
    if (p && p.is_me) box.append(button("Gérer dans « Mes absences »", "btn btn-outline", () => setTab("mine")));
    box.hidden = false;
  }

  // ----- Choix des personnes -----
  function renderPicker() {
    const q = norm($("ab-pick-q").value);
    const chosen = new Set(selection().map((p) => p.id));
    const list = $("ab-pick-list");
    list.replaceChildren();
    for (const p of state.people.slice().sort((x, y) => compareNames(x, y, sortMode()))) {
      if (q && !norm(p.name + " " + (p.clinics || []).join(" ")).includes(q)) continue;
      const lab = el("label", "cg-check ab-pick-item");
      const cb = el("input");
      cb.type = "checkbox"; cb.checked = chosen.has(p.id); cb.value = p.id;
      cb.addEventListener("change", () => {
        const ids = new Set(selection().map((x) => x.id));
        cb.checked ? ids.add(p.id) : ids.delete(p.id);
        setCustom([...ids]);
      });
      lab.append(cb, el("span", null, p.name + (p.is_me ? " (moi)" : "")), el("span", "muted ab-pclinic", (p.clinics || []).join(", ")));
      list.append(lab);
    }
    if (!list.children.length) list.append(el("p", "muted", "Aucune personne trouvée."));
    renderOrder();
  }
  function setCustom(ids) {
    state.tempScope = null;
    state.prefs.scope = "custom"; state.prefs.ids = ids;
    savePrefs(); fillScope(); renderGrid();
  }

  // ----- Demande d'absence -----
  function updateDays() {
    const a = $("ab-start").value, b = $("ab-end").value;
    $("ab-days").textContent = a && b && b >= a ? `${plur(workdays(a, b), "jour ouvrable", "jours ouvrables")} (hors week-ends et fériés vaudois), ${plur((pd(b) - pd(a)) / 864e5 + 1, "jour calendaire", "jours calendaires")}` : "";
    $("ab-note-hint").textContent = $("ab-kind").value === "autre" ? "(obligatoire)" : "(facultatif)";
  }
  // Le formulaire crée un brouillon. « Demander l'absence » ouvre ensuite la fenêtre d'envoi groupé ;
  // « Enregistrer en brouillon » s'arrête là (le bandeau des brouillons permet d'envoyer plus tard).
  async function createDraft(openAfter) {
    const msg = $("ab-msg"), warn = $("ab-warn");
    warn.replaceChildren();
    const kind = $("ab-kind").value, note = $("ab-note").value.trim(), start = $("ab-start").value, end = $("ab-end").value;
    if (!start || !end) return say(msg, "Indiquez les dates de début et de fin.", "error");
    if (end < start) return say(msg, "La fin doit être le même jour ou après le début.", "error");
    if (kind === "autre" && note.length < 2) return say(msg, "Pour le motif « autre », indiquez une précision.", "error");
    const btns = [$("ab-send"), $("ab-save")];
    btns.forEach((b) => (b.disabled = true));
    say(msg, "Préparation…");
    try {
      const target = $("ab-for").value;
      if ((target || "") !== (sd.target || "")) { sd.target = target; sd.pending = []; }
      const { data, error } = target
        ? await sb.rpc("absence_request_for", { p_user: target, p_kind: kind, p_note: note, p_start: start, p_end: end })
        : await sb.rpc("absence_request", { p_kind: kind, p_note: note, p_start: start, p_end: end });
      if (error) return say(msg, error.message, "error");
      $("ab-note").value = "";
      if (openAfter) {
        say(msg, "");
        await loadDrafts();
        await openSend((data.conflicts || []).concat(sd.pending || []), target);
        sd.pending = [];
      } else {
        sd.pending = (data.conflicts || []).concat(sd.pending || []);
        $("ab-start").value = ""; $("ab-end").value = ""; updateDays();
        await loadDrafts();
        say(msg, `Demande du ${period(start, end)} enregistrée en brouillon. Ajoutez-en une autre ou envoyez-les ensemble depuis le bandeau ci-dessous.`, "ok");
        const w = warnBox(data.conflicts || [], "Attention : trop d'absences en même temps");
        if (w) warn.append(w);
      }
    } finally { btns.forEach((b) => (b.disabled = false)); }
  }
  const submitRequest = (ev) => { ev.preventDefault(); return createDraft(true); };
  // Depuis la fenêtre d'envoi : retour au formulaire, la demande déjà créée reste en brouillon.
  function addAnother() {
    sd.pending = (sd.conflicts || []).concat(sd.pending || []);
    $("sd").close();
    $("ab-start").value = ""; $("ab-end").value = ""; $("ab-note").value = ""; updateDays();
    say($("ab-msg"), "Votre demande est gardée en brouillon. Saisissez la suivante, puis « Demander l'absence » pour tout envoyer ensemble.", "ok");
    $("ab-form").scrollIntoView({ behavior: "smooth", block: "start" });
    $("ab-start").focus({ preventScroll: true });
  }
  async function afterChange() {
    state.cache.clear();
    hist.stale = true; // l'historique se recharge à sa prochaine ouverture
    await Promise.all([renderGrid(), loadMine(), loadDrafts(), refreshPending(), (state.ctx.validates.length || state.isDir) ? Promise.all([loadTodo(), loadRejected()]) : state.todoLoaded ? loadTodo() : null]);
  }

  // ----- Brouillons et popup d'envoi -----
  const sd = { target: "", info: { validators: [], fallback: false }, conflicts: [], pending: [] };
  const names = (list) => list.map((v) => v.name).join(", ");
  async function loadDrafts() {
    const tgt = sd.target || null;
    const [list, appr] = await Promise.all([sb.rpc("absence_list", { p_user: tgt }), sb.rpc("absence_approvals_all", { p_user: tgt })]);
    state.drafts = (list.data || []).filter((a) => a.status === "draft" && (!tgt || a.requested_by === state.ctx.me)).map((a) => Object.assign(a, { start_date: String(a.start_date).slice(0, 10), end_date: String(a.end_date).slice(0, 10) }));
    if (!tgt) state.approvals = groupApprovals(appr.data);
    const n = state.drafts.length;
    $("ab-drafts").hidden = !n || $("sd").open;
    $("ab-drafts-text").textContent = n ? `${plur(n, "demande", "demandes")} en brouillon, pas encore envoyée${n > 1 ? "s" : ""} aux validateurs${tgt ? " (pour " + secName(tgt) + ")" : ""}.` : "";
    if (!state.who) renderMine(); // l'avancement des validations vient d'arriver
  }
  function groupApprovals(rows) {
    const m = new Map();
    for (const r of rows || []) { const k = String(r.absence_id); if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
    return m;
  }
  const secName = (id) => (state.secOf.find((c) => c.id === id) || {}).name || "votre médecin cadre";
  async function openSend(conflicts, target) {
    if (target !== undefined) { sd.target = target || ""; await loadDrafts(); }
    sd.conflicts = conflicts || [];
    $("sd-main").hidden = false; $("sd-confirm").hidden = true; $("sd-done").hidden = true;
    say($("sd-msg"), "");
    const { data } = sd.target ? await sb.rpc("absence_my_validators_for", { p_user: sd.target }) : await sb.rpc("absence_my_validators");
    sd.info = data || { validators: [], fallback: false };
    renderSend();
    if (!$("sd").open) $("sd").showModal();
    $("ab-drafts").hidden = true;
  }
  // 12 noms au plus venant du serveur ; au-delà, un résumé suivi des premiers noms
  function listWho(info) {
    const v = info.validators || [];
    if (!v.length) return "";
    return info.more > 0 ? `${info.summary || plur(v.length + info.more, "personne", "personnes")} (${names(v)} et ${plur(info.more, "autre", "autres")})` : names(v);
  }
  function recipients() {
    return (sd.info.validators || []).length ? listWho(sd.info) : "l'administration";
  }
  function ruleText(info) {
    const st = info.steps || [];
    const rules = new Set(st.map((x) => x.rule));
    if (st.length > 1 && rules.size > 1) return `Règle selon l'étape : ${st.map((x) => `${x.label} (${x.rule === "any" ? "un seul suffit" : "tous"})`).join(" ; ")}.`;
    return info.step_rule === "any" ? "Un seul de ces validateurs suffit à valider chaque absence." : "Chaque absence doit être validée par tous ces validateurs.";
  }
  function renderSend() {
    const v = sd.info.validators || [];
    $("sd-to").textContent = sd.target && v.length ? `Demande pour ${secName(sd.target)} : validateurs prévenus : ${listWho(sd.info)}. ${secName(sd.target)} est aussi informé·e par e-mail.` : !v.length ? "Aucun validateur n'est disponible pour l'instant : la demande sera adressée à l'administration."
      : sd.info.step_kind === "personnes" && sd.info.step_label ? `Validateurs : ${listWho(sd.info)} (${sd.info.step_label})`
      : sd.info.fallback ? `Aucun validateur n'est désigné pour vos cliniques : votre demande sera envoyée à l'administration (${listWho(sd.info)}).`
      : `Vous allez envoyer une demande de validation à : ${listWho(sd.info)}.`;
    $("sd-rule").textContent = (v.length > 1 || sd.info.more > 0) && !sd.info.fallback
      ? ruleText(sd.info)
      + " Ils reçoivent un seul e-mail pour l'ensemble de vos demandes ; vous êtes prévenu·e dès que tout est validé, ou dès qu'un validateur refuse."
      : "Le validateur reçoit un seul e-mail pour l'ensemble de vos demandes ; vous êtes prévenu·e de sa décision.";
    const list = $("sd-list");
    list.replaceChildren();
    for (const a of state.drafts) {
      const li = el("li");
      li.append(el("span", "ab-draft-when", period(a.start_date, a.end_date)), el("span", "ug-badge", KINDS[a.kind][0]),
        el("span", "muted", `${plur(workdays(a.start_date, a.end_date), "jour ouvrable", "jours ouvrables")}${a.note ? " · " + a.note : ""}`));
      li.append(button("Retirer", "btn btn-outline ab-mini", async () => {
        const { error } = sd.target ? await sb.rpc("absence_withdraw_for", { p_id: a.id }) : await sb.rpc("absence_withdraw", { p_id: a.id });
        if (error) return say($("sd-msg"), error.message, "error");
        await loadDrafts(); renderSend();
      }));
      list.append(li);
    }
    if (!state.drafts.length) list.append(el("li", "muted", "Aucune demande en brouillon : utilisez « Ajouter une autre demande »."));
    $("sd-go").disabled = !state.drafts.length;
    const warn = $("sd-warn");
    warn.replaceChildren();
    const w = warnBox(sd.conflicts, "Attention : trop d'absences en même temps");
    if (w) { w.append(el("p", "muted", "La demande peut quand même être envoyée ; les validateurs voient le même avertissement.")); warn.append(w); }
  }
  function askConfirm() {
    const n = state.drafts.length;
    if (!n) return;
    $("sd-confirm-text").textContent = `Vous allez envoyer par e-mail ${n > 1 ? `${n} demandes d'absence` : "1 demande d'absence"} (${state.drafts.map((a) => period(a.start_date, a.end_date)).join(" ; ")}) à : ${recipients()}. Chaque absence devra être validée par tous les validateurs concernés. Confirmer l'envoi ?`;
    $("sd-main").hidden = true; $("sd-confirm").hidden = false;
  }
  async function doSend() {
    const btn = $("sd-yes");
    btn.disabled = true;
    say($("sd-confirm-msg"), "Envoi en cours…");
    try {
      const { data, error } = sd.target ? await sb.rpc("absence_submit_for", { p_user: sd.target }) : await sb.rpc("absence_submit");
      if (error) return say($("sd-confirm-msg"), error.message, "error");
      mailer();
      $("sd-confirm").hidden = true; $("sd-done").hidden = false;
      const who = (data.validators || []).length ? listWho(data) : "l'administration";
      $("sd-done-text").textContent = `${plur(data.count, "demande envoyée", "demandes envoyées")}. ${who} ${(data.validators || []).length > 1 || data.more > 0 ? "seront prévenus" : "sera prévenu·e"} par e-mail. Vous serez prévenu·e par e-mail dès que tout est validé, ou dès qu'un validateur refuse.`;
      say($("sd-confirm-msg"), "");
      await afterChange();
    } finally { btn.disabled = false; }
  }

  // ----- Mes absences -----
  async function loadMine() {
    circuitRefresh();
    const { data, error } = await sb.rpc("absence_list", { p_user: state.who || null });
    if (error) return say($("ab-mine-msg"), "Chargement impossible : " + error.message, "error");
    state.mine = (data || []).map((a) => Object.assign(a, {
      start_date: String(a.start_date).slice(0, 10), end_date: String(a.end_date).slice(0, 10),
      change_start: a.change_start && String(a.change_start).slice(0, 10), change_end: a.change_end && String(a.change_end).slice(0, 10)
    }));
    // Avancement des validations (rechargé à chaque ouverture : un validateur a pu décider entre-temps)
    const r = await sb.rpc("absence_approvals_all", { p_user: state.who || null });
    if (state.who) state.whoApprovals = groupApprovals(r.data); else state.approvals = groupApprovals(r.data);
    state.agendaStatus = {};
    if (state.who || ["clinician", "cdc", "cadre"].includes(state.ctx.role)) {
      const ag = await sb.rpc("absence_agenda_status", { p_user: state.who || null });
      if (!ag.error && ag.data) state.agendaStatus = ag.data;
    }
    fillYears();
    renderMine();
  }

  // Les soldes de vacances et de congrès ne sont plus affichés (17.11.2026) : le décompte officiel se fait dans le logiciel RH.
  function fillYears() {
    const sel = $("ab-year");
    const keep = sel.value;
    const years = new Set([new Date().getFullYear()]);
    state.mine.forEach((a) => { years.add(Number(a.start_date.slice(0, 4))); years.add(Number(a.end_date.slice(0, 4))); });
    sel.replaceChildren();
    const all = el("option", null, "Toutes"); all.value = ""; sel.append(all);
    [...years].sort((a, b) => b - a).forEach((y) => { const o = el("option", null, String(y)); o.value = String(y); sel.append(o); });
    sel.value = keep && [...sel.options].some((o) => o.value === keep) ? keep : String(new Date().getFullYear());
  }

  function fieldRow(label, node) { const l = el("label", null, label); l.append(node); return l; }
  function editForm(a, mode) {
    const f = el("form", "ab-edit");
    f.noValidate = true;
    const kind = el("select");
    Object.entries(KINDS).forEach(([k, [l]]) => { const o = el("option", null, l); o.value = k; kind.append(o); });
    kind.value = a.kind;
    const note = el("input"); note.type = "text"; note.maxLength = 200; note.value = a.note || "";
    const start = el("input"); start.type = "date"; start.value = a.start_date;
    const end = el("input"); end.type = "date"; end.value = a.end_date;
    start.addEventListener("change", () => { if (!end.value || end.value < start.value) end.value = start.value; });
    const row = el("div", "ab-fields");
    row.append(fieldRow("Motif", kind), fieldRow("Précision", note), fieldRow("Du", start), fieldRow("Au (inclus)", end));
    let conf = null;
    if (mode === "direction") {
      conf = el("input"); conf.type = "checkbox"; conf.checked = !!a.confidential;
      const cl = el("label", "cg-check", ""); cl.append(conf, document.createTextNode(" Confidentiel (type visible de la personne et de la direction seulement)"));
      const sync = () => { cl.hidden = kind.value !== "autre"; };
      kind.addEventListener("change", sync); sync();
      row.append(cl);
    }
    const out = el("p", "form-msg");
    out.setAttribute("role", "status");
    const actions = el("div", "btn-row");
    const save = el("button", "btn", mode === "change" || mode === "changefor" ? "Envoyer la demande de modification" : mode === "direction" ? "Enregistrer (validée d'office)" : a.status === "rejected" ? "Renvoyer en validation" : "Enregistrer");
    save.type = "submit";
    actions.append(save, button("Annuler", "btn btn-outline", () => renderMine()));
    f.append(row, out, actions);
    f.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      if (!start.value || !end.value || end.value < start.value) return say(out, "Vérifiez les dates.", "error");
      save.disabled = true;
      const args = { p_kind: kind.value, p_note: note.value.trim(), p_start: start.value, p_end: end.value };
      const { data, error } = mode === "changefor"
        ? await sb.rpc("absence_request_change_for", Object.assign({ p_user: state.who, p_id: a.id, p_type: "modify" }, args))
        : mode === "change"
        ? await sb.rpc("absence_request_change", Object.assign({ p_id: a.id, p_type: "modify" }, args))
        : mode === "direction"
          ? await sb.rpc("absence_direction_update", Object.assign({ p_id: a.id, p_confidential: kind.value === "autre" ? !!(conf && conf.checked) : false }, args))
          : await sb.rpc("absence_update", Object.assign({ p_id: a.id }, args));
      if (error) { save.disabled = false; return say(out, error.message, "error"); }
      state.mineWarn = warnBox(data.conflicts, "Attention : trop d'absences en même temps");
      say($("ab-mine-msg"), mode === "change" || mode === "changefor" ? "Demande de modification envoyée aux validateurs : l'absence reste validée aux anciennes dates jusqu'à leur décision (tous doivent l'accepter)." : "Demande modifiée : elle repasse en brouillon, envoyez-la pour relancer la validation.", "ok");
      if (mode === "direction") {
        say($("ab-mine-msg"), a.user_id === state.ctx.me ? "Absence modifiée." : "Absence modifiée par la direction : notification mise en file.", "ok"); mailer();
      }
      if (mode === "change" || mode === "changefor") mailer();
      await afterChange();
    });
    return f;
  }

  // Étape en cours d'une demande (circuit configurable) : champs step_kind / step_label, sinon instantané `circuit` (étape « current »), sinon `stage` de compatibilité
  function curStep(r) {
    if (r.step_kind || r.step_label) return { kind: r.step_kind || "clinique", label: r.step_label || (r.step_kind === "visa" ? "Visa de la direction" : "Validateurs de clinique") };
    // étapes bloquantes de la colonne en cours, jointes par « + » (les étapes consultatives n'arrêtent pas la demande)
    const cur = (r.circuit || []).filter((x) => x.current && x.blocking !== false);
    if (cur.length) return { kind: cur.some((x) => x.kind === "visa") ? "visa" : cur[0].kind, label: cur.map((x) => x.label).join(" + ") };
    return r.stage === 2 ? { kind: "visa", label: "Visa de la direction" } : { kind: "clinique", label: "Validateurs de clinique" };
  }
  // Avancement de la validation : qui a validé, qui attend, qui a refusé (regroupé par étape quand le circuit en compte plusieurs)
  function approvalsBlock(rows) {
    const box = el("div", "ab-appr");
    if (!rows.length) { box.append(el("p", "muted", "Aucun validateur désigné : l'administration décide.")); return box; }
    const LABEL = { approved: "a validé", pending: "en attente", rejected: "a refusé", skipped: "étape close sans décision individuelle" };
    const list = (items) => {
      const ul = el("ul", "ab-appr-list");
      items.forEach((r) => {
        const li = el("li", "ab-appr-" + r.decision);
        li.append(el("strong", null, r.validator_name || r.name),
          document.createTextNode(` : ${LABEL[r.decision] || r.decision}${r.decided_at && ["approved", "rejected"].includes(r.decision) ? " le " + fmtCH(r.decided_at) : ""}${r.comment ? " · « " + r.comment + " »" : ""}`));
        ul.append(li);
      });
      return ul;
    };
    const groups = new Map();
    [...rows].sort((a, b) => (a.step ?? 0) - (b.step ?? 0)).forEach((r) => {
      const k = r.step_label || "";
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    });
    if (groups.size <= 1) { box.append(list(rows)); return box; }
    for (const [label, items] of groups) box.append(el("p", "ab-appr-step", label), list(items));
    return box;
  }
  const approvalCount = (rows) => rows.filter((r) => r.decision === "approved").length;
  // Date et heure d'une case Ultragenda : toujours à l'heure de Zurich, JJ.MM.AAAA HH:MM
  function zurich(ts) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("fr-CH", { timeZone: "Europe/Zurich", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ts)).map((p) => [p.type, p.value]));
    return { date: `${parts.day}.${parts.month}.${parts.year}`, time: `${parts.hour}:${parts.minute}` };
  }
  const fmtDT = (ts) => new Date(ts).toLocaleString("fr-CH", { dateStyle: "short", timeStyle: "short" });

  // Renvoyer l'e-mail de validation (rappel) aux validateurs qui n'ont pas encore décidé
  async function resend(ids) {
    const out = $("ab-mine-msg");
    say(out, "Envoi du rappel…");
    const { data, error } = await sb.rpc("absence_resend", { p_ids: ids });
    if (error) return say(out, error.message, "error");
    mailer();
    say(out, `Rappel envoyé à ${data.recipients.join(", ")} pour ${plur(data.count, "demande", "demandes")}. Sans réponse, vérifiez le dossier de courrier indésirable de la personne : elle peut aussi ouvrir directement « Absences », onglet « À valider », dans The Hive.`, "ok");
    await loadMine();
  }

  // ----- Formulaire papier du département (PDF pré-rempli, signé électroniquement) -----
  // Un formulaire couvre toutes les absences validées du même envoi (même membre, même date d'envoi).
  // PDF de l'état actuel d'une demande (demandée, validée ou refusée) ; msgNode : zone de message de l'onglet appelant
  async function downloadForm(a, documentId, msgNode) {
    const msg = msgNode || $("ab-mine-msg");
    const ids = [a.id];
    say(msg, "Préparation du formulaire…");
    const { data, error } = await sb.functions.invoke("notify-absence", { body: documentId ? { action: "form", document_id: documentId } : { action: "form", ids } });
    if (error || !data || !data.pdf) {
      let code = "";
      try { code = (await error.context.json()).error; } catch (e) { /* message générique */ }
      return say(msg, code === "no_form" ? "Aucun formulaire n'est prévu pour ce rôle." : code === "forbidden" ? "Accès refusé." : "Le formulaire n'a pas pu être généré. Réessayez dans un instant.", "error");
    }
    const bytes = Uint8Array.from(atob(data.pdf), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
    const link = document.createElement("a");
    link.href = url; link.download = data.file; document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    say(msg, "Formulaire téléchargé.", "ok");
  }
  // Bouton « Imprimer le formulaire (PDF) » : demandée, validée (document figé) ou refusée ; ni brouillon ni annulée. Aucun e-mail n'est envoyé.
  function formButton(a, own, msgNode) {
    if (!["requested", "approved", "rejected"].includes(a.status) || !a.submitted_at) return null;
    if (own && !["clinician", "cdc", "cadre"].includes(state.ctx.role)) return null;
    return button("Imprimer le formulaire (PDF)", "btn btn-outline", () => downloadForm(a, null, msgNode));
  }

  function historyPanel(a, own) {
    const details = el("details", "ab-progress");
    details.append(el("summary", null, "Historique et versions des documents"));
    let loaded = false;
    details.addEventListener("toggle", async () => {
      if (!details.open || loaded) return;
      loaded = true;
      try {
        if (own || isBehalf() || ["admin", "direction"].includes(state.ctx.role)) {
          const { data, error } = await sb.rpc("absence_history", { p_id: a.id });
          if (error) throw error;
          for (const event of data || []) {
            const before = event.before_data || {}, after = event.after_data || {};
            const row = after.id ? after : before;
            const action = event.action === "BASELINE" ? "État à la mise en service de l’historique" : event.entity === "absences" ? ({ INSERT: "Demande créée", UPDATE: "Demande mise à jour", DELETE: "Demande retirée" }[event.action] || event.action) : "Tour de validation : " + (after.decision || before.decision || after.opinion || before.opinion || "en attente");
            details.append(el("p", "muted", `${fmtDT(event.at)} · ${event.actor_name || "Système"} · ${action}${row.start_date ? " · " + period(row.start_date, row.end_date) : ""}${before.start_date && after.start_date && (before.start_date !== after.start_date || before.end_date !== after.end_date) ? " (avant : " + period(before.start_date, before.end_date) + ")" : ""}`));
          }
        }
        const { data: docs, error } = await sb.rpc("absence_document_versions", { p_id: a.id });
        if (error) throw error;
        for (const doc of docs || []) {
          const labels = { approved: "Formulaire", modified: "Rectificatif", modified_direct: "Rectificatif direction", cancelled: "Annulation", cancelled_direct: "Annulation direction", approved_direct: "Saisie direction", legacy_snapshot: "État repris à la mise en service" };
          details.append(button(`${labels[doc.action] || "Document"} D${doc.id} · ${fmtDT(doc.at)}`, "btn btn-outline", () => downloadForm(a, doc.id)));
        }
        if (!docs?.length) details.append(el("p", "muted", "Aucun document disponible."));
      } catch (_) { details.append(el("p", "form-msg error", "Historique indisponible. Refermez puis réessayez.")); loaded = false; }
    });
    return details;
  }

  function absenceCard(a, own) {
    const card = el("article", `card ab-item ab-item-${a.status}`);
    if (a.status !== "draft") card.append(historyPanel(a, own));
    const head = el("div", "ab-item-head");
    head.append(el("strong", null, period(a.start_date, a.end_date)), el("span", "ug-badge", KINDS[a.kind][0]),
      el("span", `ug-badge ab-st ab-st-${a.status}`, STATUS[a.status]));
    if (a.confidential) head.append(el("span", "ug-badge", "Confidentiel"));
    addNo(head, a.request_no);
    const ug = a.status === "approved" ? state.agendaStatus[String(a.id)] : null;
    if (ug) head.append(el("span", "ug-badge " + (ug.status === "done" ? "ab-ug-done" : "ab-ug-todo"), ug.status === "done" ? `Ultragenda : bloqué le ${zurich(ug.done_at).date}` : "Ultragenda : à bloquer"));
    card.append(head);
    card.append(el("p", "muted ab-item-meta", plur(workdays(a.start_date, a.end_date), "jour ouvrable", "jours ouvrables")
      + (a.note ? " · " + a.note : "")));
    if (a.decision && (a.decision_comment || a.decision === "rejected" || a.decision === "change_rejected")) {
      card.append(el("p", "ab-decision", `${DECISION[a.decision]}${a.decided_at ? " le " + fmtCH(a.decided_at) : ""}${a.decision_comment ? " : « " + a.decision_comment + " »" : ""}`));
    }
    if (a.change_type) {
      card.append(el("p", "ab-pending-change", a.change_type === "delete"
        ? "Suppression demandée, en attente de décision. L'absence reste validée en attendant."
        : `Modification demandée : ${a.change_kind ? KINDS[a.change_kind][0] + ", " : ""}${period(a.change_start, a.change_end)}${a.change_note ? " · " + a.change_note : ""}, en attente de décision. L'absence reste validée aux dates actuelles en attendant.`));
    }
    // Avancement : cliquer pour voir qui a validé, qui attend, qui a refusé
    const rows = (own ? state.approvals : state.whoApprovals).get(String(a.id)) || [];
    if (a.status === "requested" || a.status === "rejected" || (a.status === "approved" && a.change_type)) {
      const d = el("details", "ab-progress");
      const total = rows.length;
      d.append(el("summary", null, a.status === "rejected" ? "Voir qui a refusé" : total ? `Voir qui a validé (${approvalCount(rows)} sur ${total})` : "Voir qui décide"));
      d.append(approvalsBlock(rows));
      card.append(d);
    }
    const mySt = curStep(a);
    if (mySt.kind !== "clinique" && (a.status === "requested" || (a.status === "approved" && a.change_type))) {
      card.append(el("p", "ab-pending-change", mySt.kind === "visa" ? "Validée par les validateurs de la clinique : en attente du visa de la direction." : `En cours : ${mySt.label}.`));
    }
    if (a.status === "rejected" && a.decided_at) {
      const gone = new Date(new Date(a.decided_at).getTime() + 14 * 864e5);
      card.append(el("p", "muted ab-item-meta", `Cette demande refusée ne s'affichera plus ici à partir du ${fmtCH(iso(gone))} ; elle reste consultable dans l'historique. Vous pouvez l'archiver dès maintenant.`));
    }
    if (own && (a.status === "requested" || (a.status === "approved" && a.change_type)) && (a.submitted_at || a.resent_at)) {
      card.append(el("p", "muted ab-item-meta", `${a.submitted_at ? "Envoyée aux validateurs le " + fmtDT(a.change_requested_at && a.status === "approved" ? a.change_requested_at : a.submitted_at) : ""}${a.resent_at ? (a.submitted_at ? " · " : "") + "dernier rappel le " + fmtDT(a.resent_at) : ""}`));
    }
    if (a.requested_by_name) card.append(el("p", "muted ab-item-meta", `Saisie par ${a.requested_by_name}`));
    if (a.status === "draft") card.append(el("p", "muted ab-item-meta", "Brouillon : les validateurs ne sont pas encore prévenus. Envoyez-le pour lancer la validation."));
    if (!own && a.status === "rejected" && state.who) {
      const del = el("div", "btn-row ab-actions");
      del.append(button("Archiver cette demande refusée", "btn btn-outline lt-danger", async () => {
        const { error } = await sb.rpc("absence_delete_rejected", { p_id: a.id });
        if (error) return say($("ab-mine-msg"), error.message, "error");
        say($("ab-mine-msg"), "Demande refusée archivée. Elle reste consultable dans l'historique.", "ok");
        await afterChange();
      }));
      card.append(del);
    }
    if (!own && isBehalf()) {
      // la secrétaire agit pour son médecin cadre : mêmes règles que pour lui, hors annulation de changement et refus
      const act = el("div", "btn-row ab-actions");
      const mineEntered = a.requested_by === state.ctx.me;
      if (a.status === "draft" && mineEntered) {
        act.append(button("Envoyer pour validation…", "btn", () => openSend([], state.who)),
          button("Retirer", "btn btn-outline lt-danger", async () => {
            if (!confirm(`Retirer ce brouillon (${period(a.start_date, a.end_date)}) ?`)) return;
            const { error } = await sb.rpc("absence_withdraw_for", { p_id: a.id });
            if (error) return say($("ab-mine-msg"), error.message, "error");
            say($("ab-mine-msg"), "Brouillon retiré.", "ok");
            await afterChange();
          }));
      } else if (a.status === "requested" && mineEntered) {
        act.append(button("Annuler la demande", "btn btn-outline lt-danger", async () => {
          if (!confirm(`Annuler cette demande en cours (${period(a.start_date, a.end_date)}) ?`)) return;
          const { error } = await sb.rpc("absence_withdraw_for", { p_id: a.id });
          if (error) return say($("ab-mine-msg"), error.message, "error");
          say($("ab-mine-msg"), "Demande annulée.", "ok");
          await afterChange();
        }));
      } else if (a.status === "approved" && !a.change_type) {
        act.append(button("Demander une modification", "btn btn-outline", () => act.replaceWith(editForm(a, "changefor"))),
          button("Demander la suppression", "btn btn-outline lt-danger", async () => {
            if (!confirm("Demander la suppression de cette absence validée ? Elle reste validée jusqu'à la décision des validateurs.")) return;
            const { error } = await sb.rpc("absence_request_change_for", { p_user: state.who, p_id: a.id, p_type: "delete", p_kind: null, p_note: null, p_start: null, p_end: null });
            if (error) return say($("ab-mine-msg"), error.message, "error");
            say($("ab-mine-msg"), "Demande de suppression envoyée. L'absence reste validée jusqu'à la décision.", "ok");
            mailer();
            await afterChange();
          }));
      }
      const fbb = formButton(a, false);
      if (fbb) act.append(fbb);
      if (act.children.length) card.append(act);
      return card;
    }
    if (!own) {
      const row = el("div", "btn-row ab-actions");
      const fb = formButton(a, false);
      if (fb) row.append(fb);
      // La direction modifie ou annule au nom du membre (une notification sera envoyée au membre)
      if (state.isDir && state.who && (a.status === "approved" || a.status === "requested")) {
        if (a.status === "approved") row.append(button("Modifier (direction)", "btn btn-outline", () => row.replaceWith(editForm(a, "direction"))));
        row.append(button("Annuler cette absence (direction)", "btn btn-outline lt-danger", async () => {
          if (!confirm(`Annuler l'absence de ${$("ab-who").selectedOptions[0].textContent} (${period(a.start_date, a.end_date)}) ? Une notification sera envoyée au membre.`)) return;
          const { error } = await sb.rpc("absence_direction_cancel", { p_id: a.id });
          if (error) return say($("ab-mine-msg"), error.message, "error");
          say($("ab-mine-msg"), "Absence annulée par la direction : notification mise en file.", "ok");
          mailer();
          await afterChange();
        }));
      }
      if (row.children.length) card.append(row);
      return card;
    }
    const actions = el("div", "btn-row ab-actions");
    const swap = (node) => { actions.replaceWith(node); };
    if (a.status === "draft") {
      actions.append(
        button("Envoyer pour validation…", "btn", () => openSend([])),
        button("Modifier", "btn btn-outline", () => swap(editForm(a, "update"))),
        button("Retirer", "btn btn-outline lt-danger", async () => {
          if (!confirm(`Retirer ce brouillon (${period(a.start_date, a.end_date)}) ?`)) return;
          const { error } = await sb.rpc("absence_withdraw", { p_id: a.id });
          if (error) return say($("ab-mine-msg"), error.message, "error");
          say($("ab-mine-msg"), "Brouillon retiré.", "ok");
          await afterChange();
        }));
    } else if (a.status === "requested") {
      actions.append(
        button("Renvoyer l'e-mail aux validateurs", "btn btn-outline", () => resend([a.id])),
        button("Modifier (repasse en brouillon)", "btn btn-outline", () => swap(editForm(a, "update"))),
        button("Annuler la demande", "btn btn-outline lt-danger", async () => {
          if (!confirm(`Annuler cette demande en cours (${period(a.start_date, a.end_date)}) ? Les validations déjà données seront perdues.`)) return;
          const { error } = await sb.rpc("absence_withdraw", { p_id: a.id });
          if (error) return say($("ab-mine-msg"), error.message, "error");
          say($("ab-mine-msg"), "Demande annulée.", "ok");
          await afterChange();
        }));
    } else if (a.status === "rejected") {
      actions.append(
        button("Modifier et renvoyer", "btn btn-outline", () => swap(editForm(a, "update"))),
        button("Archiver", "btn btn-outline lt-danger", async () => {
          if (!confirm(`Archiver cette demande refusée (${period(a.start_date, a.end_date)}) ? La demande reste consultable dans l'historique.`)) return;
          const { error } = await sb.rpc("absence_delete_rejected", { p_id: a.id });
          if (error) return say($("ab-mine-msg"), error.message, "error");
          say($("ab-mine-msg"), "Demande refusée archivée. Elle reste consultable dans l'historique.", "ok");
          await afterChange();
        }));
    } else if (a.status === "approved" && !a.change_type && state.isDir) {
      // La direction modifie ou annule ses propres absences directement : pas de validation
      actions.append(
        button("Modifier", "btn btn-outline", () => swap(editForm(a, "direction"))),
        button("Annuler cette absence", "btn btn-outline lt-danger", async () => {
          if (!confirm(`Annuler votre absence (${period(a.start_date, a.end_date)}) ?`)) return;
          const { error } = await sb.rpc("absence_direction_cancel", { p_id: a.id });
          if (error) return say($("ab-mine-msg"), error.message, "error");
          say($("ab-mine-msg"), "Absence annulée.", "ok");
          await afterChange();
        }));
    } else if (a.status === "approved" && !a.change_type) {
      actions.append(
        button("Demander une modification", "btn btn-outline", () => swap(editForm(a, "change"))),
        button("Demander la suppression", "btn btn-outline lt-danger", async () => {
          if (!confirm("Demander la suppression de cette absence validée ? Elle reste validée jusqu'à la décision du valideur.")) return;
          const { error } = await sb.rpc("absence_request_change", { p_id: a.id, p_type: "delete", p_kind: null, p_note: null, p_start: null, p_end: null });
          if (error) return say($("ab-mine-msg"), error.message, "error");
          say($("ab-mine-msg"), "Demande de suppression envoyée. L'absence reste validée jusqu'à la décision.", "ok");
          mailer();
          await afterChange();
        }));
    } else if (a.status === "approved" && a.change_type) {
      actions.append(button("Renvoyer l'e-mail aux validateurs", "btn btn-outline", () => resend([a.id])), button("Annuler ma demande de changement", "btn btn-outline", async () => {
        const { error } = await sb.rpc("absence_cancel_change", { p_id: a.id });
        if (error) return say($("ab-mine-msg"), error.message, "error");
        say($("ab-mine-msg"), "Demande de changement annulée.", "ok");
        await afterChange();
      }));
    }
    const fb = formButton(a, true);
    if (fb) actions.append(fb);
    if (actions.children.length) card.append(actions);
    return card;
  }

  const isBehalf = () => !!state.who && state.secOf.some((c) => c.id === state.who);
  function renderMine() {
    const own = !state.who;
    const list = $("ab-mine-list");
    list.replaceChildren();
    if (state.mineWarn) { list.append(state.mineWarn); state.mineWarn = null; }
    const today = todayIso();
    const live = state.mine.filter((a) => a.status !== "cancelled");
    const current = live.filter((a) => a.end_date >= today || a.status === "draft" || a.status === "requested" || a.change_type).sort((a, b) => a.start_date.localeCompare(b.start_date));
    const past = live.filter((a) => !current.includes(a));
    const cancelled = state.mine.filter((a) => a.status === "cancelled");
    const waiting = live.filter((a) => a.status === "requested" || (a.status === "approved" && a.change_type));
    if (own && waiting.length) {
      const bar = el("div", "ab-resend-bar");
      bar.append(el("p", null, "Un validateur n'a pas reçu votre demande ? Renvoyez l'e-mail : seuls ceux qui n'ont pas encore décidé sont relancés (un rappel toutes les 10 minutes au plus)."),
        button(`Renvoyer pour ${plur(waiting.length, "demande en cours", "demandes en cours")}`, "btn btn-outline", () => resend(null)));
      list.append(bar);
    }
    if (!current.length) list.append(el("p", "muted", own ? "Aucune absence à venir. Utilisez le formulaire ci-dessus pour en demander une." : "Aucune absence à venir."));
    current.forEach((a) => list.append(absenceCard(a, own)));
    const fold = (title, items) => {
      if (!items.length) return;
      const d = el("details", "ab-fold");
      d.append(el("summary", null, `${title} (${items.length})`));
      const inner = el("div", "ab-list");
      items.forEach((a) => inner.append(absenceCard(a, false)));
      d.append(inner);
      list.append(d);
    };
    fold("Passées", past);
    fold("Annulées", cancelled);
  }

  // ----- À valider -----
  const normTodo = (data) => (data || []).map((a) => Object.assign(a, {
    start_date: String(a.start_date).slice(0, 10), end_date: String(a.end_date).slice(0, 10),
    change_start: a.change_start && String(a.change_start).slice(0, 10), change_end: a.change_end && String(a.change_end).slice(0, 10)
  }));
  async function loadTodo() {
    const { data, error } = await sb.rpc("absence_to_validate");
    if (error) return say($("ab-todo-msg"), "Chargement impossible : " + error.message, "error");
    state.todoLoaded = true; state.todoTried = true; state.todoAt = Date.now();
    state.todo = normTodo(data);
    renderTodo();
    if (state.isDir) loadOpinions();
  }

  // Pré-avis de la direction : affichage chez les validateurs, saisie pour la direction (facultatif, non bloquant)
  const OPINION = { favorable: "Favorable", defavorable: "Défavorable" };
  function opinionsBlock(list, title) {
    if (!list || !list.length) return null;
    const box = el("div", "ab-opinions");
    box.append(el("strong", null, title || "Pré-avis de la direction"));
    list.forEach((o) => {
      const p = el("p", "ab-opinion");
      p.append(el("span", "ug-badge " + (o.opinion === "favorable" ? "ab-op-ok" : "ug-warn"), OPINION[o.opinion] || o.opinion),
        document.createTextNode(` ${o.name}` + (o.at ? ` · ${fmtCH(o.at)}` : "") + (o.comment ? ` : « ${o.comment} »` : "")));
      box.append(p);
    });
    return box;
  }
  async function loadOpinions() {
    const { data, error } = await sb.rpc("absence_opinion_todo");
    if (error) return;
    const rows = (data || []).map((a) => Object.assign(a, {
      start_date: String(a.start_date).slice(0, 10), end_date: String(a.end_date).slice(0, 10),
      change_start: a.change_start && String(a.change_start).slice(0, 10), change_end: a.change_end && String(a.change_end).slice(0, 10)
    }));
    $("ab-op-wrap").hidden = false;
    const box = $("ab-op-list");
    box.replaceChildren();
    if (!rows.length) { box.append(el("p", "muted", "Aucune demande en cours chez les validateurs de clinique.")); return; }
    for (const a of rows) {
      const card = el("article", "card ab-item ab-item-requested");
      const head = el("div", "ab-item-head");
      const isChange = !!a.change_type;
      head.append(el("strong", null, a.name), el("span", "ug-badge", (a.clinics || []).join(", ") || "Sans clinique"),
        el("span", "ug-badge ug-warn", isChange ? (a.change_type === "delete" ? "Suppression demandée" : "Modification demandée") : "Nouvelle demande"));
      head.append(el("span", "ug-badge", a.step_label || "Pré-avis de la direction"));
      if (a.my_opinion) head.append(el("span", "ug-badge ab-op-ok", "Votre pré-avis : " + OPINION[a.my_opinion]));
      card.append(head);
      const cur = `${KINDS[a.kind][0]} · ${period(a.start_date, a.end_date)} · ${plur(workdays(a.start_date, a.end_date), "jour ouvrable", "jours ouvrables")}`;
      card.append(el("p", null, isChange ? `Absence validée : ${cur}` : cur));
      if (a.note) card.append(el("p", "muted", "Précision : " + a.note));
      if (a.change_type === "modify") card.append(el("p", null, `Nouvelle période demandée : ${KINDS[a.change_kind][0]} · ${period(a.change_start, a.change_end)}${a.change_note ? " · " + a.change_note : ""}`));
      const prog = a.progress || [];
      if (prog.length) { const d = el("details", "ab-progress"); d.append(el("summary", null, `Validation par la clinique : ${approvalCount(prog)} sur ${prog.length}`), approvalsBlock(prog)); card.append(d); }
      const w = warnBox(a.conflicts, "Attention : trop d'absences en même temps si la demande est validée");
      if (w) card.append(w);
      const others = opinionsBlock(a.opinions, a.step_label ? `Autres avis : ${a.step_label}` : "Autres pré-avis de la direction");
      if (others) card.append(others);
      const fs = el("fieldset", "ab-op-choice");
      fs.append(el("legend", null, "Votre pré-avis"));
      const radios = {};
      for (const [v, label] of [["favorable", "Favorable"], ["defavorable", "Défavorable"]]) {
        const lab = el("label", "cg-check");
        const r = el("input"); r.type = "radio"; r.name = "op-" + a.id; r.value = v; r.checked = a.my_opinion === v;
        radios[v] = r;
        lab.append(r, " " + label);
        fs.append(lab);
      }
      const comment = el("input"); comment.type = "text"; comment.maxLength = 500; comment.value = a.my_comment || "";
      comment.placeholder = "Commentaire pour les validateurs (obligatoire si défavorable)";
      const lab = el("label", "ab-comment", "Commentaire");
      lab.append(comment);
      const out = el("p", "form-msg"); out.setAttribute("role", "status");
      const save = button(a.my_opinion ? "Mettre à jour mon pré-avis" : "Enregistrer mon pré-avis", "btn", async () => {
        const choice = radios.favorable.checked ? "favorable" : radios.defavorable.checked ? "defavorable" : null;
        if (!choice) return say(out, "Choisissez favorable ou défavorable.", "error");
        if (choice === "defavorable" && comment.value.trim().length < 3) { comment.focus(); return say(out, "Un pré-avis défavorable demande un commentaire.", "error"); }
        save.disabled = true;
        const { error: e2 } = await sb.rpc("absence_opinion_set", { p_id: a.id, p_opinion: choice, p_comment: comment.value.trim() });
        save.disabled = false;
        if (e2) return say(out, e2.message, "error");
        say($("ab-op-msg"), `${a.name} : pré-avis enregistré, il s'affiche chez les validateurs.`, "ok");
        await loadOpinions();
      });
      const actions = el("div", "btn-row");
      actions.append(save);
      if (a.my_opinion) actions.append(button("Retirer mon pré-avis", "btn btn-outline", async () => {
        const { error: e2 } = await sb.rpc("absence_opinion_set", { p_id: a.id, p_opinion: null, p_comment: null });
        if (e2) return say(out, e2.message, "error");
        say($("ab-op-msg"), `${a.name} : pré-avis retiré.`, "ok");
        await loadOpinions();
      }));
      card.append(fs, lab, out, actions);
      box.append(card);
    }
  }
  async function loadRejected() {
    const { data, error } = await sb.rpc("absence_rejected_to_manage");
    if (error) return;
    state.rejected = (data || []).map((a) => Object.assign(a, { start_date: String(a.start_date).slice(0, 10), end_date: String(a.end_date).slice(0, 10) }));
    const box = $("ab-rej-list");
    $("ab-rej-wrap").hidden = !state.rejected.length;
    box.replaceChildren();
    for (const a of state.rejected) {
      const card = el("article", "card ab-item ab-item-rejected");
      const head = el("div", "ab-item-head");
      head.append(el("strong", null, a.name), el("span", "ug-badge", KINDS[a.kind][0]), el("strong", null, period(a.start_date, a.end_date)));
      addNo(head, a.request_no);
      card.append(head);
      const gone = new Date(new Date(a.decided_at).getTime() + 14 * 864e5);
      card.append(el("p", "ab-decision", `Refusée${a.decided_by_name ? " par " + a.decided_by_name : ""} le ${fmtCH(a.decided_at)}${a.decision_comment ? " : « " + a.decision_comment + " »" : ""}. N'apparaîtra plus ici à partir du ${fmtCH(iso(gone))} ; reste consultable dans l'historique.`));
      const decHist = (a.approvals || []).map((x) => ({ validator_name: x.name, decision: x.decision, comment: x.comment, decided_at: x.at, step: x.step, step_label: x.step_label }));
      if (decHist.length) {
        const d = el("details", "ab-progress");
        d.append(el("summary", null, "Historique des décisions"), approvalsBlock(decHist));
        card.append(d);
      }
      const act = el("div", "btn-row ab-actions");
      act.append(button("Archiver", "btn btn-outline lt-danger", async () => {
        if (!confirm(`Archiver la demande refusée de ${a.name} (${period(a.start_date, a.end_date)}) ? La demande reste consultable dans l'historique.`)) return;
        const { error: e2 } = await sb.rpc("absence_delete_rejected", { p_id: a.id });
        if (e2) return say($("ab-todo-msg"), e2.message, "error");
        say($("ab-todo-msg"), "Demande refusée archivée. Elle reste consultable dans l'historique.", "ok");
        hist.stale = true;
        await loadRejected();
      }));
      card.append(act);
      box.append(card);
    }
  }
  // Décision sur une demande (à valider) : commentaire, boutons Valider / Viser / Accepter / Refuser.
  // Partagé par la liste « À valider » et le détail du planning ; onDone(message) est appelé après une décision enregistrée.
  function decisionControls(a, onDone) {
    const isChange = !!a.change_type;
    const st = curStep(a);
    const colSteps = Array.isArray(a.steps) ? a.steps : [];
    const mineVisa = colSteps.length ? colSteps.some((x) => x.mine && x.kind === "visa") : st.kind === "visa";
    const comment = el("input"); comment.type = "text"; comment.maxLength = 500; comment.placeholder = "Commentaire (obligatoire pour un refus)";
    comment.value = state.comments.get(String(a.id)) || "";
    comment.addEventListener("input", () => state.comments.set(String(a.id), comment.value));
    const lab = el("label", "ab-comment", "Commentaire");
    lab.append(comment);
    const out = el("p", "form-msg"); out.setAttribute("role", "status");
    const decide = async (approve, b1, b2) => {
      if (!approve && comment.value.trim().length < 3) { comment.focus(); return say(out, "Un refus demande un commentaire.", "error"); }
      b1.disabled = b2.disabled = true;
      const { data: res, error } = await sb.rpc("absence_decide", { p_id: a.id, p_approve: approve, p_comment: comment.value.trim() });
      if (error) { b1.disabled = b2.disabled = false; return say(out, error.message, "error"); }
      state.comments.delete(String(a.id));
      mailer();
      await onDone(approve
        ? (res === "requested" ? `${a.name} : votre validation est enregistrée ; il reste des validateurs ou le visa de la direction.` : `${a.name} : accepté, la notification est mise en file.`)
        : `${a.name} : refusé, la notification est mise en file.`);
    };
    const actions = el("div", "btn-row");
    const yes = button(isChange ? "Accepter le changement" : mineVisa ? "Viser (valider)" : "Valider", "btn", () => decide(true, yes, no));
    const no = button(isChange ? "Refuser le changement" : "Refuser", "btn btn-outline", () => decide(false, yes, no));
    actions.append(yes, no);
    const parts = [lab, out, actions];
    // Visa de la direction avec envoi à l'étape « sur décision » (cheffe de service) : bouton inactif, avec la raison, si personne n'est désigné
    if (a.escalation) {
      const box = el("div", "ab-escalate");
      const note = el("input"); note.type = "text"; note.maxLength = 500; note.placeholder = "Note pour l'étape suivante (facultatif)";
      const nlab = el("label", "ab-comment", "Note pour l'étape suivante");
      nlab.append(note);
      const hint = el("p", "muted ab-item-meta", a.escalation.available
        ? `Enregistre votre visa, puis envoie la demande à l'étape « ${a.escalation.label} » : elle n'est conclue qu'après sa décision.`
        : a.escalation.reason);
      const go = button("Envoyer à : " + a.escalation.label, "btn btn-outline", async () => {
        go.disabled = true; yes.disabled = true; no.disabled = true;
        const { error } = await sb.rpc("absence_visa_escalate", { p_id: a.id, p_note: note.value.trim() || null });
        if (error) { go.disabled = !a.escalation.available; yes.disabled = no.disabled = false; return say(out, error.message, "error"); }
        state.comments.delete(String(a.id));
        mailer();
        await onDone(`${a.name} : visa enregistré, la demande est envoyée à l'étape « ${a.escalation.label} ».`);
      });
      go.disabled = !a.escalation.available;
      if (!a.escalation.available) go.title = a.escalation.reason || "";
      box.append(nlab, el("div", "btn-row", null), hint);
      box.querySelector(".btn-row").append(go);
      parts.push(box);
    }
    return parts;
  }

  // ----- Mini-planning de la clinique (onglet À valider) : état propre, sans toucher au planning ni à ses préférences -----
  const wideMq = window.matchMedia ? window.matchMedia("(min-width: 1100px)") : null;
  const isWide = () => !!(wideMq && wideMq.matches);
  const cards = new Map();
  const fridayOf = (s) => addD(mondayOf(s), 4);
  // Fenêtre : du lundi de la semaine du début au vendredi de la semaine de la fin (3 semaines au moins, 9 au plus) ; pour une modification, ancienne et nouvelle période
  function miniSpan(a) {
    const mod = a.change_type === "modify" && a.change_start && a.change_end;
    const lo = mod && a.change_start < a.start_date ? a.change_start : a.start_date;
    const hi = mod && a.change_end > a.end_date ? a.change_end : a.end_date;
    const start = mondayOf(lo);
    let end = fridayOf(hi);
    if (end < addD(start, 18)) end = addD(start, 18);
    if (end > addD(start, 60)) end = addD(start, 60);
    const sh = (state.mini.shifts.get(String(a.id)) || 0) * 7;
    return { start: addD(start, sh), end: addD(end, sh), shift: sh / 7 };
  }
  async function miniPlanning(box, a, refocus) {
    const tok = String(Math.random());
    box.dataset.tok = tok;
    const { start, end, shift } = miniSpan(a);
    const days = [];
    for (let d = start; d <= end; d = addD(d, 1)) days.push(d);
    const clinics = a.clinics || [];
    const hl = new Set();
    const mark = (x, y) => { for (const d of days) if (x <= d && d <= y) hl.add(d); };
    mark(a.start_date, a.end_date);
    if (a.change_type === "modify" && a.change_start && a.change_end) mark(a.change_start, a.change_end);
    box.replaceChildren();
    const head = el("div", "ab-mini-head");
    head.append(el("strong", "ab-mini-title", `Planning de ${clinics.join(", ") || "la clinique"}`));
    const nav = el("div", "ab-mini-nav");
    const prev = button("‹", "btn btn-outline", () => { state.mini.shifts.set(String(a.id), shift - 1); miniPlanning(box, a, "Semaine précédente"); });
    prev.setAttribute("aria-label", "Semaine précédente");
    const next = button("›", "btn btn-outline", () => { state.mini.shifts.set(String(a.id), shift + 1); miniPlanning(box, a, "Semaine suivante"); });
    next.setAttribute("aria-label", "Semaine suivante");
    nav.append(prev, el("span", "ab-mini-range", `${fmtCH(start)} – ${fmtCH(end)}`), next,
      button("Ouvrir dans le planning", "btn btn-outline", () => openInPlanning(a, start)));
    head.append(nav);
    box.append(head);
    if (refocus) { const f = head.querySelector(`[aria-label="${refocus}"]`); if (f) f.focus(); }
    const body = el("div", "ab-scroll ab-mini-scroll");
    body.tabIndex = 0; body.setAttribute("role", "region"); body.setAttribute("aria-label", `Planning de ${clinics.join(", ") || "la clinique"}, ${fmtCH(start)} au ${fmtCH(end)}`);
    body.append(el("p", "muted ab-mini-load", "Chargement…"));
    box.append(body);
    let data;
    try { data = await loadRange(start, end); } catch (e) {
      if (box.dataset.tok === tok) body.replaceChildren(el("p", "form-msg error", "Chargement du planning impossible : " + e.message));
      return;
    }
    if (box.dataset.tok !== tok) return;
    // Membres des cliniques de la demande (ceux que les fonctions existantes montrent à ce validateur), demandeur en tête
    const req = state.people.find((p) => p.id === a.user_id) || { id: a.user_id, name: a.name, clinics, is_me: false };
    const others = state.people.filter((p) => p.id !== a.user_id && sharesClinic(p, clinics)).sort((x, y) => compareNames(x, y, sortMode()));
    const people = [req, ...others];
    const byUser = new Map(data.byUser);
    // Nouvelle période d'une modification : barre « en attente » ajoutée au demandeur pour la lire dans la grille
    if (a.change_type === "modify" && a.change_start && a.change_end) {
      byUser.set(a.user_id, (byUser.get(a.user_id) || []).concat([{ id: "chg-" + a.id, kind: a.change_kind || a.kind, status: "requested", start_date: a.change_start, end_date: a.change_end, change_type: null }]));
    }
    body.replaceChildren(buildWindow(days, byUser, data.cal, people, { hl, reqId: a.user_id, count: true }));
    const note = el("p", "muted ab-mini-note", "Colonnes surlignées : jours demandés. Hachuré : demande en attente. Les personnes affichées sont celles que vous voyez dans le planning.");
    box.append(note);
  }
  function selectTodo(id) {
    id = String(id);
    const a = state.todo.find((x) => String(x.id) === id);
    if (!a) return;
    if (state.mini.sel !== id) { state.mini.sel = id; }
    cards.forEach((c, k) => {
      const on = k === id;
      c.classList.toggle("ab-sel", on);
      if (on) c.setAttribute("aria-current", "true"); else c.removeAttribute("aria-current");
    });
    if ($("ab-p-todo").hidden || state.mini.drawn === id + "|" + state.mini.stamp) return;
    state.mini.drawn = id + "|" + state.mini.stamp;
    miniPlanning($("ab-todo-side"), a);
  }
  // « Ouvrir dans le planning » : fenêtre glissante sur ces semaines, personnes de ces cliniques (filtre temporaire, aucune préférence modifiée)
  function openInPlanning(a, start) {
    const clinics = a.clinics || [];
    // Filtre temporaire, séparé des préférences : jamais enregistré
    state.tempScope = { ids: state.people.filter((p) => p.id === a.user_id || sharesClinic(p, clinics)).map((p) => p.id), label: clinics.join(", ") || a.name };
    state.view = "window";
    state.win.start = start;
    setTab("plan");
  }

  function renderTodo() {
    const list = $("ab-todo-list");
    list.replaceChildren();
    cards.clear();
    const wide = isWide();
    $("ab-todo-side").hidden = !(wide && state.todo.length);
    $("ab-todo-layout").classList.toggle("ab-split", wide && state.todo.length > 0);
    if (!state.todo.length) { list.append(el("p", "muted", "Aucune demande en attente.")); return; }
    if (!state.todo.some((x) => String(x.id) === String(state.mini.sel))) state.mini.sel = String(state.todo[0].id);
    for (const a of state.todo) {
      const card = el("article", "card ab-item ab-item-requested");
      const head = el("div", "ab-item-head");
      const isChange = !!a.change_type;
      head.append(el("strong", null, a.name), el("span", "ug-badge", (a.clinics || []).join(", ") || "Sans clinique"),
        el("span", "ug-badge ug-warn", isChange ? (a.change_type === "delete" ? "Suppression demandée" : "Modification demandée") : "Nouvelle demande"));
      const st = curStep(a);
      if (st.kind !== "clinique") head.append(el("span", "ug-badge", st.label));
      addNo(head, a.request_no);
      card.append(head);
      // étapes de la colonne en cours (simultanées), celles qui attendent l'appelant en tête de liste
      const colSteps = Array.isArray(a.steps) ? a.steps : [];
      if (colSteps.length > 1 || colSteps.some((x) => x.mine)) {
        const ul = el("ul", "ab-colsteps");
        ul.setAttribute("aria-label", "Étapes en cours");
        colSteps.forEach((x) => {
          const li = el("li", x.mine ? "ab-colstep mine" : "ab-colstep");
          li.append(el("span", null, x.label));
          if (x.mine) li.append(el("span", "ug-badge", "à vous"));
          ul.append(li);
        });
        card.append(ul);
      }
      const cur = `${KINDS[a.kind][0]} · ${period(a.start_date, a.end_date)} · ${plur(workdays(a.start_date, a.end_date), "jour ouvrable", "jours ouvrables")}`;
      card.append(el("p", null, isChange ? `Absence validée : ${cur}` : cur));
      if (a.note) card.append(el("p", "muted", "Précision : " + a.note));
      if (a.change_type === "modify") {
        card.append(el("p", null, `Nouvelle période demandée : ${KINDS[a.change_kind][0]} · ${period(a.change_start, a.change_end)} · ${plur(workdays(a.change_start, a.change_end), "jour ouvrable", "jours ouvrables")}${a.change_note ? " · " + a.change_note : ""}`));
      }
      const prog = a.progress || [];
      if (prog.length) {
        const d = el("details", "ab-progress");
        d.open = true;
        d.append(el("summary", null, `Validation : ${approvalCount(prog)} sur ${prog.length}`), approvalsBlock(prog));
        card.append(d);
        card.append(el("p", "muted ab-item-meta", st.kind === "visa"
          ? "Les validateurs de la clinique ont validé : votre visa conclut la demande."
          : st.kind === "clinique"
            ? "L'absence n'est validée que lorsque tous les validateurs concernés ont validé, puis visée par la direction ; un seul refus suffit à la refuser."
            : `Étape en cours : ${st.label}. Les étapes précédentes sont validées ; un seul refus suffit à refuser la demande.`));
      } else if (st.kind === "visa") {
        card.append(el("p", "muted ab-item-meta", "Aucun validateur de clinique : votre visa conclut la demande."));
      }
      if (a.escalated) card.append(el("p", "muted ab-item-meta", `Envoyée à la cheffe de service par ${a.escalated.by || "la direction"} le ${fmtDT(a.escalated.at)}${a.escalated.note ? " · « " + a.escalated.note + " »" : ""}.`));
      const ops = opinionsBlock(a.opinions);
      if (ops) card.append(ops);
      const w = warnBox(a.conflicts, "Attention : trop d'absences en même temps si vous validez");
      if (w) card.append(w);
      card.append(...decisionControls(a, (msg) => { say($("ab-todo-msg"), msg, "ok"); return afterChange(); }));
      const pdfRow = el("div", "btn-row ab-actions");
      pdfRow.append(button("Imprimer le formulaire (PDF)", "btn btn-outline", () => downloadForm(a, null, $("ab-todo-msg"))));
      card.append(pdfRow);
      cards.set(String(a.id), card);
      if (wide) {
        card.tabIndex = 0;
        card.setAttribute("role", "group");
        card.setAttribute("aria-label", `Demande de ${a.name}, ${period(a.start_date, a.end_date)}`);
        card.classList.add("ab-pick-card");
        card.addEventListener("focusin", () => selectTodo(a.id));
        card.addEventListener("click", (e) => { if (!e.target.closest("input, button, a, summary, label, select, textarea")) selectTodo(a.id); });
        card.addEventListener("keydown", (e) => { if ((e.key === "Enter" || e.key === " ") && e.target === card) { e.preventDefault(); selectTodo(a.id); } });
      } else {
        const holder = el("div", "ab-mini-wrap"); holder.hidden = !state.mini.open.has(String(a.id));
        const toggle = button(holder.hidden ? "Voir le planning de la clinique" : "Masquer le planning de la clinique", "btn btn-outline ab-mini-toggle", () => {
          const open = holder.hidden;
          holder.hidden = !open;
          toggle.setAttribute("aria-expanded", String(open));
          toggle.textContent = open ? "Masquer le planning de la clinique" : "Voir le planning de la clinique";
          open ? state.mini.open.add(String(a.id)) : state.mini.open.delete(String(a.id));
          if (open && !$("ab-p-todo").hidden) miniPlanning(holder, a);
        });
        toggle.setAttribute("aria-expanded", String(!holder.hidden));
        card.append(toggle, holder);
        if (!holder.hidden && !$("ab-p-todo").hidden) miniPlanning(holder, a);
      }
      list.append(card);
    }
    state.mini.stamp++;
    if (wide) selectTodo(state.mini.sel);
  }

  // ----- Abonnement à son agenda des absences (flux iCal privé) -----
  async function subscribeBody(box) {
    const get = async (reset) => {
      const { data, error } = await sb.rpc("calendar_token", { p_reset: !!reset });
      if (error || !data) throw error || new Error("jeton");
      return data;
    };
    const feed = (t) => `${cfg.supabaseUrl}/functions/v1/absence-feed?t=${t}`;
    box.replaceChildren(el("p", "muted", "Chargement…"));
    let token;
    try { token = await get(false); } catch (err) { box.replaceChildren(el("p", "form-msg error", "Abonnement indisponible pour l'instant.")); return; }
    const render = () => {
      const url = feed(token);
      box.replaceChildren();
      box.append(el("p", null, "Un lien privé garde votre agenda à jour : vos absences validées (fermes) et vos demandes en attente (provisoires). Il est aussi utilisé pour votre agenda des congrès et l'agenda combiné : générer un nouveau lien les coupe tous. Ne le partagez pas."));
      const row = el("div", "ab-sub-row");
      const input = el("input");
      input.readOnly = true; input.value = url; input.setAttribute("aria-label", "Lien d'abonnement à votre agenda des absences");
      input.addEventListener("focus", () => input.select());
      const copy = button("Copier le lien", "btn btn-outline", async () => {
        try { await navigator.clipboard.writeText(url); copy.textContent = "Copié"; } catch (x) { input.select(); copy.textContent = "Sélectionné : copiez"; }
        setTimeout(() => (copy.textContent = "Copier le lien"), 1800);
      });
      row.append(input, copy);
      box.append(row);
      const open = el("a", "btn", "Ouvrir dans mon agenda");
      open.href = url.replace(/^https:/, "webcal:");
      const actions = el("div", "btn-row");
      actions.append(open, button("Générer un nouveau lien", "btn btn-outline", async () => {
        if (!confirm("Générer un nouveau lien ? Les anciens liens cesseront de fonctionner dans vos agendas (absences, congrès et agenda combiné).")) return;
        try { token = await get(true); render(); } catch (x) { alert("Impossible de renouveler le lien."); }
      }));
      box.append(actions);
      const ol = el("ol", "ab-steps");
      ["iPhone, iPad, Mac : touchez « Ouvrir dans mon agenda » puis « S'abonner ».",
        "Google Agenda : Autres agendas › À partir de l'URL, collez le lien (Google actualise jusqu'à une fois par jour).",
        "Outlook : Ajouter un calendrier › S'abonner à partir du web, collez le lien."].forEach((t) => ol.append(el("li", null, t)));
      box.append(ol);
      // Lien combiné : congrès et absences dans un seul agenda (même jeton)
      const both = `${cfg.supabaseUrl}/functions/v1/agenda-feed?t=${token}`;
      const comb = el("div", "ab-combined");
      comb.append(el("h4", null, "Tout dans un seul agenda"),
        el("p", "muted", "Ce lien réunit vos congrès et vos absences dans un même agenda. Abonnez-vous à celui-ci ou aux liens séparés, pas aux deux, pour éviter les doublons."));
      const crow = el("div", "ab-sub-row");
      const cin = el("input");
      cin.readOnly = true; cin.value = both; cin.setAttribute("aria-label", "Lien d'abonnement à votre agenda combiné (congrès et absences)");
      cin.addEventListener("focus", () => cin.select());
      const ccopy = button("Copier le lien", "btn btn-outline", async () => {
        try { await navigator.clipboard.writeText(both); ccopy.textContent = "Copié"; } catch (x) { cin.select(); ccopy.textContent = "Sélectionné : copiez"; }
        setTimeout(() => (ccopy.textContent = "Copier le lien"), 1800);
      });
      crow.append(cin, ccopy);
      const copen = el("a", "btn", "Ouvrir dans mon agenda");
      copen.href = both.replace(/^https:/, "webcal:");
      const cact = el("div", "btn-row");
      cact.append(copen);
      comb.append(crow, cact);
      box.append(comb);
    };
    render();
  }

  // ----- Export Word -----
  function loadScript(src, global) {
    return new Promise((ok, ko) => {
      if (window[global]) return ok();
      const s = document.createElement("script");
      s.src = src; s.onload = ok; s.onerror = () => ko(new Error("Chargement de la bibliothèque impossible."));
      document.head.append(s);
    });
  }
  const slug = (s) => norm(s).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "membre";

  async function exportDocx() {
    const msg = $("ab-mine-msg");
    say(msg, "Préparation du document…");
    try {
      await loadScript(DOCX, "docx");
      const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, ShadingType, AlignmentType, BorderStyle } = window.docx;
      const year = $("ab-year").value;
      const from = year ? `${year}-01-01` : null, to = year ? `${year}-12-31` : null;
      const rows = state.mine.filter((a) => a.status !== "cancelled" && a.status !== "draft" && (!year || (a.start_date <= to && a.end_date >= from)))
        .sort((a, b) => a.start_date.localeCompare(b.start_date));
      const person = state.who ? state.people.find((p) => p.id === state.who) : state.people.find((p) => p.is_me);
      const name = person ? person.name : "Membre";
      const clinics = person && person.clinics && person.clinics.length ? person.clinics.join(", ") : "—";
      const approved = rows.filter((a) => a.status === "approved");
      const others = rows.filter((a) => a.status !== "approved");
      const byKind = { vacances: 0, congres: 0, autre: 0 };
      approved.forEach((a) => { byKind[a.kind] += workdays(a.start_date, a.end_date, from, to); });
      const total = byKind.vacances + byKind.congres + byKind.autre;

      const line = { style: BorderStyle.SINGLE, size: 4, color: "C3CBD9" };
      const borders = { top: line, bottom: line, left: line, right: line };
      const cell = (text, w, o = {}) => new TableCell({
        width: { size: w, type: WidthType.DXA }, borders,
        margins: { top: 60, bottom: 60, left: 100, right: 100 },
        shading: o.head ? { type: ShadingType.CLEAR, fill: "001B4D", color: "auto" } : undefined,
        children: [new Paragraph({ children: [new TextRun({ text: String(text), bold: !!o.head, color: o.head ? "FFFFFF" : "1A2A4A", size: 19 })] })]
      });
      const W = [1500, 1500, 1300, 1500, 2326, 1500]; // 9626 DXA, A4 portrait avec marges de 2 cm
      const headRow = (labels) => new TableRow({ tableHeader: true, children: labels.map((l, i) => cell(l, W[i], { head: true })) });
      const table = (list, withStatus) => new Table({
        width: { size: 9626, type: WidthType.DXA }, columnWidths: W,
        rows: [headRow(["Du", "Au", "Jours ouvrables", "Motif", "Précision", withStatus ? "Statut" : "Décision"])].concat(list.map((a) => {
          let last = "";
          if (withStatus) {
            last = STATUS[a.status] + (a.change_type === "delete" ? " (suppression demandée)" : a.change_type === "modify" ? ` (modification demandée : ${period(a.change_start, a.change_end)})` : "");
            if (a.status === "rejected" && a.decision_comment) last += " : " + a.decision_comment;
          } else last = a.decided_at ? "Validée le " + fmtCH(a.decided_at) : "Validée";
          return new TableRow({ children: [cell(fmtCH(a.start_date), W[0]), cell(fmtCH(a.end_date), W[1]), cell(workdays(a.start_date, a.end_date, from, to), W[2]),
            cell(KINDS[a.kind][0], W[3]), cell(a.note || "", W[4]), cell(last, W[5])] });
        }))
      });
      const h = (text) => new Paragraph({ spacing: { before: 320, after: 120 }, children: [new TextRun({ text, bold: true, size: 26, color: "001B4D" })] });
      const p = (text, o = {}) => new Paragraph({ spacing: { after: 80 }, children: [new TextRun(Object.assign({ text, size: 21 }, o))] });
      const today = fmtCH(todayIso());
      const children = [
        new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text: "Résumé des absences", bold: true, size: 40, color: "001B4D" })] }),
        p(name, { bold: true, size: 26 }),
        p(`Clinique${person && person.clinics && person.clinics.length > 1 ? "s" : ""} : ${clinics}`),
        p(`Période : ${year ? "année " + year : "toutes les années"} · Édité le ${today}`),
        h("Absences validées"),
        approved.length ? table(approved, false) : p("Aucune absence validée sur la période.", { italics: true }),
        p(`Total : ${plur(total, "jour ouvrable", "jours ouvrables")} (vacances ${byKind.vacances}, congrès ${byKind.congres}, autre ${byKind.autre}).`, { bold: true }),
        h("Demandes en attente et refusées"),
        others.length ? table(others, true) : p("Aucune demande en attente ou refusée sur la période.", { italics: true }),
        new Paragraph({ spacing: { before: 360 }, children: [new TextRun({ text: "Jours ouvrables : lundi à vendredi, jours fériés vaudois déduits. Les absences validées avec une demande de changement en cours figurent aux dates actuellement validées.", italics: true, size: 17, color: "5A6478" })] })
      ];
      const doc = new Document({
        styles: { default: { document: { run: { font: "Arial", size: 21 } } } },
        sections: [{ properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1134, right: 1134, bottom: 1134, left: 1134 } } }, children }]
      });
      const blob = await Packer.toBlob(doc);
      const a = el("a");
      a.href = URL.createObjectURL(blob);
      a.download = `absences-${slug(name)}-${year || "toutes"}.docx`;
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      say(msg, `Document « ${a.download} » téléchargé.`, "ok");
    } catch (e) { say(msg, e.message, "error"); }
  }

  // ----- Onglets -----
  // ----- Exports Excel (admin, direction : tous les membres ; validateurs : leurs cliniques) -----
  const DATE_FMT = "dd.mm.yyyy", DT_FMT = new Intl.DateTimeFormat("fr-CH", { timeZone: "Europe/Zurich", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const ROLE_NAME = { clinician: "Médecin assistant", cdc: "CDC", cadre: "Médecin cadre", assistant: "Assistante médicale", nurse: "Infirmier·ère", pharmacist: "Pharmacien·ne", direction: "Admin de direction", admin: "Administrateur" };
  const xDT = (s) => (s ? DT_FMT.format(new Date(s)).replace(",", "") : "");
  const xDate = (s) => (s ? pd(s) : null);
  const FILL = { approved: "FFE3F1E4", requested: "FFFFF3D6", direction: "FFFCE4C8", rejected: "FFF9DADA", cancelled: "FFE6E8EC", change: "FFDDE8F7" };
  function statusLabel(r) {
    if (r.status === "approved") return r.change_type === "delete" ? "Validée, suppression demandée" : r.change_type === "modify" ? "Validée, modification demandée" : "Validée";
    if (r.status === "requested") return r.state_label || `En cours : ${curStep(r).label}`;
    return r.status === "rejected" ? "Refusée" : r.status === "cancelled" ? "Annulée" : r.status;
  }
  const statusFill = (r) => (r.status === "approved" ? (r.change_type ? FILL.change : FILL.approved) : r.status === "requested" ? (curStep(r).kind === "clinique" ? FILL.requested : FILL.direction) : FILL[r.status]);
  const DECISION_LABEL = { approved: "Acceptée", rejected: "Refusée", change_approved: "Changement accepté", change_rejected: "Changement refusé" };
  function exportWindow() {
    const from = $("ab-exp-from").value, to = $("ab-exp-to").value;
    if (!from || !to || to < from) { say($("ab-exp-msg"), "Vérifiez la fenêtre : la fin doit suivre le début.", "error"); return null; }
    if ((pd(to) - pd(from)) / 864e5 > 800) { say($("ab-exp-msg"), "Fenêtre trop longue (800 jours au plus).", "error"); return null; }
    return { from, to };
  }
  function saveXlsx(buffer, name) {
    const url = URL.createObjectURL(new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    const a = el("a"); a.href = url; a.download = name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
  function styleSheet(ws, widths) {
    ws.columns = ws.columns.map((c, i) => Object.assign(c, { width: widths[i] || 16 }));
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF001B4D" } };
    ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    ws.views = [{ state: "frozen", ySplit: 1 }];
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columns.length } };
  }
  // ----- Export unique : Planning (grille calendaire au format du tableur des cliniques), Absences, Synthèse, Décisions, Légende -----
  const CAL = {
    approved: { vacances: "FFF4A6A6", congres: "FF8FCB6B", autre: "FFF7CF6B" }, // validée : couleur franche
    pending: { vacances: "FFFBE1E1", congres: "FFE3F2D9", autre: "FFFDF1D2" },  // en cours : même teinte, très claire
    weekend: "FFEEF0F3", month: "FF001B4D", clinic: "FFDCE3EE", grid: "FFD9DDE3",
  };
  const ROLE_ORDER = { cadre: 1, cdc: 2, clinician: 3, pharmacist: 4, nurse: 5, assistant: 6, direction: 7, admin: 8 };
  const ROLE_SHORT = { cadre: "Médecin cadre", cdc: "CDC", clinician: "Méd. assistant", pharmacist: "Pharmacien·ne", nurse: "Infirmier·ère", assistant: "Assistante méd.", direction: "Direction", admin: "Admin" };
  const WEEKDAY = ["D", "L", "M", "M", "J", "V", "S"];
  function monthsBetween(from, to) {
    const a = pd(from), b = pd(to), out = [];
    for (let y = a.getUTCFullYear(), m = a.getUTCMonth(); y < b.getUTCFullYear() || (y === b.getUTCFullYear() && m <= b.getUTCMonth()); m === 11 ? (m = 0, y++) : m++) out.push([y, m]);
    return out;
  }
  // Jours couverts par personne : Map(user -> Map(iso -> {kind, state, label, start})). Validée prioritaire sur en cours, congrès sur le reste.
  function planningDays(absences, from, to) {
    const out = new Map(), rank = (x) => (x.state === "approved" ? 2 : 0) + (x.kind === "congres" ? 1 : 0);
    for (const a of absences) {
      const st = a.status === "approved" ? "approved" : "pending";
      const label = (a.kind === "congres" && a.note ? String(a.note).slice(0, 14) : KINDS[a.kind][0]) + (st === "pending" ? " ?" : "");
      const s = a.start_date < from ? from : a.start_date, e = a.end_date > to ? to : a.end_date;
      if (!out.has(a.user_id)) out.set(a.user_id, new Map());
      const days = out.get(a.user_id);
      for (const d = pd(s); iso(d) <= e; d.setUTCDate(d.getUTCDate() + 1)) {
        const day = iso(d), cand = { kind: a.kind, state: st, label, key: a.start_date + a.kind + st }, cur = days.get(day);
        if (!cur || rank(cand) > rank(cur)) days.set(day, cand);
      }
    }
    return out;
  }
  // Groupes : une section par clinique (cadres puis CDC puis assistants…), puis les membres sans clinique (direction seulement).
  function planningGroups(members) {
    const scope = state.isDir ? null : new Set(state.ctx.validates || []), groups = new Map();
    for (const m of members) {
      const cl = (m.clinics || []).filter((c) => !scope || scope.has(c));
      const keys = cl.length ? cl : state.isDir ? ["Sans clinique"] : [];
      for (const k of keys) { if (!groups.has(k)) groups.set(k, []); groups.get(k).push(m); }
    }
    const order = [...groups.keys()].sort((a, b) => (a === "Sans clinique") - (b === "Sans clinique") || a.localeCompare(b, "fr"));
    return order.map((k) => [k, groups.get(k).sort((a, b) => (ROLE_ORDER[a.role] || 9) - (ROLE_ORDER[b.role] || 9) || compareNames(a, b, sortMode() === "first" ? "first" : "family"))]);
  }
  function addPlanningSheet(wb, plan, w) {
    const ws = wb.addWorksheet("Planning", { views: [{ state: "frozen", xSplit: 2, showGridLines: false }], properties: { defaultRowHeight: 20 } });
    ws.getColumn(1).width = 28; ws.getColumn(2).width = 16;
    for (let c = 3; c <= 33; c++) ws.getColumn(c).width = 4.8;
    const thin = { style: "thin", color: { argb: CAL.grid } }, box = { top: thin, left: thin, right: thin, bottom: thin };
    const solid = (argb) => ({ type: "pattern", pattern: "solid", fgColor: { argb } });
    const days = planningDays(plan.absences || [], w.from, w.to), groups = planningGroups(plan.members || []);
    for (const [y, m] of monthsBetween(w.from, w.to)) {
      const nd = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
      const label = new Date(Date.UTC(y, m, 1)).toLocaleDateString("fr-CH", { month: "long", year: "numeric", timeZone: "UTC" });
      const title = ws.addRow([label.charAt(0).toUpperCase() + label.slice(1)]);
      title.height = 26; ws.mergeCells(title.number, 1, title.number, 2 + nd);
      title.getCell(1).font = { bold: true, size: 13, color: { argb: "FFFFFFFF" } };
      title.getCell(1).fill = solid(CAL.month); title.getCell(1).alignment = { vertical: "middle", indent: 1 };
      const iso_ = (d) => iso(new Date(Date.UTC(y, m, d))), off = {};
      for (let d = 1; d <= nd; d++) { const day = iso_(d), wd = pd(day).getUTCDay(); off[d] = wd === 0 || wd === 6 || !!holidayOf(day); }
      const wdRow = ws.addRow(["", "", ...Array.from({ length: nd }, (_, i) => WEEKDAY[pd(iso_(i + 1)).getUTCDay()])]);
      const nRow = ws.addRow(["Nom", "Fonction", ...Array.from({ length: nd }, (_, i) => i + 1)]);
      for (const r of [wdRow, nRow]) {
        r.height = 18;
        r.eachCell({ includeEmpty: true }, (c, col) => {
          c.alignment = { horizontal: col <= 2 ? "left" : "center", vertical: "middle", indent: col <= 2 ? 1 : 0 };
          c.font = { bold: r === nRow, size: 10, color: { argb: "FF4A5568" } };
          if (col > 2 && off[col - 2]) c.fill = solid(CAL.weekend);
          if (r === nRow) c.border = { bottom: { style: "medium", color: { argb: "FF9AA5B1" } } };
        });
      }
      for (let d = 1; d <= nd; d++) { const h = holidayOf(iso_(d)); if (h) nRow.getCell(d + 2).note = h; }
      for (const [clinic, people] of groups) {
        const g = ws.addRow([clinic]);
        g.height = 20; ws.mergeCells(g.number, 1, g.number, 2 + nd);
        g.getCell(1).font = { bold: true, size: 11, color: { argb: "FF001B4D" } }; g.getCell(1).fill = solid(CAL.clinic);
        g.getCell(1).alignment = { vertical: "middle", indent: 1 };
        for (const p of people) {
          const row = ws.addRow([p.name, ROLE_SHORT[p.role] || p.role]);
          row.height = 20;
          row.getCell(1).alignment = { vertical: "middle", indent: 1 }; row.getCell(1).font = { size: 10 };
          row.getCell(2).alignment = { vertical: "middle" }; row.getCell(2).font = { size: 9, color: { argb: "FF6B7280" } };
          row.getCell(1).border = box; row.getCell(2).border = box;
          const mine = days.get(p.id);
          let prev = null;
          for (let d = 1; d <= nd; d++) {
            const cell = row.getCell(d + 2), hit = mine && mine.get(iso_(d));
            cell.border = box; cell.alignment = { vertical: "middle", horizontal: "left" };
            if (hit) {
              cell.fill = solid(CAL[hit.state][hit.kind]);
              // Libellé une seule fois en début de plage (et en début de mois) : il déborde sur les cases suivantes.
              if (!prev || prev.key !== hit.key) { cell.value = hit.label; cell.font = { size: 9, bold: hit.state === "approved", italic: hit.state === "pending", color: { argb: "FF1F2933" } }; }
            } else if (off[d]) cell.fill = solid(CAL.weekend);
            prev = hit || null;
          }
        }
        ws.addRow([]).height = 8;
      }
      ws.addRow([]).height = 14;
    }
    return { members: (plan.members || []).length, absences: (plan.absences || []).length };
  }
  function addLegendSheet(wb, w, scope) {
    const lg = wb.addWorksheet("Légende");
    lg.columns = [{ header: "Couleur", width: 14 }, { header: "Signification", width: 70 }];
    lg.getRow(1).font = { bold: true };
    const fill = (argb) => ({ type: "pattern", pattern: "solid", fgColor: { argb } });
    const add = (argb, t) => { const r = lg.addRow(["", t]); if (argb) r.getCell(1).fill = fill(argb); r.height = 18; };
    add(null, "Planning");
    add(CAL.approved.vacances, "Vacances validées"); add(CAL.pending.vacances, "Vacances demandées, en cours de validation (libellé suivi de « ? »)");
    add(CAL.approved.congres, "Congrès validé (nom du congrès si indiqué)"); add(CAL.pending.congres, "Congrès demandé, en cours de validation");
    add(CAL.approved.autre, "Autre absence validée"); add(CAL.pending.autre, "Autre absence demandée, en cours de validation");
    add(CAL.weekend, "Week-end ou jour férié vaudois (nom du férié en commentaire sur le numéro du jour)");
    lg.addRow([]);
    add(null, "Absences : une ligne par absence avec son état ; couleur de la ligne selon l'état");
    [["Validée", FILL.approved], ["En cours : chez les validateurs", FILL.requested], ["En cours : visa de la direction ou autre étape du circuit", FILL.direction], ["Validée, modification ou suppression demandée", FILL.change], ["Refusée", FILL.rejected], ["Annulée", FILL.cancelled]].forEach(([t, c]) => add(c, t));
    lg.addRow([]);
    add(null, scope);
    add(null, `Fenêtre : du ${fmtCH(w.from)} au ${fmtCH(w.to)}. Brouillons non exportés. Jours ouvrables : lundi à vendredi, fériés vaudois déduits.`);
    add(null, "Planning : tout l'effectif du périmètre figure, y compris les personnes sans absence ; une personne rattachée à plusieurs cliniques apparaît dans chacune.");
  }
  function addAbsencesSheet(wb, rows) {
    const ws = wb.addWorksheet("Absences");
    ws.columns = ["N°", "Nom", "Rôle", "Cliniques", "Motif", "Précision", "Début", "Fin", "Jours ouvrables", "État", "Changement demandé", "Envoyée le", "Validée par (1re ligne)", "Visa de la direction", "Décision par", "Décision le", "Commentaire"].map((header) => ({ header }));
    for (const r of rows) {
      const chg = r.change_type === "delete" ? "Suppression" : r.change_type === "modify" ? `Modification : ${KINDS[r.change_kind] ? KINDS[r.change_kind][0] : r.change_kind}, ${period(String(r.change_start).slice(0, 10), String(r.change_end).slice(0, 10))}${r.change_note ? " (" + r.change_note + ")" : ""}` : "";
      const row = ws.addRow([r.request_no || "", r.name, ROLE_NAME[r.role] || r.role, (r.clinics || []).join(", "), KINDS[r.kind][0], r.note || "", xDate(r.start_date), xDate(r.end_date), workdays(r.start_date, r.end_date),
        statusLabel(r), chg, xDT(r.submitted_at), r.approvers || "", r.direction_name ? `${r.direction_name} (${xDT(r.direction_at)})` : "", r.decided_by_name || "", xDT(r.decided_at), r.decision_comment || ""]);
      row.getCell(7).numFmt = DATE_FMT; row.getCell(8).numFmt = DATE_FMT;
      row.eachCell((c) => { c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: statusFill(r) } }; });
    }
    styleSheet(ws, [12, 26, 18, 24, 12, 28, 12, 12, 10, 32, 36, 18, 44, 36, 24, 18, 36]);
  }
  function addSynthesisSheets(wb, rows, decisions, w) {
    const people = new Map();
    const get = (id, name, role, clinics) => { if (!people.has(id)) people.set(id, { name, role, clinics: clinics || [], ok: 0, days: { vacances: 0, congres: 0, autre: 0 }, pending: 0, changePending: 0, rejected: 0, cancelled: 0, chOk: 0, chKo: 0 }); return people.get(id); };
    for (const r of rows) {
      const p = get(r.user_id, r.name, r.role, r.clinics);
      if (r.status === "approved") { p.ok++; p.days[r.kind] += workdays(r.start_date, r.end_date, w.from, w.to); if (r.change_type) p.changePending++; }
      else if (r.status === "requested") p.pending++;
      else if (r.status === "cancelled") p.cancelled++;
    }
    for (const d of decisions) {
      const p = get(d.user_id, d.name, d.role, d.clinics);
      if (d.decision === "rejected") p.rejected++; else if (d.decision === "change_approved") p.chOk++; else if (d.decision === "change_rejected") p.chKo++;
    }
    const ws = wb.addWorksheet("Synthèse");
    ws.columns = ["Nom", "Rôle", "Cliniques", "Demandes acceptées", "Jours ouvrables acceptés", "dont vacances", "dont congrès", "dont autre", "En attente", "Validées avec changement en attente", "Refusées", "Annulées", "Changements acceptés", "Changements refusés"].map((header) => ({ header }));
    [...people.values()].sort((a, b) => compareNames(a, b, sortMode())).forEach((p) => {
      ws.addRow([p.name, ROLE_NAME[p.role] || p.role, (p.clinics || []).join(", "), p.ok, p.days.vacances + p.days.congres + p.days.autre, p.days.vacances, p.days.congres, p.days.autre, p.pending, p.changePending, p.rejected, p.cancelled, p.chOk, p.chKo]);
    });
    styleSheet(ws, [26, 18, 24, 12, 14, 10, 10, 10, 10, 16, 10, 10, 14, 14]);
    ws.addRow([]);
    ws.addRow([`Jours ouvrables comptés dans la fenêtre (week-ends et fériés vaudois exclus). Les refus sont tirés du journal des décisions : ceux purgés avant le 27.11.2026 (ancienne règle des 14 jours) ne sont pas récupérables.`]);
    const wd = wb.addWorksheet("Décisions");
    wd.columns = ["Nom", "Décision", "Motif", "Précision", "Début", "Fin", "Décidée le", "Par", "Commentaire"].map((header) => ({ header }));
    for (const d of decisions) {
      const r = wd.addRow([d.name, DECISION_LABEL[d.decision] || d.decision, KINDS[d.kind] ? KINDS[d.kind][0] : d.kind, d.note || "", xDate(d.start_date), xDate(d.end_date), xDT(d.decided_at), d.decided_by_name || "", d.comment || ""]);
      r.getCell(5).numFmt = DATE_FMT; r.getCell(6).numFmt = DATE_FMT;
    }
    styleSheet(wd, [26, 20, 12, 28, 12, 12, 18, 24, 40]);
    return people.size;
  }
  async function runExport() {
    const w = exportWindow();
    if (!w) return;
    const msg = $("ab-exp-msg");
    say(msg, "Préparation du fichier…");
    const [abs, dec, plan] = await Promise.all([
      sb.rpc("absence_export", { p_from: w.from, p_to: w.to }),
      sb.rpc("absence_decisions", { p_from: w.from, p_to: w.to }),
      sb.rpc("absence_planning", { p_from: w.from, p_to: w.to }),
    ]);
    const err = abs.error || dec.error || plan.error;
    if (err) return say(msg, err.message, "error");
    const day10 = (r) => Object.assign(r, { start_date: String(r.start_date).slice(0, 10), end_date: String(r.end_date).slice(0, 10) });
    const rows = (abs.data || []).map(day10), decisions = (dec.data || []).map(day10);
    const planning = plan.data || { members: [], absences: [] };
    planning.absences = (planning.absences || []).map(day10);
    try { await loadScript(EXCELJS, "ExcelJS"); } catch (e) { return say(msg, e.message, "error"); }
    const wb = new window.ExcelJS.Workbook();
    const p = addPlanningSheet(wb, planning, w);
    addAbsencesSheet(wb, rows);
    const n = addSynthesisSheets(wb, rows, decisions, w);
    addLegendSheet(wb, w, $("ab-exp-scope").textContent);
    saveXlsx(await wb.xlsx.writeBuffer(), `absences_${w.from}_${w.to}.xlsx`);
    say(msg, `Fichier téléchargé : planning de ${plur(p.members, "personne", "personnes")}, ${plur(rows.length, "absence", "absences")}, synthèse de ${plur(n, "personne", "personnes")}.`, "ok");
  }
  function initExport() {
    const t = new Date();
    const defaults = () => { $("ab-exp-from").value = monthStart(t.getFullYear(), t.getMonth() - 1); $("ab-exp-to").value = monthEnd(t.getFullYear(), t.getMonth() + 12); };
    defaults();
    $("ab-exp-scope").textContent = state.isDir
      ? "Tous les membres. Choisissez la fenêtre (par défaut : le mois précédent et les 12 mois à venir)."
      : `Les membres de ${state.ctx.validates.length > 1 ? "vos cliniques" : "votre clinique"} (${state.ctx.validates.join(", ")}). Choisissez la fenêtre (par défaut : le mois précédent et les 12 mois à venir).`;
    $("ab-exp-reset").addEventListener("click", defaults);
    $("ab-exp-form").addEventListener("submit", (e) => e.preventDefault());
    $("ab-exp-xlsx").addEventListener("click", async (e) => {
      const b = e.currentTarget; b.disabled = true;
      try { await runExport(); } catch (err) { say($("ab-exp-msg"), "Export impossible : " + err.message, "error"); }
      b.disabled = false;
    });
  }

  // ----- Suivi (direction et administration) : où en est chaque demande, parcours détaillé, PDF de l'état actuel -----
  const TRK_STATUS = { requested: "En cours", approved: "Validée", rejected: "Refusée", cancelled: "Annulée" };
  const TRK_ROLE = { clinician: "médecin assistant", cdc: "chef de clinique", cadre: "médecin cadre", assistant: "assistante", nurse: "infirmier·ère", pharmacist: "pharmacien·ne", direction: "direction", admin: "admin" };
  const trk = { rows: [], tok: 0, open: new Set() };
  const trkSlug = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z]+/gi, "-").toLowerCase();
  const trkOpen = (r) => r.status === "requested" || (r.status === "approved" && !!r.change_type);
  // Parcours d'une demande : pré-avis, colonnes d'étapes (personnes, état, horodatage, commentaire), envoi à l'étape sur décision, décision finale
  function trailNode(r) {
    const t = r.trail || {};
    const box = el("div", "ab-trail");
    if ((t.opinions || []).length) {
      box.append(el("h4", "ab-trail-title", "Pré-avis de la direction (consultatif)"));
      const ul = el("ul", "ab-trail-people");
      t.opinions.forEach((o) => ul.append(el("li", "st-" + (o.opinion === "favorable" ? "ok" : "ko"), `${o.name} : ${o.opinion === "favorable" ? "favorable" : "défavorable"} le ${fmtDT(o.at)}${o.comment ? " · « " + o.comment + " »" : ""}`)));
      box.append(ul);
    }
    const cols = new Map();
    (t.steps || []).forEach((s) => { if (!cols.has(s.col)) cols.set(s.col, []); cols.get(s.col).push(s); });
    if (cols.size) {
      const row = el("div", "cc-builder sim ab-trail-cols");
      [...cols.entries()].sort((a, b) => a[0] - b[0]).forEach(([, steps], i) => {
        if (i) row.append(el("div", "cc-gap sim"));
        const ce = el("div", "cc-col");
        ce.append(el("div", "cc-col-head", "Étape " + (i + 1) + (steps.length > 1 ? " · simultanées" : "")));
        const stack = el("div", "cc-stack");
        steps.forEach((s) => {
          const c = el("div", `cc-card sim k-${s.kind}${s.blocking ? "" : " soft"}${s.on_demand ? " od" : ""} ab-st-${trkSlug(s.state)}${s.current ? " current" : ""}`);
          c.append(el("div", "cc-card-label", s.label));
          const pills = el("div", "cc-pills");
          pills.append(el("span", "cc-pill ab-trail-state", s.state));
          if (s.on_demand) pills.append(el("span", "cc-pill dash", "sur décision de la direction"));
          c.append(pills);
          if ((s.people || []).length) {
            const ul = el("ul", "ab-trail-people");
            s.people.forEach((p) => ul.append(el("li", "st-" + trkSlug(p.state), `${p.name} : ${p.state}${p.at ? " le " + fmtDT(p.at) : ""}${p.comment ? " · « " + p.comment + " »" : ""}`)));
            c.append(ul);
          }
          stack.append(c);
        });
        ce.append(stack);
        row.append(ce);
      });
      box.append(row);
    }
    if (t.escalation) box.append(el("p", "ab-trail-line", `Envoyée à la cheffe de service par ${t.escalation.by || "la direction"} le ${fmtDT(t.escalation.at)}${t.escalation.note ? " · note : « " + t.escalation.note + " »" : ""}.`));
    if (t.final) box.append(el("p", "ab-trail-line", `Décision : ${DECISION[t.final.decision] || t.final.decision || "sans précision"}${t.final.by ? " par " + t.final.by : ""} le ${fmtDT(t.final.at)}${t.final.comment ? " · « " + t.final.comment + " »" : ""}.`));
    if ((t.history || []).length > 1) {
      const d = el("details", "ab-progress");
      d.append(el("summary", null, "Décisions enregistrées (" + t.history.length + ")"));
      t.history.forEach((h) => d.append(el("p", "muted", `${fmtDT(h.at)} · ${DECISION[h.decision] || h.decision}${h.by ? " · " + h.by : ""}${h.comment ? " · « " + h.comment + " »" : ""}`)));
      box.append(d);
    }
    if (!box.children.length) box.append(el("p", "muted", "Aucun détail enregistré pour cette demande."));
    return box;
  }
  function renderTrack() {
    const body = $("ab-trk-body");
    body.replaceChildren();
    const st = $("ab-trk-status").value, clinic = $("ab-trk-clinic").value, q = $("ab-trk-q").value.trim().toLowerCase();
    const list = trk.rows.filter((r) => (st === "all" || (st === "open" ? trkOpen(r) : r.status === st))
      && (!clinic || (r.clinics || []).includes(clinic)) && (!q || String(r.name || "").toLowerCase().includes(q) || String(r.request_no || "").includes(q)));
    $("ab-trk-count").textContent = trk.rows.length ? `${plur(list.length, "demande affichée", "demandes affichées")} sur ${trk.rows.length} dans la période.` : "";
    if (!list.length) { const tr = el("tr"); const td = el("td", "muted", trk.rows.length ? "Aucune demande ne correspond à ces filtres." : "Aucune demande dans cette période."); td.colSpan = 6; tr.append(td); body.append(tr); return; }
    list.forEach((r) => {
      const open = trk.open.has(r.id);
      const tr = el("tr", "ab-trk-row" + (open ? " open" : ""));
      const who = el("td"); who.append(el("strong", null, r.name), el("span", "muted", " · " + (TRK_ROLE[r.role] || r.role || "")));
      addNo(who, r.request_no);
      const when = `${KINDS[r.kind] ? KINDS[r.kind][0] : r.kind} · ${period(r.start_date, r.end_date)}`;
      const chg = r.change_type ? ` · ${r.change_type === "delete" ? "suppression demandée" : "modification demandée"}` : "";
      const stateTxt = (TRK_STATUS[r.status] || r.status) + chg + (r.escalated ? " · envoyée à la cheffe de service" : "");
      tr.append(who, el("td", null, (r.clinics || []).join(", ") || "Sans clinique"), el("td", null, when), el("td", null, stateTxt), el("td", null, r.step_label || "Aucune"));
      const act = el("td", "ab-trk-act");
      const toggle = button(open ? "Masquer" : "Parcours", "btn btn-outline", () => { open ? trk.open.delete(r.id) : trk.open.add(r.id); renderTrack(); });
      toggle.setAttribute("aria-expanded", String(open));
      act.append(toggle);
      if (["requested", "approved", "rejected"].includes(r.status)) act.append(button("Imprimer le formulaire (PDF)", "btn btn-outline", () => downloadForm({ id: r.id }, null, $("ab-trk-msg"))));
      tr.append(act);
      body.append(tr);
      if (open) {
        const dr = el("tr", "ab-trk-detail"); const td = el("td"); td.colSpan = 6;
        if (r.note) td.append(el("p", "muted", "Précision : " + r.note));
        if (r.change_type === "modify") td.append(el("p", null, `Nouvelle période demandée : ${KINDS[r.change_kind] ? KINDS[r.change_kind][0] : r.change_kind} · ${period(r.change_start, r.change_end)}`));
        td.append(trailNode(r)); dr.append(td); body.append(dr);
      }
    });
  }
  async function loadTrack() {
    const from = $("ab-trk-from").value, to = $("ab-trk-to").value, msg = $("ab-trk-msg");
    if (!from || !to || to < from) return say(msg, "Vérifiez les dates.", "error");
    if ((pd(to) - pd(from)) / 864e5 > 800) return say(msg, "Fenêtre trop longue (800 jours au plus).", "error");
    const tok = ++trk.tok;
    say(msg, "Chargement…");
    const { data, error } = await sb.rpc("absence_track", { p_from: from, p_to: to });
    if (tok !== trk.tok) return;
    if (error) return say(msg, error.message, "error");
    say(msg, "");
    trk.rows = data || [];
    const sel = $("ab-trk-clinic"), cur = sel.value;
    const clinics = [...new Set(trk.rows.flatMap((r) => r.clinics || []))].sort((a, b) => a.localeCompare(b, "fr"));
    sel.replaceChildren(); const all = el("option", null, "Toutes"); all.value = ""; sel.append(all);
    clinics.forEach((c) => { const o = el("option", null, c); o.value = c; sel.append(o); });
    sel.value = clinics.includes(cur) ? cur : "";
    renderTrack();
  }
  function initTrack() {
    const t = new Date();
    const defaults = () => { $("ab-trk-from").value = monthStart(t.getFullYear(), t.getMonth() - 1); $("ab-trk-to").value = monthEnd(t.getFullYear(), t.getMonth() + 12); };
    defaults();
    $("ab-trk-reset").addEventListener("click", () => { defaults(); loadTrack(); });
    $("ab-trk-form").addEventListener("submit", (e) => { e.preventDefault(); loadTrack(); });
    for (const id of ["ab-trk-status", "ab-trk-clinic"]) $(id).addEventListener("change", renderTrack);
    $("ab-trk-q").addEventListener("input", renderTrack);
  }

  // ----- Historique des demandes : toutes les demandes envoyées (demandées, validées, refusées, annulées), archivées comprises -----
  // Droits décidés en base (absence_requests_history, absence_find) : soi, ses validateurs, la direction et l'administration, la secrétaire du cadre.
  const hist = { rows: [], tok: 0, offset: 0, more: false, init: false, loaded: false, find: false };
  const HIST_PAGE = 50;
  // La saisie ressemble à un numéro : 2026-0012, 0012, 12, 2026-12, éventuellement précédé de « N° »
  // Un nombre de quatre chiffres commençant par 20 (« 2026 ») est une année : recherche texte et filtre d'année, pas un numéro
  const looksLikeNo = (s) => { const t = String(s).trim(); return /^(n°?\s*)?(\d{4}\s*[-/.]\s*)?\d{1,6}$/i.test(t) && !/^(n°?\s*)?20\d{2}$/i.test(t); };
  function histCard(a) {
    const card = el("article", `card ab-item ab-item-${a.status}`);
    const head = el("div", "ab-item-head");
    addNo(head, a.request_no);
    head.append(el("strong", null, a.name), el("span", "ug-badge", KINDS[a.kind] ? KINDS[a.kind][0] : a.kind), el("strong", null, period(a.start_date, a.end_date)),
      el("span", `ug-badge ab-st ab-st-${a.status}`, STATUS[a.status] || a.status));
    if (a.archived_at) head.append(el("span", "ug-badge", "Archivée"));
    card.append(head);
    const bits = [];
    if (a.submitted_at) bits.push("Demandée le " + fmtDT(a.submitted_at));
    if (a.circuit_name) bits.push("Circuit : " + a.circuit_name);
    if (a.note) bits.push(a.note);
    if (bits.length) card.append(el("p", "muted ab-item-meta", bits.join(" · ")));
    if (a.change_type) {
      card.append(el("p", "ab-pending-change", a.change_type === "delete" ? "Suppression demandée, en attente de décision."
        : `Modification demandée : ${a.change_kind && KINDS[a.change_kind] ? KINDS[a.change_kind][0] + ", " : ""}${a.change_start ? period(a.change_start, a.change_end) : ""}, en attente de décision.`));
    }
    if (a.decision && a.decided_at) {
      card.append(el("p", "ab-decision", `${DECISION[a.decision] || a.decision}${a.decided_by_name ? " par " + a.decided_by_name : ""} le ${fmtDT(a.decided_at)}${a.decision_comment ? " : « " + a.decision_comment + " »" : ""}`));
    }
    const own = a.user_id === state.ctx.me;
    const fb = formButton({ id: a.id, status: a.status, submitted_at: a.submitted_at }, own, $("ab-hist-msg"));
    if (fb) { const row = el("div", "btn-row ab-actions"); row.append(fb); card.append(row); }
    return card;
  }
  async function loadHist(more) {
    const msg = $("ab-hist-msg");
    const tok = ++hist.tok;
    const q = $("ab-hist-q").value.trim();
    const useFind = !!q && looksLikeNo(q);
    if (!more) { hist.rows = []; hist.offset = 0; }
    say(msg, "Chargement…");
    const yr = $("ab-hist-year").value, st = $("ab-hist-status").value, who = $("ab-hist-who").value;
    const { data, error } = useFind ? await sb.rpc("absence_find", { p_q: q })
      : await sb.rpc("absence_requests_history", { p_user: who || null, p_year: yr ? Number(yr) : null, p_status: st ? [st] : null, p_q: q || null, p_limit: HIST_PAGE, p_offset: hist.offset });
    if (tok !== hist.tok) return;
    if (error) return say(msg, "L'historique n'a pas pu être chargé. Réessayez dans un instant.", "error");
    const rows = (data || []).map((a) => Object.assign(a, { start_date: String(a.start_date).slice(0, 10), end_date: String(a.end_date).slice(0, 10) }));
    hist.find = useFind;
    hist.rows = hist.rows.concat(rows);
    hist.offset = hist.rows.length;
    hist.more = !useFind && rows.length === HIST_PAGE;
    hist.loaded = true; hist.stale = false;
    const list = $("ab-hist-list");
    if (!more) list.replaceChildren();
    rows.forEach((a) => list.append(histCard(a)));
    if (!hist.rows.length) list.append(el("p", "muted", useFind ? "Aucune demande trouvée pour ce numéro. Seules les demandes que vous avez le droit de consulter sont retrouvées." : "Aucune demande ne correspond à ces filtres."));
    say(msg, "");
    // La recherche par numéro ignore les filtres : le dire discrètement quand l'un d'eux est actif
    $("ab-hist-note").hidden = !(useFind && (yr || st || who));
    $("ab-hist-more").hidden = !hist.more;
    $("ab-hist-count").textContent = hist.rows.length ? (useFind ? `${plur(hist.rows.length, "demande trouvée", "demandes trouvées")}.` : `${plur(hist.rows.length, "demande affichée", "demandes affichées")}${hist.more ? ", d'autres suivent" : ""}.`) : "";
  }
  function initHistory() {
    if (hist.init) return;
    hist.init = true;
    $("ab-t-hist").hidden = false;
    $("ab-t-hist").addEventListener("click", () => setTab("hist"));
    const y = new Date().getFullYear(), ys = $("ab-hist-year");
    const all = el("option", null, "Toutes"); all.value = ""; ys.append(all);
    for (let i = y + 1; i >= Math.min(2026, y); i--) { const o = el("option", null, String(i)); o.value = String(i); ys.append(o); }
    // Personne : seulement si l'on peut en voir plusieurs (validateurs, direction, administration, secrétaire de médecin cadre)
    const others = [];
    if (state.isDir || state.ctx.validates.length) state.people.filter((p) => !p.is_me && (state.isDir || sharesClinic(p, state.ctx.validates))).forEach((p) => others.push(p));
    state.secOf.forEach((c) => { if (!others.some((p) => p.id === c.id)) others.push({ id: c.id, name: c.name }); });
    others.sort((x, y) => compareNames(x, y, sortMode()));
    if (others.length) {
      const sel = $("ab-hist-who");
      const a0 = el("option", null, "Toutes les personnes"); a0.value = ""; sel.append(a0);
      const me = el("option", null, "Moi"); me.value = state.ctx.me; sel.append(me);
      others.forEach((p) => { const o = el("option", null, p.name); o.value = p.id; sel.append(o); });
      $("ab-hist-who-wrap").hidden = false;
    }
    $("ab-hist-form").addEventListener("submit", (e) => { e.preventDefault(); loadHist(false); });
    for (const id of ["ab-hist-year", "ab-hist-status", "ab-hist-who"]) $(id).addEventListener("change", () => loadHist(false));
    $("ab-hist-more").addEventListener("click", () => loadHist(true));
  }

  // ----- Direction : absence saisie au nom d'un membre, validée d'office -----
  const MEDICAL = /maladie|accident|maternit|paternit|m[ée]dical|enceinte|hospital|sant[ée]/i;
  function initDirection() {
    const who = $("ab-dir-who");
    const start = $("ab-dir-start"), end = $("ab-dir-end"), kind = $("ab-dir-kind"), note = $("ab-dir-note"), conf = $("ab-dir-conf");
    const syncKind = () => {
      const autre = kind.value === "autre";
      $("ab-dir-conf-wrap").hidden = !autre;
      $("ab-dir-note-label").textContent = autre ? "Type d'absence (texte libre : maladie, maternité, RTT…)" : "Précision";
      note.required = autre;
    };
    kind.addEventListener("change", syncKind);
    syncKind();
    note.addEventListener("input", () => { if (kind.value === "autre") conf.checked = MEDICAL.test(note.value); });
    start.addEventListener("change", () => { if (!end.value || end.value < start.value) end.value = start.value; });
    // Membres de l'institution CHUV que la direction peut gérer
    (async () => {
      const { data, error } = await sb.rpc("absence_manageable_members");
      who.replaceChildren();
      const first = el("option", null, error ? "Liste indisponible" : "Choisir un membre du CHUV…"); first.value = ""; who.append(first);
      (data || []).forEach((p) => {
        const o = el("option", null, p.name + ((p.clinics || []).length ? " · " + p.clinics.join(", ") : "")); o.value = p.id; who.append(o);
      });
    })();
    $("ab-dir-form").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const msg = $("ab-dir-msg"), warn = $("ab-dir-warn");
      warn.replaceChildren();
      if (!who.value) return say(msg, "Choisissez un membre.", "error");
      if (!start.value || !end.value || end.value < start.value) return say(msg, "Vérifiez les dates.", "error");
      if (kind.value === "autre" && note.value.trim().length < 2) return say(msg, "Indiquez le type d'absence.", "error");
      const name = who.selectedOptions[0].textContent.split(" · ")[0];
      if (!confirm(`Ajouter cette absence pour ${name} ? Elle est enregistrée sans validation ni formulaire PDF${who.value === state.ctx.me ? "" : ", et une notification sera envoyée au membre"}.`)) return;
      const btn = ev.submitter || ev.target.querySelector("button[type=submit]");
      btn.disabled = true;
      const { data, error } = await sb.rpc("absence_direction_add", { p_user: who.value, p_kind: kind.value, p_note: note.value.trim(), p_start: start.value, p_end: end.value, p_confidential: kind.value === "autre" && conf.checked });
      btn.disabled = false;
      if (error) return say(msg, error.message, "error");
      say(msg, `Absence enregistrée pour ${name} (sans validation ni formulaire).`, "ok");
      const w = warnBox(data.conflicts, "Attention : trop d'absences en même temps");
      if (w) warn.append(w);
      note.value = ""; start.value = ""; end.value = ""; conf.checked = false;
      mailer();
      await afterChange();
    });
  }

  // ----- Blocage Ultragenda -----
  const DOWL = ["di", "lu", "ma", "me", "je", "ve", "sa"];
  const dayLbl = (d) => `${DOWL[pd(d).getUTCDay()]} ${d.slice(8, 10)}.${d.slice(5, 7)}`;
  function daysText(days) {
    if (!days.length) return "aucun jour ouvrable";
    const shown = days.slice(0, 10).map(dayLbl).join(", ");
    return `${plur(days.length, "jour ouvrable", "jours ouvrables")} : ${shown}${days.length > 10 ? "…" : ""}`;
  }
  async function refreshAgendaCount() {
    if (!state.agendaCtx || !state.agendaCtx.tab) return;
    const { data } = await sb.rpc("absence_agenda_pending_count");
    $("ab-agenda-n").textContent = data ? String(data) : "";
  }
  function agendaEntries(title, list) {
    const box = el("div");
    if (!list.length) return box;
    if (title) box.append(el("p", "ab-item-meta", title));
    const ul = el("ul");
    list.forEach((e) => {
      const li = el("li", e.void ? "muted" : null);
      li.append(document.createTextNode(period(e.start, e.end)), el("span", "ab-ag-days", " · " + daysText(e.days || [])));
      ul.append(li);
    });
    box.append(ul);
    return box;
  }
  async function loadAgenda() {
    const list = $("ab-agenda-list"), msg = $("ab-agenda-msg");
    say(msg, "");
    const { data, error } = await sb.rpc("absence_agenda_tasks_list", { p_status: state.agendaFilter });
    if (error) return say(msg, "Chargement impossible : " + error.message, "error");
    list.replaceChildren();
    if (!data.length) list.append(el("p", "muted", state.agendaFilter === "todo" ? "Aucun agenda à mettre à jour." : "Aucune tâche."));
    const groups = new Map();
    data.forEach((t) => { if (!groups.has(t.owner_id)) groups.set(t.owner_id, []); groups.get(t.owner_id).push(t); });
    for (const [, tasks] of groups) {
      const h = el("h3", "ab-ag-owner", tasks[0].owner_name);
      if ((tasks[0].clinics || []).length) h.append(el("span", "muted", " · " + tasks[0].clinics.join(", ")));
      list.append(h);
      tasks.forEach((t) => {
        const sup = t.status === "superseded";
        const card = el("article", "card ab-ag" + (t.status === "done" ? " ab-ag-done" : "") + (sup ? " ab-ag-sup" : ""));
        const head = el("div", "ab-ag-head");
        const label = t.kind === "cancelled" ? ["Débloquer", "ab-ag-debloquer"] : t.kind === "modified" ? ["Modifier", "ab-ag-bloquer"] : ["Bloquer", "ab-ag-bloquer"];
        head.append(el("span", "ug-badge " + label[1], label[0]), el("strong", null, "Absence"));
        if (t.past) head.append(el("span", "ab-ag-late", "Période passée, non faite"));
        card.append(head);
        if (t.unblock.length) card.append(agendaEntries("À débloquer", t.unblock));
        if (t.block.length) card.append(agendaEntries(t.kind === "modified" ? "À bloquer" : "", t.block));
        if (sup) {
          card.append(el("p", "muted", "Remplacée : l'absence a été modifiée ou annulée avant le blocage. Rien à faire pour cette tâche."));
        } else {
          const lab = el("label", "ab-ag-check");
          const cb = el("input"); cb.type = "checkbox"; cb.checked = t.status === "done";
          cb.addEventListener("change", async () => {
            cb.disabled = true;
            const { error: e2 } = await sb.rpc("absence_agenda_set", { p_task: t.id, p_done: cb.checked });
            if (e2) { cb.checked = !cb.checked; cb.disabled = false; return say(msg, e2.message, "error"); }
            mailer();
            await loadAgenda(); refreshAgendaCount();
          });
          lab.append(cb, el("span", null, t.kind === "cancelled" ? "Débloqué dans Ultragenda" : "Bloqué dans Ultragenda"));
          card.append(lab);
          if (t.status === "done") card.append(el("p", "muted ab-item-meta", `Fait par ${t.done_by_name || "—"} le ${zurich(t.done_at).date} ${zurich(t.done_at).time}`));
        }
        list.append(card);
      });
    }
  }
  function initAgenda() {
    $("ab-t-agenda").hidden = false;
    $("ab-t-agenda").addEventListener("click", () => setTab("agenda"));
    document.querySelectorAll("[data-agf]").forEach((b) => b.addEventListener("click", () => {
      state.agendaFilter = b.dataset.agf;
      document.querySelectorAll("[data-agf]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      loadAgenda();
    }));
    refreshAgendaCount();
  }

  function setTab(name) {
    for (const t of ["plan", "mine", "todo", "agenda", "track", "hist", "dir", "exp"]) {
      const on = t === name;
      $("ab-t-" + t).setAttribute("aria-selected", String(on));
      $("ab-p-" + t).hidden = !on;
    }
    circuitPlace(name);
    if (name === "plan") renderGrid();
    if (name === "todo") loadTodo();
    if (name === "mine") loadMine();
    if (name === "agenda") { loadAgenda(); refreshAgendaCount(); }
    if (name === "track") loadTrack();
    if (name === "hist" && (!hist.loaded || hist.stale)) loadHist(false);
  }

  // ----- Mon circuit de validation (bas des onglets Planning et Mes absences) -----
  // Schéma du circuit qui s'appliquerait à une demande type (absence_circuit_mine) ; lecture seule, mêmes colonnes que le simulateur de l'administration.
  const CIRCUIT_KEY = "onconic.absences.circuit.v1";
  const circ = { box: null, key: "", tok: 0, kind: "vacances", days: 5 };
  function circuitStored() { try { const v = localStorage.getItem(CIRCUIT_KEY); return v === "open" ? true : v === "closed" ? false : null; } catch (e) { return null; } }
  function circuitRemember(open) { try { localStorage.setItem(CIRCUIT_KEY, open ? "open" : "closed"); } catch (e) { /* stockage indisponible : l'état n'est pas mémorisé */ } }
  // Membre dont on affiche le circuit : « Résumé de » ou « Demande pour » (secrétaire de médecin cadre), sinon soi
  function circuitTarget() {
    const w = state.who || sd.target || "";
    if (!w) return "";
    return state.isDir || state.ctx.role === "cadre" || state.secOf.some((c) => c.id === w) ? w : "";
  }
  function circuitTargetName(id) {
    const c = state.secOf.find((x) => x.id === id) || state.people.find((x) => x.id === id);
    return c ? c.name : "";
  }
  function buildCircuit() {
    const d = el("details", "ab-circuit");
    d.id = "ab-circuit";
    const stored = circuitStored();
    d.open = stored == null ? !!(window.matchMedia && window.matchMedia("(min-width: 900px)").matches) : stored;
    const sum = el("summary", null, "Mon circuit de validation");
    // l'état est mémorisé seulement sur un geste de l'utilisateur (le réglage par défaut dépend de la taille d'écran)
    sum.addEventListener("click", () => circuitRemember(!d.open));
    d.append(sum);
    const body = el("div", "ab-circuit-body");
    const ctl = el("div", "ab-circuit-ctl");
    const kind = el("select"); kind.id = "ab-circuit-kind";
    for (const k of ["vacances", "congres", "autre"]) { const o = el("option", null, KINDS[k][0]); o.value = k; kind.append(o); }
    const days = el("input"); days.id = "ab-circuit-days"; days.type = "number"; days.min = "1"; days.max = "60"; days.step = "1"; days.inputMode = "numeric"; days.value = String(circ.days);
    const l1 = el("label", null, "Motif"); l1.append(kind);
    const l2 = el("label", null, "Durée (jours ouvrables)"); l2.append(days);
    ctl.append(l1, l2);
    const info = el("p", "muted ab-circuit-info"); info.id = "ab-circuit-info";
    const msg = el("p", "form-msg"); msg.id = "ab-circuit-msg"; msg.setAttribute("role", "status"); msg.setAttribute("aria-live", "polite");
    const out = el("div", "ab-circuit-flow"); out.id = "ab-circuit-flow";
    body.append(ctl, info, msg, out);
    d.append(body);
    d.addEventListener("toggle", () => { if (d.open) circuitLoad(); });
    kind.addEventListener("change", () => { circ.kind = kind.value; circuitLoad(); });
    days.addEventListener("change", () => {
      const n = Number(days.value);
      if (!Number.isInteger(n) || n < 1 || n > 60) { say(msg, "La durée va de 1 à 60 jours ouvrables.", "error"); return; }
      say(msg, ""); // valeur valide : on efface l'erreur précédente, même si circuitLoad rend la main tôt
      circ.days = n; circuitLoad();
    });
    circ.box = d;
  }
  // Le bloc suit l'onglet affiché : Planning ou Mes absences
  function circuitPlace(tab) {
    if (!circ.box) return;
    if (tab !== "plan" && tab !== "mine") { circ.box.remove(); return; }
    const sec = $("ab-p-" + tab);
    if (tab === "plan") sec.insertBefore(circ.box, $("ab-circuit-link")); else sec.append(circ.box);
    circuitLoad();
  }
  function circuitRefresh() { if (circ.box && circ.box.isConnected) circuitLoad(); }
  async function circuitLoad() {
    const d = circ.box;
    if (!d || !d.open || !d.isConnected) return;
    const user = circuitTarget();
    const key = [user, circ.kind, circ.days].join("|");
    if (key === circ.key) return;
    const tok = ++circ.tok;
    circ.key = key;
    const msg = $("ab-circuit-msg"), out = $("ab-circuit-flow"), info = $("ab-circuit-info");
    d.querySelector("summary").textContent = user ? "Circuit de validation de " + (circuitTargetName(user) || "ce membre") : "Mon circuit de validation";
    say(msg, "Chargement…");
    const { data, error } = await sb.rpc("absence_circuit_mine", { p_user: user || null, p_kind: circ.kind, p_days: circ.days });
    if (tok !== circ.tok) return; // réponse d'un choix plus ancien : ignorée
    if (error || !data) { circ.key = ""; info.textContent = ""; out.replaceChildren(); return say(msg, "Circuit indisponible : " + (error ? error.message : "réponse vide"), "error"); }
    say(msg, "");
    info.textContent = `Circuit qui s'appliquerait à une demande de ${data.days} jours ouvrables à partir du ${fmtCH(data.from)} ; les étapes conditionnelles peuvent varier selon le motif et la durée.`;
    out.replaceChildren(window.CircuitView.applied(data), ...window.CircuitView.flow(data), ...window.CircuitView.notes(data));
  }

  // ----- Démarrage -----
  (async () => {
    if (!sb) return ($("ug-status").textContent = "Service indisponible.");
    const { data } = await sb.auth.getSession();
    if (!data.session) return (location.href = "/fr/the-hive.html");
    $("logout").addEventListener("click", async () => { await sb.auth.signOut(); location.href = "/fr/"; });
    const { data: ctx, error } = await sb.rpc("absence_context");
    if (error || !ctx) { $("ug-status").textContent = "L'outil Absences est réservé aux membres de l'institution CHUV (et aux administrateurs). Contactez l'administration si votre compte devrait y avoir accès."; return; }
    state.ctx = ctx;
    state.isDir = ctx.role === "direction" || ctx.role === "admin";
    ctx.validates = ctx.validates || [];
    ctx.clinics = ctx.clinics || [];
    loadPrefs();
    const t = new Date();
    state.month = { y: t.getFullYear(), m: t.getMonth() };
    try {
      const [people, clinics] = await Promise.all([sb.rpc("absence_people"), sb.rpc("absence_clinics")]);
      if (people.error) throw people.error;
      state.people = people.data || [];
      state.clinics = (clinics.data || []).filter((c) => state.people.some((p) => (p.clinics || []).includes(c.clinic)));
    } catch (e) { $("ug-status").textContent = "Chargement impossible : " + e.message; return; }
    $("ug-status").hidden = true;
    $("ab-tool").hidden = false;
    notificationStatus();

    // Formulaire
    const today = todayIso();
    $("ab-start").min = $("ab-end").min = today.slice(0, 4) + "-01-01";
    $("ab-form").addEventListener("submit", submitRequest);
    ["ab-start", "ab-end", "ab-kind"].forEach((id) => $(id).addEventListener("change", updateDays));
    $("ab-start").addEventListener("change", () => { if (!$("ab-end").value || $("ab-end").value < $("ab-start").value) $("ab-end").value = $("ab-start").value; updateDays(); });
    if (!ctx.clinics.length && ctx.role !== "admin") {
      say($("ab-msg"), ["clinician", "cdc", "cadre"].includes(ctx.role)
        ? "Aucune clinique de rattachement n'est enregistrée pour vous : seul l'administrateur validera vos demandes. Renseignez vos cliniques dans Mon compte."
        : "", "");
    }

    // Planning
    fillScope();
    $("ab-rows").value = String(state.prefs.rows);
    if (window.OnconicSort && $("ab-sort-slot")) {
      $("ab-sort-slot").replaceChildren(window.OnconicSort.control("absences", { modes: SORT_MODES, onChange: () => { renderGrid(); renderOrder(); if (!$("ab-pick").hidden) renderPicker(); } }));
    }
    $("ab-scope").addEventListener("change", (e) => { state.tempScope = null; state.prefs.scope = e.target.value; savePrefs(); fillScope(); renderGrid(); if (!$("ab-pick").hidden) renderPicker(); });
    $("ab-temp-back").addEventListener("click", () => { state.tempScope = null; renderGrid(); if (!$("ab-pick").hidden) renderPicker(); });
    $("ab-rows").addEventListener("change", (e) => { state.prefs.rows = Number(e.target.value); savePrefs(); renderGrid(); });
    if (window.monthPicker) window.monthPicker($("ab-title"), { get: pickerValue, onPick: pickMonth });
    $("ab-prev").addEventListener("click", () => shiftView(-1));
    $("ab-next").addEventListener("click", () => shiftView(1));
    $("ab-today").addEventListener("click", goToday);
    $("ab-winlen").addEventListener("change", (e) => { state.prefs.winLen = Number(e.target.value); savePrefs(); renderGrid(); });
    $("ab-ov-clinic").addEventListener("change", (e) => { state.ov.clinic = e.target.value; renderGrid(); });
    $("ab-ov").addEventListener("click", (e) => { const td = e.target.closest("td[data-day]"); if (td) showLoadDetail(td.dataset.day); });
    $("ab-ov").addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const td = e.target.closest("td[data-day]");
      if (td) { e.preventDefault(); showLoadDetail(td.dataset.day); }
    });
    $("ab-pick-toggle").addEventListener("click", (e) => {
      const open = $("ab-pick").hidden;
      $("ab-pick").hidden = !open;
      e.currentTarget.setAttribute("aria-expanded", String(open));
      if (open) renderPicker();
    });
    $("ab-pick-q").addEventListener("input", renderPicker);
    $("ab-pick-all").addEventListener("click", () => {
      const q = norm($("ab-pick-q").value);
      const ids = new Set(selection().map((p) => p.id));
      state.people.filter((p) => !q || norm(p.name + " " + (p.clinics || []).join(" ")).includes(q)).forEach((p) => ids.add(p.id));
      setCustom([...ids]); renderPicker();
    });
    $("ab-pick-none").addEventListener("click", () => { setCustom([]); renderPicker(); });
    $("ab-order-reset").addEventListener("click", () => setOrder([]));
    const open = (td) => { if (td.dataset.cal) showCalDetail(td.dataset.cal); else if (td.dataset.id) showDetail(td.dataset.user, td.dataset.id); };
    $("ab-scroll").addEventListener("click", (e) => { const td = e.target.closest("td[data-id], td[data-cal]"); if (td) open(td); });
    $("ab-scroll").addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const td = e.target.closest("td[data-id], td[data-cal]");
      if (td) { e.preventDefault(); open(td); }
    });

    // Onglets, export, valideurs
    $("ab-t-plan").addEventListener("click", () => setTab("plan"));
    $("ab-t-mine").addEventListener("click", () => setTab("mine"));
    $("ab-t-todo").addEventListener("click", () => setTab("todo"));
    if (wideMq) wideMq.addEventListener("change", () => { if (!$("ab-p-todo").hidden) renderTodo(); });
    $("ab-docx").addEventListener("click", exportDocx);
    // Popup d'envoi
    $("ab-drafts-open").addEventListener("click", () => { const c = sd.pending || []; sd.pending = []; openSend(c); });
    $("ab-save").addEventListener("click", () => createDraft(false));
    $("sd-more").addEventListener("click", addAnother);
    $("sd-go").addEventListener("click", askConfirm);
    $("sd-back").addEventListener("click", () => { $("sd-confirm").hidden = true; $("sd-main").hidden = false; });
    $("sd-yes").addEventListener("click", doSend);
    for (const id of ["sd-close", "sd-done-close"]) $(id).addEventListener("click", () => $("sd").close());
    $("sd").addEventListener("close", () => loadDrafts());
    // Abonnement à l'agenda
    const subBtn = $("ab-sub-btn"), subBox = $("ab-sub");
    subBtn.addEventListener("click", () => {
      const open = subBox.hidden;
      subBox.hidden = !open;
      subBtn.setAttribute("aria-expanded", String(open));
      if (open && !subBox.dataset.ready) { subBox.dataset.ready = "1"; subscribeBody(subBox); }
    });
    if (state.isDir || ctx.validates.length) {
      $("ab-t-exp").hidden = false;
      $("ab-t-exp").addEventListener("click", () => setTab("exp"));
      initExport();
    }
    if (state.isDir) {
      $("ab-t-track").hidden = false;
      $("ab-t-track").addEventListener("click", () => setTab("track"));
      initTrack();
      $("ab-t-dir").hidden = false;
      $("ab-t-dir").addEventListener("click", () => setTab("dir"));
      initDirection();
    }
    if (ctx.validates.length || state.isDir) {
      $("ab-t-todo").hidden = false;
      const who = $("ab-who");
      const me = el("option", null, "Moi"); me.value = ""; who.append(me);
      state.people.filter((p) => !p.is_me && (state.isDir || sharesClinic(p, ctx.validates))).sort((x, y) => compareNames(x, y, sortMode())).forEach((p) => { const o = el("option", null, p.name); o.value = p.id; who.append(o); });
      who.addEventListener("change", () => { state.who = who.value; loadMine(); });
      $("ab-who-wrap").hidden = false;
      loadRejected();
    }
    // Blocage Ultragenda et secrétaires de médecin cadre (absents si la migration n'est pas appliquée)
    const ac = await sb.rpc("absence_agenda_context");
    state.agendaCtx = ac.error ? null : ac.data;
    state.secOf = (state.agendaCtx && state.agendaCtx.secretary_of) || [];
    if (state.agendaCtx && state.agendaCtx.tab) initAgenda();
    if (state.secOf.length) {
      const forSel = $("ab-for");
      const meOpt = el("option", null, "Moi"); meOpt.value = ""; forSel.append(meOpt);
      state.secOf.forEach((c) => { const o = el("option", null, c.name); o.value = c.id; forSel.append(o); });
      forSel.addEventListener("change", () => { sd.target = forSel.value; sd.pending = []; loadDrafts(); circuitRefresh(); });
      $("ab-for-wrap").hidden = false;
      const who = $("ab-who");
      if (!who.options.length) { const me = el("option", null, "Moi"); me.value = ""; who.append(me); }
      state.secOf.forEach((c) => { if (![...who.options].some((o) => o.value === c.id)) { const o = el("option", null, c.name); o.value = c.id; who.append(o); } });
      if (!who.dataset.bound && !(ctx.validates.length || state.isDir)) { who.dataset.bound = "1"; who.addEventListener("change", () => { state.who = who.value; loadMine(); }); }
      $("ab-who-wrap").hidden = false;
    }
    initHistory();
    // Mon circuit de validation : pour tout membre qui a l'outil Absences (cette page n'est ouverte qu'à eux) ; lien en lecture du circuit pour un médecin cadre
    if (window.CircuitView) { buildCircuit(); circuitPlace("plan"); }
    $("ab-circuit-link").hidden = ctx.role !== "cadre";
    await Promise.all([renderGrid(), loadMine(), loadDrafts(), refreshPending()]);
    if (location.hash === "#agenda" && state.agendaCtx && state.agendaCtx.tab) setTab("agenda");
    else if (location.hash === "#todo" && (ctx.validates.length || state.isDir)) setTab("todo");
    else if (location.hash === "#mine") setTab("mine");
    else if (location.hash === "#hist") setTab("hist");
  })();
})();
