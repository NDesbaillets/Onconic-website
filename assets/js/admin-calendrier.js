// Administration du calendrier des fériés et événements (agenda commun du planning des absences).
// Réservé à l'administration et à la direction (contrôlé aussi en base, is_direction_admin()). Rendu par createElement/textContent.
(function () {
  const cfg = window.ONCONIC_CONFIG || {};
  const sb = window.supabase && cfg.supabaseUrl ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey) : null;
  const VD = window.OnconicHolidays;
  const $ = (id) => document.getElementById(id);
  const state = { entries: [], year: new Date().getFullYear(), editing: null, pending: null };

  const KIND = { ferie: "Férié ajouté", presence_obligatoire: "Présence obligatoire", evenement: "Événement", vacances_scolaires: "Vacances scolaires", calc: "Férié vaudois (calculé)" };
  const HELP = {
    ferie: "Férié : déduit des jours ouvrables de tout le monde, y compris des absences déjà déposées (1 à 31 jours).",
    presence_obligatoire: "Présence obligatoire : avertissement non bloquant à la demande d'absence.",
    evenement: "Événement important : affiché dans le planning, sans effet sur les jours ouvrables.",
    vacances_scolaires: "Vacances scolaires : affichées dans le planning, sans effet sur les jours ouvrables."
  };
  const ACTION = { create: "Ajout", update: "Modification", delete: "Suppression", confirm: "Confirmation" };

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
  const day = (d) => String(d).slice(0, 10);
  const fmtCH = (d) => day(d).split("-").reverse().join(".");
  const period = (a, b) => (day(a) === day(b) ? fmtCH(a) : `${fmtCH(a)} – ${fmtCH(b)}`);
  function say(text, kind) { const m = $("ac-msg"); m.className = "form-msg" + (kind ? " " + kind : ""); m.textContent = text; }
  const errText = (e) => (e && e.message ? e.message : "erreur inconnue");

  // ----- Liste de l'année : entrées manuelles et importées, plus fériés vaudois calculés (lecture seule) -----
  function visibleRows() {
    const y = state.year, ys = `${y}-01-01`, ye = `${y}-12-31`;
    const kind = $("ac-filter-kind").value, q = norm($("ac-q").value.trim());
    const rows = state.entries.filter((c) => day(c.start_date) <= ye && day(c.end_date) >= ys).map((c) => ({ calc: false, c, start: day(c.start_date), label: c.label, kind: c.kind }));
    VD.list(y).forEach((h) => rows.push({ calc: true, start: h.date, end: h.date, label: h.label, kind: "calc" }));
    return rows
      .filter((r) => (!kind || r.kind === kind) && (!q || norm(r.label + " " + KIND[r.kind]).includes(q)))
      .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.calc === b.calc ? 0 : a.calc ? 1 : -1));
  }
  function renderList() {
    const list = $("ac-list");
    list.replaceChildren();
    $("ac-year").value = state.year;
    $("ac-list-title").textContent = `Entrées de ${state.year}`;
    const rows = visibleRows();
    if (!rows.length) list.append(el("p", "muted", "Aucune entrée pour ces critères."));
    for (const r of rows) {
      const item = el("div", "ac-item" + (r.calc ? " ac-calc" : "") + (!r.calc && state.editing === r.c.id ? " ac-editing" : ""));
      if (r.calc) {
        item.dataset.calc = r.start;
        item.append(el("span", "ac-when", fmtCH(r.start)), el("span", "ug-badge", KIND.calc), el("span", "ac-label", r.label));
        list.append(item);
        continue;
      }
      const c = r.c;
      item.dataset.id = c.id;
      item.append(el("span", "ac-when", period(c.start_date, c.end_date)), el("span", "ug-badge", KIND[c.kind] || c.kind), el("span", "ac-label", c.label));
      if (c.source === "openholidays") item.append(el("span", "ug-badge" + (c.to_confirm ? " ug-warn" : ""), c.to_confirm ? "Importé, à confirmer" : "Importé, confirmé"));
      item.append(button("Modifier", "btn btn-outline ac-edit", () => startEdit(c)));
      if (c.to_confirm) item.append(button("Confirmer", "btn ac-confirm-btn", () => confirmEntry(c)));
      item.append(button("Supprimer", "btn btn-outline lt-danger ac-del", () => askDelete(c)));
      const by = [];
      if (c.created_by_name) by.push(`Ajouté par ${c.created_by_name}`);
      if (c.updated_by_name && c.updated_at) by.push(`modifié par ${c.updated_by_name} le ${fmtCH(c.updated_at)}`);
      if (by.length) item.append(el("p", "muted ac-by", by.join(", ")));
      list.append(item);
    }
  }

  // ----- Chargement -----
  async function loadEntries() {
    const { data, error } = await sb.rpc("admin_calendar_list");
    if (error) { say("Chargement impossible : " + errText(error), "error"); return; }
    state.entries = data || [];
    renderList();
  }
  async function loadLog() {
    const box = $("ac-log");
    const { data, error } = await sb.rpc("admin_calendar_log_list", { p_limit: 30 });
    box.replaceChildren();
    if (error) { box.append(el("p", "muted", "Journal indisponible.")); return; }
    if (!(data || []).length) box.append(el("p", "muted", "Aucune modification enregistrée."));
    for (const l of data || []) {
      box.append(el("p", "ac-log-item", `${new Date(l.at).toLocaleString("fr-CH")} · ${l.actor_name || "compte supprimé"} · ${ACTION[l.action] || l.action} · ${KIND[l.kind] || l.kind} « ${l.label} » · ${period(l.start_date, l.end_date)}`));
    }
  }
  async function reload() { await Promise.all([loadEntries(), loadLog(), loadSync()]); }

  // Import des vacances scolaires (OpenHolidays) : état du dernier import, écarts à vérifier, import à la demande
  async function loadSync() {
    const box = $("ac-sync");
    const { data } = await sb.rpc("admin_calendar_sync_status");
    box.replaceChildren();
    const r = data && data.result;
    box.append(el("p", null, data && data.last_run
      ? `Dernier import des vacances scolaires : ${new Date(data.last_run).toLocaleString("fr-CH")} · ${r.ajoutees} ajoutée(s), ${r.mises_a_jour} mise(s) à jour, ${r.identiques} identique(s).`
      : "Aucun import des vacances scolaires pour l'instant."));
    for (const g of (r && r.ecarts) || []) {
      box.append(el("p", "form-msg error", `Écart à vérifier : « ${g.label} » saisi du ${fmtCH(g.saisi[0])} au ${fmtCH(g.saisi[1])}, OpenHolidays indique du ${fmtCH(g.source[0])} au ${fmtCH(g.source[1])}.`));
    }
    const go = button("Importer maintenant", "btn btn-outline", async () => {
      go.disabled = true; say("Import en cours…");
      const { error } = await sb.functions.invoke("holidays-sync", { body: {} });
      go.disabled = false;
      if (error) {
        let m = error.message;
        try { const b = await error.context.json(); if (b && b.error) m = b.error; } catch (x) { /* message générique */ }
        say("Import impossible : " + m, "error");
      } else say("Import terminé.", "ok");
      await reload();
    });
    box.append(go);
  }

  // ----- Confirmation avant une modification qui change des jours ouvrables -----
  function closeConfirm() { const b = $("ac-confirm"); b.hidden = true; b.replaceChildren(); state.pending = null; }
  function ask(lines, okLabel, onOk) {
    const b = $("ac-confirm");
    b.replaceChildren(...lines.map((t) => el("p", null, t)));
    const row = el("div", "btn-row");
    const ok = button(okLabel, "btn", async () => { ok.disabled = true; try { await onOk(); } finally { closeConfirm(); } });
    row.append(ok, button("Annuler", "btn btn-outline", () => { closeConfirm(); say(""); }));
    b.append(row);
    b.hidden = false;
    ok.focus();
  }
  async function impact(start, end, excludeId) {
    const { data, error } = await sb.rpc("admin_calendar_impact", { p_start: start, p_end: end, p_exclude_id: excludeId || null });
    if (error) throw error;
    return Number(data) || 0;
  }
  const impactText = (n) => `Cette modification change le nombre de jours ouvrables de ${n} absence(s) déjà déposée(s).`;

  // ----- Formulaire : ajout et modification -----
  function help() { $("ac-help").textContent = HELP[$("ac-kind").value] || ""; }
  function resetForm() {
    state.editing = null;
    $("ac-form").reset();
    $("ac-form-title").textContent = "Ajouter une entrée";
    $("ac-save").textContent = "Ajouter";
    $("ac-cancel").hidden = true;
    help();
    renderList();
  }
  function startEdit(c) {
    closeConfirm();
    state.editing = c.id;
    $("ac-kind").value = c.kind;
    $("ac-label").value = c.label;
    $("ac-start").value = day(c.start_date);
    $("ac-end").value = day(c.end_date);
    $("ac-form-title").textContent = "Modifier l'entrée";
    $("ac-save").textContent = "Enregistrer la modification";
    $("ac-cancel").hidden = false;
    help();
    say("");
    renderList();
    $("ac-form").scrollIntoView({ block: "center" });
    $("ac-label").focus({ preventScroll: true });
  }
  async function doSave(p) {
    const { error } = await sb.rpc("admin_calendar_save", { p_id: p.id, p_kind: p.kind, p_label: p.label, p_start: p.start, p_end: p.end });
    if (error) return say("Refusé : " + errText(error), "error");
    say(p.id ? "Entrée modifiée." : "Entrée ajoutée.", "ok");
    state.year = Number(p.start.slice(0, 4)) || state.year;
    resetForm();
    await reload();
  }
  async function submit(ev) {
    ev.preventDefault();
    closeConfirm();
    const p = { id: state.editing, kind: $("ac-kind").value, label: $("ac-label").value.trim(), start: $("ac-start").value, end: $("ac-end").value };
    if (p.label.length < 2 || p.label.length > 120) return say("L'intitulé compte de 2 à 120 caractères.", "error");
    if (!p.start || !p.end || p.end < p.start) return say("Vérifiez les dates : la fin doit être le même jour ou après le début.", "error");
    // Les jours ouvrables ne changent que si un férié est ajouté, retiré, déplacé ou si son type change : un simple changement d'intitulé
    // n'appelle aucune confirmation. L'entrée modifiée est ignorée par le contrôle (p_exclude_id) pour simuler son retrait.
    const old = state.editing ? state.entries.find((c) => c.id === state.editing) : null;
    const wasFerie = !!old && old.kind === "ferie", isFerie = p.kind === "ferie";
    const sameDays = wasFerie && isFerie && day(old.start_date) === p.start && day(old.end_date) === p.end;
    const ranges = [];
    if (isFerie && !sameDays) ranges.push([p.start, p.end]);
    if (wasFerie && !sameDays) ranges.push([day(old.start_date), day(old.end_date)]);
    if (!ranges.length) return doSave(p);
    const from = ranges.map((r) => r[0]).sort()[0], to = ranges.map((r) => r[1]).sort().reverse()[0];
    let n;
    try { n = await impact(from, to, state.editing); } catch (e) { return say("Contrôle d'impact impossible : " + errText(e), "error"); }
    if (!n) return doSave(p);
    say("");
    ask([impactText(n), "Les jours ouvrables des absences concernées sont recalculés pour tout le monde. Enregistrer quand même ?"], "Enregistrer", () => doSave(p));
  }

  // ----- Confirmation d'une période importée, suppression -----
  async function confirmEntry(c) {
    const { error } = await sb.rpc("admin_calendar_confirm", { p_id: c.id });
    if (error) return say("Refusé : " + errText(error), "error");
    say("Période confirmée.", "ok");
    await reload();
  }
  async function askDelete(c) {
    closeConfirm();
    const lines = [`Supprimer « ${c.label} » (${period(c.start_date, c.end_date)}) ?`];
    if (c.kind === "ferie") {
      let n;
      try { n = await impact(day(c.start_date), day(c.end_date), c.id); } catch (e) { return say("Contrôle d'impact impossible : " + errText(e), "error"); }
      if (n) lines.unshift(impactText(n));
    }
    say("");
    ask(lines, "Supprimer", async () => {
      const { error } = await sb.rpc("admin_calendar_delete", { p_id: c.id });
      if (error) return say("Refusé : " + errText(error), "error");
      if (state.editing === c.id) resetForm();
      say("Entrée supprimée.", "ok");
      await reload();
    });
  }

  function init() {
    $("ac-form").addEventListener("submit", submit);
    $("ac-cancel").addEventListener("click", () => { closeConfirm(); say(""); resetForm(); });
    $("ac-kind").addEventListener("change", help);
    $("ac-start").addEventListener("change", () => { if (!$("ac-end").value || $("ac-end").value < $("ac-start").value) $("ac-end").value = $("ac-start").value; });
    const setYear = (y) => { if (y >= 2000 && y <= 2100) { state.year = y; renderList(); } };
    $("ac-prev").addEventListener("click", () => setYear(state.year - 1));
    $("ac-next").addEventListener("click", () => setYear(state.year + 1));
    $("ac-year").addEventListener("change", () => { const y = Number($("ac-year").value); if (y >= 2000 && y <= 2100) setYear(y); else $("ac-year").value = state.year; });
    $("ac-filter-kind").addEventListener("change", renderList);
    $("ac-q").addEventListener("input", renderList);
    help();
    return reload();
  }

  (async () => {
    if (!sb) return ($("ug-status").textContent = "Service indisponible.");
    const { data } = await sb.auth.getSession();
    if (!data.session) return (location.href = "/fr/the-hive.html");
    $("logout").addEventListener("click", async () => { await sb.auth.signOut(); location.href = "/fr/"; });
    const { data: role } = await sb.rpc("current_role_name");
    if (role !== "admin" && role !== "direction") return ($("ug-status").textContent = "Page réservée à l'administration.");
    $("ug-status").hidden = true;
    $("ac-tool").hidden = false;
    await init();
  })();
})();
