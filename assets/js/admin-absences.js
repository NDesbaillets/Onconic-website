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

  async function notifications() {
    let box = $("aa-notifications");
    if (!box) { box = el("section", "card"); box.id = "aa-notifications"; $("aa-tool").prepend(box); }
    box.replaceChildren(el("h2", null, "Suivi des notifications"));
    const [status, failures, health] = await Promise.all([sb.rpc("absence_notification_status"), sb.rpc("absence_notification_failures"), sb.rpc("absence_worker_health")]);
    if (status.error || failures.error || health.error) { box.append(el("p", "form-msg error", "Suivi indisponible : vérifiez la migration du module Absences.")); return; }
    const s = status.data;
    box.append(el("p", null, `${s.pending} en attente · ${s.failed} en échec · ${s.sent} remises au serveur d’envoi.`));
    if (!health.data.scheduled || !health.data.configured) box.append(el("p", "form-msg error", "L’envoi automatique n’est pas configuré. Les notifications dépendent encore des actions dans l’application."));
    for (const row of failures.data || []) {
      const line = el("p", null, `Notification ${row.id} · ${{ to_validate: "Demande à valider", to_validate_change: "Changement à valider", to_direction: "Visa de la direction", to_opinion: "Pré-avis ou avis", peer_rejected: "Refus signalé aux autres validateurs", approved: "Acceptation", rejected: "Refus", change_approved: "Changement accepté", change_rejected: "Changement refusé", direction_change: "Saisie de la direction", form: "Formulaire PDF", form_copy: "Diffusion du formulaire", on_behalf: "Saisie par une secrétaire", agenda_done: "Ultragenda à jour", escalated: "Envoi à la cheffe de service" }[row.kind] || "Absence"} · ${row.attempts} tentatives. `);
      const retry = el("button", "btn btn-outline", "Réessayer"); retry.type = "button";
      retry.addEventListener("click", async () => {
        retry.disabled = true;
        const { error } = await sb.rpc("absence_notification_retry", { p_id: row.id });
        if (error) { retry.disabled = false; return say(error.message, "error"); }
        await notifications();
      }); line.append(retry); box.append(line);
    }
    const refresh = el("button", "btn btn-outline", "Actualiser"); refresh.type = "button"; refresh.addEventListener("click", notifications); box.append(refresh);
  }

  async function load() {
    const { data, error } = await sb.rpc("admin_absence_config");
    if (error) throw error;
    state.clinics = data.clinics || [];
    state.cadres = data.cadres || [];
    state.sans = Number(data.cadres_sans_validation) || 0;
  }

  // Tri des cadres (module name-sort.js) : nom de famille par défaut, choix mémorisé
  const SORT_MODES = ["family", "first"];
  const sortedCadres = () => (window.OnconicSort
    ? window.OnconicSort.sortPeople(state.cadres, { mode: window.OnconicSort.getMode("admin-validateurs", SORT_MODES) })
    : state.cadres);
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
    for (const cadre of sortedCadres()) {
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
      lab.append(cb, el("span", null, cadre.name + (cadre.role === "direction" ? " (direction)" : "")));
      fs.append(lab);
    }
    root.append(fs);
    const note = el("p", "muted am-note", "Aucun valideur désigné : les demandes de cette clinique vont aux administrateurs.");
    note.hidden = chosen.size > 0;
    root.append(note);
    return root;
  }

  (async () => {
    if (!sb) return ($("ug-status").textContent = "Service indisponible.");
    const { data } = await sb.auth.getSession();
    if (!data.session) return (location.href = "/fr/the-hive.html");
    $("logout").addEventListener("click", async () => { await sb.auth.signOut(); location.href = "/fr/"; });
    const { data: role } = await sb.rpc("current_role_name");
    if (role !== "admin" && role !== "direction") return ($("ug-status").textContent = "Page réservée à l'administration.");
    try { await load(); } catch (e) { return ($("ug-status").textContent = "Chargement impossible : " + e.message); }
    $("ug-status").hidden = true;
    $("aa-tool").hidden = false;
    const drawList = () => $("aa-list").replaceChildren(...state.clinics.map(card));
    if (window.OnconicSort && $("aa-sort-slot")) $("aa-sort-slot").replaceChildren(window.OnconicSort.control("admin-validateurs", { modes: SORT_MODES, onChange: drawList }));
    drawList();
    await notifications();
  })();
})();
