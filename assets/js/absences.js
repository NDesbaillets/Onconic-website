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
    ctx: null, people: [], clinics: [], month: null, cache: new Map(), prefs: { scope: "mine", ids: [], rows: 20, order: [] },
    mine: [], mineWarn: null, todo: [], rejected: [], who: "", drafts: [], approvals: new Map(), whoApprovals: new Map()
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
  function mailer() {
    try { sb.functions.invoke("notify-absence", { body: {} }).catch(() => {}); } catch (e) { /* facultatif */ }
  }

  // ----- Données -----
  async function loadMonth() {
    const { y, m } = state.month;
    const key = `${y}-${m}`;
    if (state.cache.has(key)) return state.cache.get(key);
    const [{ data, error }, calRes] = await Promise.all([
      sb.rpc("absence_grid", { p_from: monthStart(y, m), p_to: monthEnd(y, m) }),
      sb.rpc("absence_calendar", { p_from: monthStart(y, m), p_to: monthEnd(y, m) })
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
  async function refreshPending() {
    const { data } = await sb.rpc("absence_pending_count");
    const n = Number(data) || 0;
    $("ab-todo-n").textContent = n ? String(n) : "";
    $("ab-t-todo").setAttribute("aria-label", n ? `À valider, ${plur(n, "demande", "demandes")}` : "À valider");
  }

  // ----- Sélection des personnes affichées -----
  const sharesClinic = (p, list) => (p.clinics || []).some((c) => list.includes(c));
  function selection() {
    const me = state.ctx.me;
    const { scope, ids } = state.prefs;
    let list;
    if (scope === "all") list = state.people.slice();
    else if (scope === "custom") { const set = new Set(ids); list = state.people.filter((p) => set.has(p.id)); }
    else if (scope === "mine") {
      const mine = state.ctx.clinics || [];
      list = state.people.filter((p) => p.is_me || sharesClinic(p, mine));
    } else list = state.people.filter((p) => (p.clinics || []).includes(scope));
    // Ordre choisi par le membre (« Ordre d'affichage »), puis moi en tête et ordre alphabétique
    const rank = new Map(state.prefs.order.map((id, i) => [id, i]));
    const r = (p) => (rank.has(p.id) ? rank.get(p.id) : Infinity);
    return list.sort((a, b) => (r(a) - r(b)) || (b.is_me - a.is_me) || a.name.localeCompare(b.name, "fr"));
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
    const { y, m } = state.month;
    $("ab-title").textContent = `${MONTHS[m][0].toUpperCase()}${MONTHS[m].slice(1)} ${y}`;
    let byUser, cal;
    try { ({ byUser, cal } = await loadMonth()); } catch (e) {
      $("ug-status").hidden = false;
      return say($("ug-status"), "Chargement du planning impossible : " + e.message, "error");
    }
    const all = selection();
    const limit = state.prefs.rows;
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
  function showCalDetail(day) {
    const { cal } = state.cache.get(`${state.month.y}-${state.month.m}`);
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

  function showDetail(userId, id) {
    const people = new Map(state.people.map((p) => [p.id, p]));
    const a = (state.cache.get(`${state.month.y}-${state.month.m}`).byUser.get(userId) || []).find((x) => String(x.id) === String(id));
    if (!a) return;
    const p = people.get(userId);
    const box = $("ab-detail");
    box.replaceChildren();
    const head = el("div", "ab-detail-head");
    head.append(el("strong", null, p ? p.name : "Collaborateur"), el("span", `ug-badge ab-st ab-st-${a.status}`, STATUS[a.status]), el("span", "ug-badge", KINDS[a.kind][0]));
    box.append(head);
    box.append(el("p", null, `${period(a.start_date, a.end_date)} · ${plur(workdays(a.start_date, a.end_date), "jour ouvrable", "jours ouvrables")}`));
    if (a.note) box.append(el("p", "muted", "Précision : " + a.note));
    if (p && p.is_me && (a.status === "requested" || a.change_type)) {
      const rows = state.approvals.get(String(a.id)) || [];
      box.append(el("p", "muted", rows.length ? `Validation : ${approvalCount(rows)} sur ${rows.length}` : "Validation par l'administration"), approvalsBlock(rows));
    }
    if (a.change_type === "delete") box.append(el("p", "muted", "Suppression demandée, en attente de décision."));
    if (a.change_type === "modify") box.append(el("p", "muted", `Modification demandée : ${period(String(a.change_start).slice(0, 10), String(a.change_end).slice(0, 10))}, en attente de décision.`));
    if (p && p.is_me) box.append(button("Gérer dans « Mes absences »", "btn btn-outline", () => setTab("mine")));
    box.hidden = false;
  }

  // ----- Choix des personnes -----
  function renderPicker() {
    const q = norm($("ab-pick-q").value);
    const chosen = new Set(selection().map((p) => p.id));
    const list = $("ab-pick-list");
    list.replaceChildren();
    for (const p of state.people) {
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
    state.prefs.scope = "custom"; state.prefs.ids = ids;
    savePrefs(); fillScope(); renderGrid();
  }

  // ----- Demande d'absence -----
  function updateDays() {
    const a = $("ab-start").value, b = $("ab-end").value;
    $("ab-days").textContent = a && b && b >= a ? `${plur(workdays(a, b), "jour ouvrable", "jours ouvrables")} (hors week-ends et fériés vaudois), ${plur((pd(b) - pd(a)) / 864e5 + 1, "jour calendaire", "jours calendaires")}` : "";
    $("ab-note-hint").textContent = $("ab-kind").value === "autre" ? "(obligatoire)" : "(facultatif)";
  }
  // Le formulaire crée un brouillon, puis ouvre le popup : validateurs prévenus, ajout d'autres demandes, confirmation, envoi groupé
  async function submitRequest(ev) {
    ev.preventDefault();
    const msg = $("ab-msg"), warn = $("ab-warn");
    warn.replaceChildren();
    const kind = $("ab-kind").value, note = $("ab-note").value.trim(), start = $("ab-start").value, end = $("ab-end").value;
    if (!start || !end) return say(msg, "Indiquez les dates de début et de fin.", "error");
    if (end < start) return say(msg, "La fin doit être le même jour ou après le début.", "error");
    if (kind === "autre" && note.length < 2) return say(msg, "Pour le motif « autre », indiquez une précision.", "error");
    const btn = $("ab-send");
    btn.disabled = true;
    say(msg, "Préparation…");
    try {
      const { data, error } = await sb.rpc("absence_request", { p_kind: kind, p_note: note, p_start: start, p_end: end });
      if (error) return say(msg, error.message, "error");
      say(msg, "");
      $("ab-note").value = "";
      await loadDrafts();
      await openSend(data.conflicts);
    } finally { btn.disabled = false; }
  }
  async function afterChange() {
    state.cache.clear();
    await Promise.all([renderGrid(), loadMine(), loadDrafts(), refreshPending(), (state.ctx.validates.length || state.isDir) ? Promise.all([loadTodo(), loadRejected()]) : null]);
  }

  // ----- Brouillons et popup d'envoi -----
  const sd = { info: { validators: [], fallback: false }, conflicts: [] };
  const names = (list) => list.map((v) => v.name).join(", ");
  async function loadDrafts() {
    const [list, appr] = await Promise.all([sb.rpc("absence_list", { p_user: null }), sb.rpc("absence_approvals_all", { p_user: null })]);
    state.drafts = (list.data || []).filter((a) => a.status === "draft").map((a) => Object.assign(a, { start_date: String(a.start_date).slice(0, 10), end_date: String(a.end_date).slice(0, 10) }));
    state.approvals = groupApprovals(appr.data);
    const n = state.drafts.length;
    $("ab-drafts").hidden = !n || $("sd").open;
    $("ab-drafts-text").textContent = n ? `${plur(n, "demande", "demandes")} en brouillon, pas encore envoyée${n > 1 ? "s" : ""} aux validateurs.` : "";
    if (!state.who) renderMine(); // l'avancement des validations vient d'arriver
  }
  function groupApprovals(rows) {
    const m = new Map();
    for (const r of rows || []) { const k = String(r.absence_id); if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
    return m;
  }
  async function openSend(conflicts) {
    sd.conflicts = conflicts || [];
    $("sd-main").hidden = false; $("sd-confirm").hidden = true; $("sd-done").hidden = true;
    say($("sd-msg"), ""); say($("sd-addmsg"), "");
    $("sd-add").open = false;
    const { data } = await sb.rpc("absence_my_validators");
    sd.info = data || { validators: [], fallback: false };
    renderSend();
    if (!$("sd").open) $("sd").showModal();
    $("ab-drafts").hidden = true;
  }
  function recipients() {
    const v = sd.info.validators || [];
    return v.length ? names(v) : "l'administration";
  }
  function renderSend() {
    const v = sd.info.validators || [];
    $("sd-to").textContent = !v.length ? "Aucun validateur n'est disponible pour l'instant : la demande sera adressée à l'administration."
      : sd.info.fallback ? `Aucun validateur n'est désigné pour vos cliniques : votre demande sera envoyée à l'administration (${names(v)}).`
      : `Vous allez envoyer une demande de validation à : ${names(v)}.`;
    $("sd-rule").textContent = v.length > 1 && !sd.info.fallback
      ? "Chaque absence doit être validée par tous ces validateurs. Ils reçoivent un seul e-mail pour l'ensemble de vos demandes ; vous êtes prévenu·e dès que tout est validé, ou dès qu'un validateur refuse."
      : "Le validateur reçoit un seul e-mail pour l'ensemble de vos demandes ; vous êtes prévenu·e de sa décision.";
    const list = $("sd-list");
    list.replaceChildren();
    for (const a of state.drafts) {
      const li = el("li");
      li.append(el("span", "ab-draft-when", period(a.start_date, a.end_date)), el("span", "ug-badge", KINDS[a.kind][0]),
        el("span", "muted", `${plur(workdays(a.start_date, a.end_date), "jour ouvrable", "jours ouvrables")}${a.note ? " · " + a.note : ""}`));
      li.append(button("Retirer", "btn btn-outline ab-mini", async () => {
        const { error } = await sb.rpc("absence_withdraw", { p_id: a.id });
        if (error) return say($("sd-msg"), error.message, "error");
        await loadDrafts(); renderSend();
      }));
      list.append(li);
    }
    if (!state.drafts.length) list.append(el("li", "muted", "Aucune demande en brouillon : ajoutez-en une ci-dessous."));
    $("sd-go").disabled = !state.drafts.length;
    const warn = $("sd-warn");
    warn.replaceChildren();
    const w = warnBox(sd.conflicts, "Attention : trop d'absences en même temps");
    if (w) { w.append(el("p", "muted", "La demande peut quand même être envoyée ; les validateurs voient le même avertissement.")); warn.append(w); }
    balanceWarnInto(warn);
  }
  async function addToSend(ev) {
    ev.preventDefault();
    const out = $("sd-addmsg");
    const kind = $("sd-kind").value, note = $("sd-note").value.trim(), start = $("sd-start").value, end = $("sd-end").value;
    if (!start || !end || end < start) return say(out, "Vérifiez les dates.", "error");
    if (kind === "autre" && note.length < 2) return say(out, "Pour le motif « autre », indiquez une précision.", "error");
    const { data, error } = await sb.rpc("absence_request", { p_kind: kind, p_note: note, p_start: start, p_end: end });
    if (error) return say(out, error.message, "error");
    sd.conflicts = (data.conflicts || []).concat(sd.conflicts);
    $("sd-note").value = ""; $("sd-start").value = ""; $("sd-end").value = "";
    say(out, "Ajoutée à l'envoi.", "ok");
    await loadDrafts(); renderSend();
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
      const { data, error } = await sb.rpc("absence_submit");
      if (error) return say($("sd-confirm-msg"), error.message, "error");
      mailer();
      $("sd-confirm").hidden = true; $("sd-done").hidden = false;
      const who = (data.validators || []).length ? names(data.validators) : "l'administration";
      $("sd-done-text").textContent = `${plur(data.count, "demande envoyée", "demandes envoyées")}. ${who} ${(data.validators || []).length > 1 ? "sont prévenus" : "est prévenu·e"} par e-mail. Vous serez prévenu·e par e-mail dès que tout est validé, ou dès qu'un validateur refuse.`;
      say($("sd-confirm-msg"), "");
      await afterChange();
    } finally { btn.disabled = false; }
  }

  // ----- Mes absences -----
  async function loadMine() {
    const { data, error } = await sb.rpc("absence_list", { p_user: state.who || null });
    if (error) return say($("ab-mine-msg"), "Chargement impossible : " + error.message, "error");
    state.mine = (data || []).map((a) => Object.assign(a, {
      start_date: String(a.start_date).slice(0, 10), end_date: String(a.end_date).slice(0, 10),
      change_start: a.change_start && String(a.change_start).slice(0, 10), change_end: a.change_end && String(a.change_end).slice(0, 10)
    }));
    // Avancement des validations (rechargé à chaque ouverture : un validateur a pu décider entre-temps)
    const r = await sb.rpc("absence_approvals_all", { p_user: state.who || null });
    if (state.who) state.whoApprovals = groupApprovals(r.data); else state.approvals = groupApprovals(r.data);
    fillYears();
    renderMine();
    loadBalance();
  }

  // ----- Soldes de vacances et de congrès (jamais bloquants : avertissement seulement) -----
  const fmtD = (n) => String(Math.round(Number(n) * 10) / 10).replace(".", ",");
  const BAL_YEAR = new Date().getFullYear();
  function balanceLines(b, who) {
    const you = who ? "Le solde" : "Votre solde";
    const out = [], warn = [];
    const v = b.vacation, c = b.congress;
    out.push(`Vacances : ${v.manual ? "solde inscrit par la direction au " + fmtCH(v.as_of) + " : " + fmtD(v.baseline) + " j, " : "droit " + fmtD(v.allowance) + " j, "}posés ${fmtD(v.used)} j, reste ${fmtD(v.remaining)} j`);
    if (Number(v.remaining) < 0) warn.push(`${you} de vacances ${b.year} est dépassé de ${fmtD(-v.remaining)} jour${Math.abs(v.remaining) > 1 ? "s" : ""}.`);
    if (c.unlimited) out.push(`Congrès et formation : sans limite, posés ${fmtD(c.used)} j`);
    else {
      out.push(`Congrès et formation : ${c.manual ? "solde inscrit par la direction au " + fmtCH(c.as_of) + " : " + fmtD(c.baseline) + " j, " : "droit " + fmtD(c.allowance) + " j, "}posés ${fmtD(c.used)} j, reste ${fmtD(c.remaining)} j`);
      if (Number(c.remaining) < 0) warn.push(`${you} de congrès et formation ${b.year} est dépassé de ${fmtD(-c.remaining)} jour${Math.abs(c.remaining) > 1 ? "s" : ""}.`);
    }
    return { out, warn };
  }
  async function loadBalance() {
    const box = $("ab-balance");
    if (!box) return;
    const year = state.balYear || BAL_YEAR;
    const { data: b, error } = await sb.rpc("absence_balance", { p_user: state.who || null, p_year: year });
    if (error || !b) { box.hidden = true; return; }
    box.hidden = false;
    box.replaceChildren();
    const head = el("div", "ab-bar-sub");
    head.append(el("strong", null, state.who ? "Soldes de ce membre" : "Mes soldes"));
    const sel = el("select");
    [BAL_YEAR - 1, BAL_YEAR, BAL_YEAR + 1, BAL_YEAR + 2].forEach((y) => { const o = el("option", null, String(y)); o.value = String(y); sel.append(o); });
    sel.value = String(year);
    sel.setAttribute("aria-label", "Année des soldes");
    sel.addEventListener("change", () => { state.balYear = Number(sel.value); loadBalance(); });
    head.append(sel);
    box.append(head);
    const { out, warn } = balanceLines(b, !!state.who);
    out.forEach((l) => box.append(el("p", null, l)));
    box.append(el("p", "muted ab-item-meta", "Jours ouvrables (lundi à vendredi, fériés vaudois déduits) des absences demandées ou validées. Un solde insuffisant ne bloque aucune demande."));
    if (warn.length) {
      const w = el("div", "ab-warn");
      w.append(el("strong", null, "Attention : solde insuffisant"));
      warn.forEach((t) => w.append(el("p", null, t)));
      w.append(el("p", "muted", "La demande n'est pas bloquée ; la direction en est informée."));
      box.append(w);
    }
  }
  // Avertissement dans la fenêtre d'envoi : solde de l'année de chaque brouillon (les brouillons comptent pour leur auteur)
  async function balanceWarnInto(warnBox2) {
    const years = [...new Set(state.drafts.filter((a) => a.kind === "vacances" || a.kind === "congres").flatMap((a) => {
      const out = []; for (let y = Number(a.start_date.slice(0, 4)); y <= Number(a.end_date.slice(0, 4)); y++) out.push(y); return out; }))];
    const msgs = [];
    for (const y of years) {
      const { data: b } = await sb.rpc("absence_balance", { p_user: null, p_year: y });
      if (!b) continue;
      const { warn } = balanceLines(b, false);
      msgs.push(...warn);
    }
    if (!msgs.length) return;
    const w = el("div", "ab-warn");
    w.append(el("strong", null, "Attention : solde insuffisant avec ces demandes"));
    msgs.forEach((t) => w.append(el("p", null, t)));
    w.append(el("p", "muted", "La demande peut quand même être envoyée ; les validateurs et la direction voient le même avertissement."));
    warnBox2.append(w);
  }
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
    const save = el("button", "btn", mode === "change" ? "Envoyer la demande de modification" : mode === "direction" ? "Enregistrer (validée d'office)" : a.status === "rejected" ? "Renvoyer en validation" : "Enregistrer");
    save.type = "submit";
    actions.append(save, button("Annuler", "btn btn-outline", () => renderMine()));
    f.append(row, out, actions);
    f.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      if (!start.value || !end.value || end.value < start.value) return say(out, "Vérifiez les dates.", "error");
      save.disabled = true;
      const args = { p_kind: kind.value, p_note: note.value.trim(), p_start: start.value, p_end: end.value };
      const { data, error } = mode === "change"
        ? await sb.rpc("absence_request_change", Object.assign({ p_id: a.id, p_type: "modify" }, args))
        : mode === "direction"
          ? await sb.rpc("absence_direction_update", Object.assign({ p_id: a.id, p_confidential: kind.value === "autre" ? !!(conf && conf.checked) : false }, args))
          : await sb.rpc("absence_update", Object.assign({ p_id: a.id }, args));
      if (error) { save.disabled = false; return say(out, error.message, "error"); }
      state.mineWarn = warnBox(data.conflicts, "Attention : trop d'absences en même temps");
      say($("ab-mine-msg"), mode === "change" ? "Demande de modification envoyée aux validateurs : l'absence reste validée aux anciennes dates jusqu'à leur décision (tous doivent l'accepter)." : "Demande modifiée : elle repasse en brouillon, envoyez-la pour relancer la validation.", "ok");
      if (mode === "direction") {
        say($("ab-mine-msg"), a.user_id === state.ctx.me ? "Absence modifiée." : "Absence modifiée par la direction : le membre est prévenu.", "ok"); mailer();
        const bw = (data.balance || []).map((x) => `Solde ${x.kind === "vacances" ? "de vacances" : "de congrès"} ${x.year} dépassé (après : ${fmtD(x.remaining_after)} j).`);
        if (bw.length) {
          const w = el("div", "ab-warn"); w.append(el("strong", null, "Attention : solde insuffisant (la modification n'est pas bloquée)")); bw.forEach((t) => w.append(el("p", null, t)));
          if (state.mineWarn) state.mineWarn.append(w); else state.mineWarn = w;
        }
      }
      if (mode === "change") mailer();
      await afterChange();
    });
    return f;
  }

  // Avancement de la validation : qui a validé, qui attend, qui a refusé
  function approvalsBlock(rows) {
    const box = el("div", "ab-appr");
    if (!rows.length) { box.append(el("p", "muted", "Aucun validateur désigné : l'administration décide.")); return box; }
    const ul = el("ul", "ab-appr-list");
    const LABEL = { approved: "a validé", pending: "en attente", rejected: "a refusé", skipped: "n'a pas eu à se prononcer (demande déjà refusée)" };
    rows.forEach((r) => {
      const li = el("li", "ab-appr-" + r.decision);
      li.append(el("strong", null, r.validator_name || r.name),
        document.createTextNode(` : ${LABEL[r.decision]}${r.decided_at && ["approved", "rejected"].includes(r.decision) ? " le " + fmtCH(r.decided_at) : ""}${r.comment ? " · « " + r.comment + " »" : ""}`));
      ul.append(li);
    });
    box.append(ul);
    return box;
  }
  const approvalCount = (rows) => rows.filter((r) => r.decision === "approved").length;
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
  async function downloadForm(a) {
    const msg = $("ab-mine-msg");
    const ids = state.mine.filter((x) => x.status === "approved" && x.user_id === a.user_id && x.submitted_at === a.submitted_at).map((x) => x.id);
    say(msg, "Préparation du formulaire…");
    const { data, error } = await sb.functions.invoke("notify-absence", { body: { action: "form", ids } });
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
  function formButton(a, own) {
    if (a.status !== "approved" || !a.submitted_at) return null;
    if (own && !["clinician", "cdc", "cadre"].includes(state.ctx.role)) return null;
    return button("Télécharger le formulaire (PDF)", "btn btn-outline", () => downloadForm(a));
  }

  function absenceCard(a, own) {
    const card = el("article", `card ab-item ab-item-${a.status}`);
    const head = el("div", "ab-item-head");
    head.append(el("strong", null, period(a.start_date, a.end_date)), el("span", "ug-badge", KINDS[a.kind][0]),
      el("span", `ug-badge ab-st ab-st-${a.status}`, STATUS[a.status]));
    if (a.confidential) head.append(el("span", "ug-badge", "Confidentiel"));
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
    if (a.stage === 2 && (a.status === "requested" || (a.status === "approved" && a.change_type))) {
      card.append(el("p", "ab-pending-change", "Validée par les validateurs de la clinique : en attente du visa de la direction."));
    }
    if (a.status === "rejected" && a.decided_at) {
      const gone = new Date(new Date(a.decided_at).getTime() + 14 * 864e5);
      card.append(el("p", "muted ab-item-meta", `Cette demande refusée disparaîtra d'elle-même le ${fmtCH(iso(gone))}. Vous pouvez la supprimer dès maintenant.`));
    }
    if (own && (a.status === "requested" || (a.status === "approved" && a.change_type)) && (a.submitted_at || a.resent_at)) {
      card.append(el("p", "muted ab-item-meta", `${a.submitted_at ? "Envoyée aux validateurs le " + fmtDT(a.change_requested_at && a.status === "approved" ? a.change_requested_at : a.submitted_at) : ""}${a.resent_at ? (a.submitted_at ? " · " : "") + "dernier rappel le " + fmtDT(a.resent_at) : ""}`));
    }
    if (a.status === "draft") card.append(el("p", "muted ab-item-meta", "Brouillon : les validateurs ne sont pas encore prévenus. Envoyez-le pour lancer la validation."));
    if (!own && a.status === "rejected" && state.who) {
      const del = el("div", "btn-row ab-actions");
      del.append(button("Supprimer cette demande refusée", "btn btn-outline lt-danger", async () => {
        const { error } = await sb.rpc("absence_delete_rejected", { p_id: a.id });
        if (error) return say($("ab-mine-msg"), error.message, "error");
        say($("ab-mine-msg"), "Demande refusée supprimée.", "ok");
        await afterChange();
      }));
      card.append(del);
    }
    if (!own) {
      const row = el("div", "btn-row ab-actions");
      const fb = formButton(a, false);
      if (fb) row.append(fb);
      // La direction modifie ou annule au nom du membre (le membre est prévenu par e-mail)
      if (state.isDir && state.who && (a.status === "approved" || a.status === "requested")) {
        if (a.status === "approved") row.append(button("Modifier (direction)", "btn btn-outline", () => row.replaceWith(editForm(a, "direction"))));
        row.append(button("Annuler cette absence (direction)", "btn btn-outline lt-danger", async () => {
          if (!confirm(`Annuler l'absence de ${$("ab-who").selectedOptions[0].textContent} (${period(a.start_date, a.end_date)}) ? Le membre est prévenu par e-mail.`)) return;
          const { error } = await sb.rpc("absence_direction_cancel", { p_id: a.id });
          if (error) return say($("ab-mine-msg"), error.message, "error");
          say($("ab-mine-msg"), "Absence annulée par la direction : le membre est prévenu.", "ok");
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
        button("Supprimer", "btn btn-outline lt-danger", async () => {
          if (!confirm(`Supprimer cette demande refusée (${period(a.start_date, a.end_date)}) ?`)) return;
          const { error } = await sb.rpc("absence_delete_rejected", { p_id: a.id });
          if (error) return say($("ab-mine-msg"), error.message, "error");
          say($("ab-mine-msg"), "Demande refusée supprimée.", "ok");
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
  async function loadTodo() {
    const { data, error } = await sb.rpc("absence_to_validate");
    if (error) return say($("ab-todo-msg"), "Chargement impossible : " + error.message, "error");
    state.todo = (data || []).map((a) => Object.assign(a, {
      start_date: String(a.start_date).slice(0, 10), end_date: String(a.end_date).slice(0, 10),
      change_start: a.change_start && String(a.change_start).slice(0, 10), change_end: a.change_end && String(a.change_end).slice(0, 10)
    }));
    renderTodo();
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
      card.append(head);
      const gone = new Date(new Date(a.decided_at).getTime() + 14 * 864e5);
      card.append(el("p", "ab-decision", `Refusée${a.decided_by_name ? " par " + a.decided_by_name : ""} le ${fmtCH(a.decided_at)}${a.decision_comment ? " : « " + a.decision_comment + " »" : ""}. Disparaît d'elle-même le ${fmtCH(iso(gone))}.`));
      const act = el("div", "btn-row ab-actions");
      act.append(button("Supprimer", "btn btn-outline lt-danger", async () => {
        if (!confirm(`Supprimer la demande refusée de ${a.name} (${period(a.start_date, a.end_date)}) ?`)) return;
        const { error: e2 } = await sb.rpc("absence_delete_rejected", { p_id: a.id });
        if (e2) return say($("ab-todo-msg"), e2.message, "error");
        say($("ab-todo-msg"), "Demande refusée supprimée.", "ok");
        await loadRejected();
      }));
      card.append(act);
      box.append(card);
    }
  }
  function renderTodo() {
    const list = $("ab-todo-list");
    list.replaceChildren();
    if (!state.todo.length) { list.append(el("p", "muted", "Aucune demande en attente.")); return; }
    for (const a of state.todo) {
      const card = el("article", "card ab-item ab-item-requested");
      const head = el("div", "ab-item-head");
      const isChange = !!a.change_type;
      head.append(el("strong", null, a.name), el("span", "ug-badge", (a.clinics || []).join(", ") || "Sans clinique"),
        el("span", "ug-badge ug-warn", isChange ? (a.change_type === "delete" ? "Suppression demandée" : "Modification demandée") : "Nouvelle demande"));
      if (a.stage === 2) head.append(el("span", "ug-badge", "Visa de la direction"));
      card.append(head);
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
        card.append(el("p", "muted ab-item-meta", a.stage === 2
          ? "Les validateurs de la clinique ont validé : votre visa conclut la demande."
          : "L'absence n'est validée que lorsque tous les validateurs concernés ont validé, puis visée par la direction ; un seul refus suffit à la refuser."));
      } else if (a.stage === 2) {
        card.append(el("p", "muted ab-item-meta", "Aucun validateur de clinique : votre visa conclut la demande."));
      }
      const w = warnBox(a.conflicts, "Attention : trop d'absences en même temps si vous validez");
      if (w) card.append(w);
      const wantKind = a.change_type === "modify" ? a.change_kind : a.kind, wantStart = a.change_type === "modify" ? a.change_start : a.start_date, wantEnd = a.change_type === "modify" ? a.change_end : a.end_date;
      if (a.change_type !== "delete" && (wantKind === "vacances" || wantKind === "congres")) {
        const slot = el("div");
        card.append(slot);
        sb.rpc("absence_balance_check", { p_user: a.user_id, p_kind: wantKind, p_start: wantStart, p_end: wantEnd, p_exclude: a.id }).then(({ data }) => {
          for (const x of data || []) {
            const bw = el("div", "ab-warn");
            bw.append(el("strong", null, `Solde ${wantKind === "vacances" ? "de vacances" : "de congrès et formation"} ${x.year} insuffisant`),
              el("p", null, `Cette absence compte ${x.needed} jour${x.needed > 1 ? "s" : ""} ouvrable${x.needed > 1 ? "s" : ""} ; reste avant : ${fmtD(x.remaining_before)} j, après : ${fmtD(x.remaining_after)} j. Ce n'est pas un motif de blocage.`));
            slot.append(bw);
          }
        });
      }
      const comment = el("input"); comment.type = "text"; comment.maxLength = 500; comment.placeholder = "Commentaire (obligatoire pour un refus)";
      const lab = el("label", "ab-comment", "Commentaire");
      lab.append(comment);
      const out = el("p", "form-msg"); out.setAttribute("role", "status");
      const decide = async (approve, b1, b2) => {
        if (!approve && comment.value.trim().length < 3) { comment.focus(); return say(out, "Un refus demande un commentaire.", "error"); }
        b1.disabled = b2.disabled = true;
        const { data: res, error } = await sb.rpc("absence_decide", { p_id: a.id, p_approve: approve, p_comment: comment.value.trim() });
        if (error) { b1.disabled = b2.disabled = false; return say(out, error.message, "error"); }
        mailer();
        say($("ab-todo-msg"), approve
          ? (res === "requested" ? `${a.name} : votre validation est enregistrée ; il reste des validateurs ou le visa de la direction.` : `${a.name} : accepté, l'usager est prévenu par e-mail.`)
          : `${a.name} : refusé, l'usager est prévenu par e-mail.`, "ok");
        await afterChange();
      };
      const actions = el("div", "btn-row");
      const yes = button(isChange ? "Accepter le changement" : a.stage === 2 ? "Viser (valider)" : "Valider", "btn", () => decide(true, yes, no));
      const no = button(isChange ? "Refuser le changement" : "Refuser", "btn btn-outline", () => decide(false, yes, no));
      actions.append(yes, no);
      card.append(lab, out, actions);
      list.append(card);
    }
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
  const ROLE_NAME = { clinician: "Médecin assistant", cdc: "CDC", cadre: "Médecin cadre", assistant: "Assistante médicale", pharmacist: "Pharmacien·ne", direction: "Admin de direction", admin: "Administrateur" };
  const xDT = (s) => (s ? DT_FMT.format(new Date(s)).replace(",", "") : "");
  const xDate = (s) => (s ? pd(s) : null);
  const FILL = { approved: "FFE3F1E4", requested: "FFFFF3D6", direction: "FFFCE4C8", rejected: "FFF9DADA", cancelled: "FFE6E8EC", change: "FFDDE8F7" };
  function statusLabel(r) {
    if (r.status === "approved") return r.change_type === "delete" ? "Validée, suppression demandée" : r.change_type === "modify" ? "Validée, modification demandée" : "Validée";
    if (r.status === "requested") return r.stage === 2 ? "En cours : visa de la direction" : "En cours : chez les validateurs";
    return r.status === "rejected" ? "Refusée" : r.status === "cancelled" ? "Annulée" : r.status;
  }
  const statusFill = (r) => (r.status === "approved" ? (r.change_type ? FILL.change : FILL.approved) : r.status === "requested" ? (r.stage === 2 ? FILL.direction : FILL.requested) : FILL[r.status]);
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
  async function runExport(kind) {
    const w = exportWindow();
    if (!w) return;
    const msg = $("ab-exp-msg");
    say(msg, "Préparation du fichier…");
    const [abs, dec] = await Promise.all([sb.rpc("absence_export", { p_from: w.from, p_to: w.to }), kind === "sum" ? sb.rpc("absence_decisions", { p_from: w.from, p_to: w.to }) : Promise.resolve({ data: [] })]);
    if (abs.error || dec.error) return say(msg, (abs.error || dec.error).message, "error");
    const rows = (abs.data || []).map((r) => Object.assign(r, { start_date: String(r.start_date).slice(0, 10), end_date: String(r.end_date).slice(0, 10) }));
    const decisions = (dec.data || []).map((r) => Object.assign(r, { start_date: String(r.start_date).slice(0, 10), end_date: String(r.end_date).slice(0, 10) }));
    try { await loadScript(EXCELJS, "ExcelJS"); } catch (e) { return say(msg, e.message, "error"); }
    const wb = new window.ExcelJS.Workbook();
    const stamp = `${w.from}_${w.to}`;
    if (kind === "abs") {
      const ws = wb.addWorksheet("Absences");
      ws.columns = ["Nom", "Rôle", "Cliniques", "Motif", "Précision", "Début", "Fin", "Jours ouvrables", "État", "Changement demandé", "Envoyée le", "Validée par (1re ligne)", "Visa de la direction", "Décision par", "Décision le", "Commentaire"].map((header) => ({ header }));
      for (const r of rows) {
        const chg = r.change_type === "delete" ? "Suppression" : r.change_type === "modify" ? `Modification : ${KINDS[r.change_kind] ? KINDS[r.change_kind][0] : r.change_kind}, ${period(String(r.change_start).slice(0, 10), String(r.change_end).slice(0, 10))}${r.change_note ? " (" + r.change_note + ")" : ""}` : "";
        const row = ws.addRow([r.name, ROLE_NAME[r.role] || r.role, (r.clinics || []).join(", "), KINDS[r.kind][0], r.note || "", xDate(r.start_date), xDate(r.end_date), workdays(r.start_date, r.end_date),
          statusLabel(r), chg, xDT(r.submitted_at), r.approvers || "", r.direction_name ? `${r.direction_name} (${xDT(r.direction_at)})` : "", r.decided_by_name || "", xDT(r.decided_at), r.decision_comment || ""]);
        row.getCell(6).numFmt = DATE_FMT; row.getCell(7).numFmt = DATE_FMT;
        row.eachCell((c) => { c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: statusFill(r) } }; });
      }
      styleSheet(ws, [26, 18, 24, 12, 28, 12, 12, 10, 32, 36, 18, 44, 36, 24, 18, 36]);
      const lg = wb.addWorksheet("Légende");
      lg.columns = [{ header: "Couleur", width: 14 }, { header: "État", width: 40 }];
      [["Validée", FILL.approved], ["En cours : chez les validateurs", FILL.requested], ["En cours : visa de la direction", FILL.direction], ["Validée, modification ou suppression demandée", FILL.change], ["Refusée", FILL.rejected], ["Annulée", FILL.cancelled]]
        .forEach(([t, c]) => { const r = lg.addRow(["", t]); r.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: c } }; });
      lg.getRow(1).font = { bold: true };
      lg.addRow([]); lg.addRow(["", `Fenêtre : du ${fmtCH(w.from)} au ${fmtCH(w.to)} (absences qui chevauchent la fenêtre). Les brouillons ne sont pas exportés. Jours ouvrables : lundi à vendredi, fériés vaudois déduits.`]);
      saveXlsx(await wb.xlsx.writeBuffer(), `absences_${stamp}.xlsx`);
      return say(msg, `${plur(rows.length, "absence exportée", "absences exportées")}.`, "ok");
    }
    // Synthèse par personne
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
    [...people.values()].sort((a, b) => a.name.localeCompare(b.name, "fr")).forEach((p) => {
      ws.addRow([p.name, ROLE_NAME[p.role] || p.role, (p.clinics || []).join(", "), p.ok, p.days.vacances + p.days.congres + p.days.autre, p.days.vacances, p.days.congres, p.days.autre, p.pending, p.changePending, p.rejected, p.cancelled, p.chOk, p.chKo]);
    });
    styleSheet(ws, [26, 18, 24, 12, 14, 10, 10, 10, 10, 16, 10, 10, 14, 14]);
    ws.addRow([]);
    ws.addRow([`Fenêtre : du ${fmtCH(w.from)} au ${fmtCH(w.to)}. Jours ouvrables comptés dans la fenêtre (week-ends et fériés vaudois exclus). Les refus sont tirés du journal des décisions : ceux d'avant la mise en service de l'export ne sont pas conservés au-delà des 14 jours de visibilité.`]);
    const wd = wb.addWorksheet("Décisions");
    wd.columns = ["Nom", "Décision", "Motif", "Précision", "Début", "Fin", "Décidée le", "Par", "Commentaire"].map((header) => ({ header }));
    for (const d of decisions) {
      const r = wd.addRow([d.name, DECISION_LABEL[d.decision] || d.decision, KINDS[d.kind] ? KINDS[d.kind][0] : d.kind, d.note || "", xDate(d.start_date), xDate(d.end_date), xDT(d.decided_at), d.decided_by_name || "", d.comment || ""]);
      r.getCell(5).numFmt = DATE_FMT; r.getCell(6).numFmt = DATE_FMT;
    }
    styleSheet(wd, [26, 20, 12, 28, 12, 12, 18, 24, 40]);
    saveXlsx(await wb.xlsx.writeBuffer(), `synthese-absences_${stamp}.xlsx`);
    say(msg, `Synthèse de ${plur(people.size, "personne", "personnes")}, ${plur(decisions.length, "décision", "décisions")}.`, "ok");
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
    for (const [id, kind] of [["ab-exp-abs", "abs"], ["ab-exp-sum", "sum"]]) {
      $(id).addEventListener("click", async (e) => {
        const b = e.currentTarget; b.disabled = true;
        try { await runExport(kind); } catch (err) { say($("ab-exp-msg"), "Export impossible : " + err.message, "error"); }
        b.disabled = false;
      });
    }
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
      if (!confirm(`Ajouter cette absence pour ${name} ? Elle est enregistrée sans validation ni formulaire PDF${who.value === state.ctx.me ? "" : ", et le membre est prévenu par e-mail"}.`)) return;
      const btn = ev.submitter || ev.target.querySelector("button[type=submit]");
      btn.disabled = true;
      const { data, error } = await sb.rpc("absence_direction_add", { p_user: who.value, p_kind: kind.value, p_note: note.value.trim(), p_start: start.value, p_end: end.value, p_confidential: kind.value === "autre" && conf.checked });
      btn.disabled = false;
      if (error) return say(msg, error.message, "error");
      say(msg, `Absence enregistrée pour ${name} (sans validation ni formulaire).`, "ok");
      const w = warnBox(data.conflicts, "Attention : trop d'absences en même temps");
      if (w) warn.append(w);
      for (const x of data.balance || []) {
        const bw = el("div", "ab-warn");
        bw.append(el("strong", null, `Attention : solde ${x.kind === "vacances" ? "de vacances" : "de congrès et formation"} ${x.year} insuffisant pour ${name}`),
          el("p", null, `Cette absence compte ${x.needed} jour${x.needed > 1 ? "s" : ""} ouvrable${x.needed > 1 ? "s" : ""} ; reste avant : ${fmtD(x.remaining_before)} j, après : ${fmtD(x.remaining_after)} j. L'absence est enregistrée : rien n'est bloqué.`));
        warn.append(bw);
      }
      note.value = ""; start.value = ""; end.value = ""; conf.checked = false;
      mailer();
      await Promise.all([afterChange(), loadBalances()]);
    });
    // Soldes
    const ysel = $("ab-bal-year");
    [BAL_YEAR - 1, BAL_YEAR, BAL_YEAR + 1, BAL_YEAR + 2].forEach((y) => { const o = el("option", null, String(y)); o.value = String(y); ysel.append(o); });
    ysel.value = String(BAL_YEAR);
    ysel.addEventListener("change", loadBalances);
    loadBalances();
  }

  async function loadBalances() {
    const year = Number($("ab-bal-year").value) || BAL_YEAR;
    const body = $("ab-bal-table").tBodies[0];
    const { data, error } = await sb.rpc("absence_balances_overview", { p_year: year });
    if (error) return say($("ab-bal-msg"), "Chargement impossible : " + error.message, "error");
    body.replaceChildren();
    let neg = 0;
    for (const r of data || []) {
      const tr = el("tr");
      const bad = Number(r.vac_remaining) < 0 || (!r.cong_unlimited && Number(r.cong_remaining) < 0);
      if (bad) { neg++; tr.className = "ab-bal-neg"; }
      tr.append(el("td", null, r.name + ((r.clinics || []).length ? " · " + r.clinics.join(", ") : "")));
      const vacTxt = `${r.vac_manual ? "saisi" : "droit " + fmtD(r.vac_allowance)} · posés ${fmtD(r.vac_used)} · reste `;
      const vTd = el("td", null, vacTxt); vTd.append(el("strong", Number(r.vac_remaining) < 0 ? "ab-bal-bad" : null, fmtD(r.vac_remaining)));
      const vIn = el("input"); vIn.type = "number"; vIn.step = "0.5"; vIn.min = "-100"; vIn.max = "200"; vIn.className = "ab-bal-in";
      vIn.placeholder = "défaut"; vIn.value = r.vac_baseline == null ? "" : String(r.vac_baseline);
      vIn.setAttribute("aria-label", `Vacances restantes inscrites, ${r.name}`);
      const cTd = el("td");
      const cIn = el("input"); cIn.type = "number"; cIn.step = "0.5"; cIn.min = "-100"; cIn.max = "200"; cIn.className = "ab-bal-in";
      cIn.placeholder = r.cong_unlimited ? "sans limite" : "défaut"; cIn.value = r.cong_baseline == null ? "" : String(r.cong_baseline);
      cIn.setAttribute("aria-label", `Congrès restants inscrits, ${r.name}`);
      cTd.append(r.cong_unlimited && !r.cong_manual ? `sans limite · posés ${fmtD(r.cong_used)}` : `${r.cong_manual ? "saisi" : "droit " + fmtD(r.cong_allowance)} · posés ${fmtD(r.cong_used)} · reste `);
      if (!(r.cong_unlimited && !r.cong_manual)) cTd.append(el("strong", Number(r.cong_remaining) < 0 ? "ab-bal-bad" : null, fmtD(r.cong_remaining)));
      const save = button("Enregistrer", "btn btn-outline ab-mini", async () => {
        save.disabled = true;
        const { error: e2 } = await sb.rpc("absence_balance_set", { p_user: r.user_id, p_year: year, p_vacation: vIn.value === "" ? null : Number(vIn.value), p_congress: cIn.value === "" ? null : Number(cIn.value) });
        save.disabled = false;
        if (e2) return say($("ab-bal-msg"), e2.message, "error");
        say($("ab-bal-msg"), `${r.name} : soldes ${year} enregistrés.`, "ok");
        await loadBalances();
      });
      tr.append(vTd, el("td"), cTd, el("td"), el("td"));
      tr.children[2].append(vIn); tr.children[4].append(cIn); tr.children[5].append(save);
      body.append(tr);
    }
    if (!body.children.length) { const tr = el("tr"); tr.append(el("td", "muted", "Aucun membre de l'institution CHUV.")); body.append(tr); }
    if (neg) say($("ab-bal-msg"), `${neg} membre${neg > 1 ? "s" : ""} avec un solde ${year} négatif (ligne en surbrillance). Rien n'est bloqué.`, "");
    else say($("ab-bal-msg"), "", "");
  }

  function setTab(name) {
    for (const t of ["plan", "mine", "todo", "dir", "exp"]) {
      const on = t === name;
      $("ab-t-" + t).setAttribute("aria-selected", String(on));
      $("ab-p-" + t).hidden = !on;
    }
    if (name === "plan") renderGrid();
    if (name === "todo") loadTodo();
    if (name === "mine") loadMine();
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
    $("ab-scope").addEventListener("change", (e) => { state.prefs.scope = e.target.value; savePrefs(); fillScope(); renderGrid(); if (!$("ab-pick").hidden) renderPicker(); });
    $("ab-rows").addEventListener("change", (e) => { state.prefs.rows = Number(e.target.value); savePrefs(); renderGrid(); });
    const shift = (n) => { const d = new Date(Date.UTC(state.month.y, state.month.m + n, 1)); state.month = { y: d.getUTCFullYear(), m: d.getUTCMonth() }; renderGrid(); };
    if (window.monthPicker) window.monthPicker($("ab-title"), { get: () => ({ y: state.month.y, m: state.month.m }), onPick: (y, m) => { state.month = { y, m }; renderGrid(); } });
    $("ab-prev").addEventListener("click", () => shift(-1));
    $("ab-next").addEventListener("click", () => shift(1));
    $("ab-today").addEventListener("click", () => { state.month = { y: t.getFullYear(), m: t.getMonth() }; renderGrid(); });
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
    $("ab-docx").addEventListener("click", exportDocx);
    // Popup d'envoi
    $("ab-drafts-open").addEventListener("click", () => openSend([]));
    $("sd-add-form").addEventListener("submit", addToSend);
    $("sd-start").addEventListener("change", () => { if (!$("sd-end").value || $("sd-end").value < $("sd-start").value) $("sd-end").value = $("sd-start").value; });
    $("sd-go").addEventListener("click", askConfirm);
    $("sd-back").addEventListener("click", () => { $("sd-confirm").hidden = true; $("sd-main").hidden = false; });
    $("sd-yes").addEventListener("click", doSend);
    for (const id of ["sd-close", "sd-done-close"]) $(id).addEventListener("click", () => $("sd").close());
    $("sd").addEventListener("close", () => loadDrafts());
    $("sd-start").min = $("sd-end").min = todayIso().slice(0, 4) + "-01-01";
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
      $("ab-t-dir").hidden = false;
      $("ab-t-dir").addEventListener("click", () => setTab("dir"));
      initDirection();
    }
    if (ctx.validates.length || state.isDir) {
      $("ab-t-todo").hidden = false;
      const who = $("ab-who");
      const me = el("option", null, "Moi"); me.value = ""; who.append(me);
      state.people.filter((p) => !p.is_me && (state.isDir || sharesClinic(p, ctx.validates))).forEach((p) => { const o = el("option", null, p.name); o.value = p.id; who.append(o); });
      who.addEventListener("change", () => { state.who = who.value; loadMine(); });
      $("ab-who-wrap").hidden = false;
      loadRejected();
    }
    await Promise.all([renderGrid(), loadMine(), loadDrafts(), refreshPending()]);
    if (location.hash === "#todo" && (ctx.validates.length || state.isDir)) setTab("todo");
    else if (location.hash === "#mine") setTab("mine");
  })();
})();
