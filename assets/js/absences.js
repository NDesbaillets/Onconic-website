// Absences : demandes (vacances, congrès, autre), planning mensuel, validation par les cadres, export Word.
// Toute la logique métier (droits, chevauchements, statuts) est en base (supabase/absences.sql) ; cette page affiche et appelle les fonctions.
(function () {
  const cfg = window.ONCONIC_CONFIG || {};
  const sb = window.supabase && cfg.supabaseUrl ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey) : null;
  const DOCX = "https://cdn.jsdelivr.net/npm/docx@9.5.1/dist/index.iife.js";
  const PREFS_KEY = "onconic.absences.v1";

  const MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
  const DOW = ["D", "L", "M", "M", "J", "V", "S"];
  const KINDS = { vacances: ["Vacances", "V"], congres: ["Congrès", "C"], autre: ["Autre", "A"] };
  const STATUS = { draft: "Brouillon (non envoyé)", requested: "En cours de validation", approved: "Validée", rejected: "Refusée", cancelled: "Annulée" };
  const DECISION = { approved: "Validée", rejected: "Refusée", change_approved: "Changement accepté", change_rejected: "Changement refusé" };

  const $ = (id) => document.getElementById(id);
  const state = {
    ctx: null, people: [], clinics: [], month: null, cache: new Map(), prefs: { scope: "mine", ids: [], rows: 20 },
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
    return list.sort((a, b) => (b.is_me - a.is_me) || a.name.localeCompare(b.name, "fr"));
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

  // Entrées de l'agenda commun pour un jour : férié vaudois (calculé), événements et vacances scolaires (saisis par l'admin)
  const CAL_LETTER = { ferie: "F", evenement: "É", vacances_scolaires: "S" };
  function calEntries(day, cal) {
    const out = [];
    const h = holidayOf(day);
    if (h) out.push({ kind: "ferie", label: h + " (férié vaudois)", start: day, end: day });
    cal.filter((c) => c.kind === "evenement" && c.start_date <= day && day <= c.end_date).forEach((c) => out.push({ kind: "evenement", label: c.label, start: c.start_date, end: c.end_date }));
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
      row.append(el("span", "ug-badge", { ferie: "Férié", evenement: "Événement", vacances_scolaires: "Vacances scolaires" }[x.kind]), document.createTextNode(" " + x.label + (x.kind === "ferie" ? "" : ` · ${period(x.start, x.end)}`)));
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
    await Promise.all([renderGrid(), loadMine(), loadDrafts(), refreshPending(), state.ctx.validates.length ? Promise.all([loadTodo(), loadRejected()]) : null]);
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
    const out = el("p", "form-msg");
    out.setAttribute("role", "status");
    const actions = el("div", "btn-row");
    const save = el("button", "btn", mode === "change" ? "Envoyer la demande de modification" : a.status === "rejected" ? "Renvoyer en validation" : "Enregistrer");
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
        : await sb.rpc("absence_update", Object.assign({ p_id: a.id }, args));
      if (error) { save.disabled = false; return say(out, error.message, "error"); }
      state.mineWarn = warnBox(data.conflicts, "Attention : trop d'absences en même temps");
      say($("ab-mine-msg"), mode === "change" ? "Demande de modification envoyée aux validateurs : l'absence reste validée aux anciennes dates jusqu'à leur décision (tous doivent l'accepter)." : "Demande modifiée : elle repasse en brouillon, envoyez-la pour relancer la validation.", "ok");
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

  function absenceCard(a, own) {
    const card = el("article", `card ab-item ab-item-${a.status}`);
    const head = el("div", "ab-item-head");
    head.append(el("strong", null, period(a.start_date, a.end_date)), el("span", "ug-badge", KINDS[a.kind][0]),
      el("span", `ug-badge ab-st ab-st-${a.status}`, STATUS[a.status]));
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
    if (!own) return card;
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
        card.append(el("p", "muted ab-item-meta", "L'absence n'est validée que lorsque tous les validateurs concernés ont validé ; un seul refus suffit à la refuser."));
      }
      const w = warnBox(a.conflicts, "Attention : trop d'absences en même temps si vous validez");
      if (w) card.append(w);
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
          ? (res === "requested" ? `${a.name} : votre validation est enregistrée ; il reste des validateurs à se prononcer.` : `${a.name} : accepté, l'usager est prévenu par e-mail.`)
          : `${a.name} : refusé, l'usager est prévenu par e-mail.`, "ok");
        await afterChange();
      };
      const actions = el("div", "btn-row");
      const yes = button(isChange ? "Accepter le changement" : "Valider", "btn", () => decide(true, yes, no));
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
      s.src = src; s.onload = ok; s.onerror = () => ko(new Error("Chargement de la bibliothèque Word impossible."));
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
  function setTab(name) {
    for (const t of ["plan", "mine", "todo"]) {
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
    if (error || !ctx) { $("ug-status").textContent = "Cet espace est réservé aux membres validés de The Hive."; return; }
    state.ctx = ctx;
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
        ? "Aucune clinique de rattachement n'est enregistrée pour vous : seul l'administrateur validera vos demandes. Demandez-lui de renseigner vos cliniques."
        : "", "");
    }

    // Planning
    fillScope();
    $("ab-rows").value = String(state.prefs.rows);
    $("ab-scope").addEventListener("change", (e) => { state.prefs.scope = e.target.value; savePrefs(); fillScope(); renderGrid(); if (!$("ab-pick").hidden) renderPicker(); });
    $("ab-rows").addEventListener("change", (e) => { state.prefs.rows = Number(e.target.value); savePrefs(); renderGrid(); });
    const shift = (n) => { const d = new Date(Date.UTC(state.month.y, state.month.m + n, 1)); state.month = { y: d.getUTCFullYear(), m: d.getUTCMonth() }; renderGrid(); };
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
    if (ctx.validates.length) {
      $("ab-t-todo").hidden = false;
      const who = $("ab-who");
      const me = el("option", null, "Moi"); me.value = ""; who.append(me);
      state.people.filter((p) => !p.is_me && (ctx.role === "admin" || sharesClinic(p, ctx.validates))).forEach((p) => { const o = el("option", null, p.name); o.value = p.id; who.append(o); });
      who.addEventListener("change", () => { state.who = who.value; loadMine(); });
      $("ab-who-wrap").hidden = false;
      loadRejected();
    }
    await Promise.all([renderGrid(), loadMine(), loadDrafts(), refreshPending()]);
    if (location.hash === "#todo" && ctx.validates.length) setTab("todo");
    else if (location.hash === "#mine") setTab("mine");
  })();
})();
