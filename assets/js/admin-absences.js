// Administration des absences : cadres valideurs et seuil d'absents simultanés, par clinique. Réservé aux admins (contrôlé aussi en base).
(function () {
  const cfg = window.ONCONIC_CONFIG || {};
  const sb = window.supabase && cfg.supabaseUrl ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey) : null;
  const $ = (id) => document.getElementById(id);
  const state = { clinics: [], cadres: [], sans: 0 };

  function el(tag, cls, txt) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }
  function say(text, kind) { const m = $("aa-msg"); m.className = "form-msg" + (kind ? " " + kind : ""); m.textContent = text; }
  const plur = (n, one, many) => `${n} ${n > 1 ? many : one}`;

  async function load() {
    const { data, error } = await sb.rpc("admin_absence_config");
    if (error) throw error;
    state.clinics = data.clinics || [];
    state.cadres = data.cadres || [];
    state.sans = Number(data.cadres_sans_validation) || 0;
  }

  function card(c) {
    const root = el("article", "card aa-card");
    const head = el("div", "aa-head");
    const title = el("div");
    title.append(el("h3", null, c.clinic), el("p", "muted am-meta", plur(c.members, "membre rattaché", "membres rattachés")));
    head.append(title);

    const max = el("label", "aa-max", "Absents simultanés au maximum");
    const input = el("input");
    input.type = "number"; input.min = "1"; input.max = "50"; input.value = c.max_absent;
    input.addEventListener("change", async () => {
      const n = Number(input.value);
      const { error } = await sb.rpc("admin_set_absence_threshold", { p_clinic: c.clinic, p_max: n });
      if (error) { input.value = c.max_absent; return say("Refusé : " + error.message, "error"); }
      c.max_absent = n;
      say(`${c.clinic} : avertissement au-delà de ${plur(n, "absent", "absents")} en même temps.`, "ok");
    });
    max.append(input);
    head.append(max);
    root.append(head);

    const fs = el("fieldset", "aa-cadres");
    fs.append(el("legend", null, "Cadres qui valident les absences de cette clinique"));
    const chosen = new Set(c.validators || []);
    if (!state.cadres.length) {
      fs.append(el("p", "muted", state.sans
        ? "Aucun médecin cadre n'est validateur des absences. Cochez « Validateur des absences » sur sa fiche dans « Membres et accès »."
        : "Aucun membre n'a encore le rôle Médecin cadre. Attribuez-le dans « Membres et accès »."));
    }
    for (const cadre of state.cadres) {
      const lab = el("label", "cg-check am-tool");
      const cb = el("input");
      cb.type = "checkbox"; cb.checked = chosen.has(cadre.id);
      cb.addEventListener("change", async () => {
        cb.disabled = true;
        const next = new Set(chosen);
        cb.checked ? next.add(cadre.id) : next.delete(cadre.id);
        const { data, error } = await sb.rpc("admin_set_absence_validators", { p_clinic: c.clinic, p_users: [...next] });
        cb.disabled = false;
        if (error) { cb.checked = !cb.checked; return say("Refusé : " + error.message, "error"); }
        chosen.clear(); (data || []).forEach((id) => chosen.add(id));
        c.validators = [...chosen];
        say(`${c.clinic} : ${chosen.size ? plur(chosen.size, "valideur désigné", "valideurs désignés") : "aucun valideur (les administrateurs décident)"}.`, "ok");
        note.hidden = chosen.size > 0;
      });
      lab.append(cb, el("span", null, cadre.name));
      fs.append(lab);
    }
    root.append(fs);
    const note = el("p", "muted am-note", "Aucun valideur désigné : les demandes de cette clinique vont aux administrateurs.");
    note.hidden = chosen.size > 0;
    root.append(note);
    return root;
  }

  // ----- Agenda commun : vacances scolaires et événements importants -----
  const CAL_KIND = { vacances_scolaires: "Vacances scolaires", evenement: "Événement" };
  const fmtCH = (d) => String(d).slice(0, 10).split("-").reverse().join(".");
  function calSay(text, kind) { const m = $("aa-cal-msg"); m.className = "form-msg" + (kind ? " " + kind : ""); m.textContent = text; }
  // Import des vacances scolaires (OpenHolidays) : état du dernier import, écarts à vérifier, import à la demande
  async function loadSync() {
    const box = $("aa-sync");
    const { data } = await sb.rpc("admin_calendar_sync_status");
    box.replaceChildren();
    const r = data && data.result;
    box.append(el("p", null, data && data.last_run
      ? `Dernier import des vacances scolaires : ${new Date(data.last_run).toLocaleString("fr-CH")} · ${r.ajoutees} ajoutée(s), ${r.mises_a_jour} mise(s) à jour, ${r.identiques} identique(s).`
      : "Aucun import des vacances scolaires pour l'instant."));
    for (const g of (r && r.ecarts) || []) {
      box.append(el("p", "form-msg error", `Écart à vérifier : « ${g.label} » saisi du ${fmtCH(g.saisi[0])} au ${fmtCH(g.saisi[1])}, OpenHolidays indique du ${fmtCH(g.source[0])} au ${fmtCH(g.source[1])}.`));
    }
    const go = el("button", "btn btn-outline", "Importer maintenant");
    go.type = "button";
    go.addEventListener("click", async () => {
      go.disabled = true; calSay("Import en cours…");
      const { error } = await sb.functions.invoke("holidays-sync", { body: {} });
      go.disabled = false;
      if (error) {
        let m = error.message;
        try { const b = await error.context.json(); if (b && b.error) m = b.error; } catch (x) { /* message générique */ }
        calSay("Import impossible : " + m, "error");
      } else calSay("Import terminé.", "ok");
      await loadCal();
    });
    box.append(go);
  }
  async function loadCal() {
    loadSync();
    const { data, error } = await sb.rpc("admin_calendar_list");
    if (error) return calSay("Chargement impossible : " + error.message, "error");
    const list = $("aa-cal-list");
    list.replaceChildren();
    if (!(data || []).length) list.append(el("p", "muted", "Aucune entrée."));
    for (const c of data || []) {
      const row = el("div", "aa-cal-item");
      const a = fmtCH(c.start_date), b = fmtCH(c.end_date);
      row.append(el("span", "aa-cal-when", a === b ? a : `${a} – ${b}`), el("span", "ug-badge", CAL_KIND[c.kind]), el("span", "aa-cal-label", c.label));
      if (c.source === "openholidays") row.append(el("span", "ug-badge" + (c.to_confirm ? " ug-warn" : ""), c.to_confirm ? "Importé, à confirmer" : "Importé, confirmé"));
      if (c.to_confirm) {
        const ok = el("button", "btn", "Confirmer");
        ok.type = "button";
        ok.addEventListener("click", async () => {
          const { error: e3 } = await sb.rpc("admin_calendar_confirm", { p_id: c.id });
          if (e3) return calSay("Refusé : " + e3.message, "error");
          calSay("Période confirmée.", "ok");
          await loadCal();
        });
        row.append(ok);
      }
      const del = el("button", "btn btn-outline lt-danger", "Supprimer");
      del.type = "button";
      del.addEventListener("click", async () => {
        if (!confirm(`Supprimer « ${c.label} » ?`)) return;
        const { error: e2 } = await sb.rpc("admin_calendar_delete", { p_id: c.id });
        if (e2) return calSay("Refusé : " + e2.message, "error");
        calSay("Entrée supprimée.", "ok");
        await loadCal();
      });
      row.append(del);
      list.append(row);
    }
  }
  function initCal() {
    $("aa-cal-start").addEventListener("change", () => { if (!$("aa-cal-end").value || $("aa-cal-end").value < $("aa-cal-start").value) $("aa-cal-end").value = $("aa-cal-start").value; });
    $("aa-cal-form").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const { error } = await sb.rpc("admin_calendar_save", { p_id: null, p_kind: $("aa-cal-kind").value, p_label: $("aa-cal-label").value, p_start: $("aa-cal-start").value || null, p_end: $("aa-cal-end").value || null });
      if (error) return calSay("Refusé : " + error.message, "error");
      calSay("Entrée ajoutée.", "ok");
      $("aa-cal-label").value = "";
      await loadCal();
    });
    return loadCal();
  }

  (async () => {
    if (!sb) return ($("ug-status").textContent = "Service indisponible.");
    const { data } = await sb.auth.getSession();
    if (!data.session) return (location.href = "/fr/the-hive.html");
    $("logout").addEventListener("click", async () => { await sb.auth.signOut(); location.href = "/fr/"; });
    const { data: role } = await sb.rpc("current_role_name");
    if (role !== "admin") return ($("ug-status").textContent = "Page réservée à l'administrateur.");
    try { await load(); } catch (e) { return ($("ug-status").textContent = "Chargement impossible : " + e.message); }
    $("ug-status").hidden = true;
    $("aa-tool").hidden = false;
    $("aa-list").replaceChildren(...state.clinics.map(card));
    await initCal();
  })();
})();
