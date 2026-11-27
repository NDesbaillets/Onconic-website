// Administration des membres : liste, rôle et accès par outil. Réservé aux admins (contrôlé aussi en base).
(function () {
  const cfg = window.ONCONIC_CONFIG || {};
  const sb = window.supabase && cfg.supabaseUrl ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey) : null;
  const $ = (id) => document.getElementById(id);

  const ROLES = [["member", "En attente de validation"], ["clinician", "Médecin assistant"], ["cdc", "CDC (chef·fe de clinique)"], ["cadre", "Médecin cadre"], ["assistant", "Assistante médicale"], ["nurse", "Infirmier·ère"],
    ["pharmacist", "Pharmacien·ne"], ["direction", "Admin de direction"], ["admin", "Administrateur"]];
  const ROLE_LABEL = Object.fromEntries(ROLES);
  const TOOLS = [["congres", "Congrès"], ["trials", "Key trials"], ["lettres", "Lettres d'assurance"],
    ["limitations", "Limitations LS"], ["duree", "Durée de traitement"], ["absences", "Absences"], ["medletters", "Lettres médicales"]];
  const CLINICS = ["Sénologie", "Gynécologie", "Urologie", "Thoracique", "Neuro-oncologie", "Mélanome", "GI tube", "GI solide", "ORL", "Sarcomes", "Rad-Inter", "ION", "UTOH", "Hématologie", "Tournus / Autre"];
  const ABS_CLINICS = CLINICS.concat(["Plateforme"]); // cliniques de rattachement pour les absences (Key trials garde CLINICS)
  const state = { blocs: [], rows: [], me: null, role: null, changes: new Map(), sel: null };
  const desktop = () => window.matchMedia("(min-width: 1100px)").matches;
  const RESERVED = ["admin", "direction"]; // seul un administrateur donne ou retire ces rôles

  const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  function el(tag, cls, txt) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }
  const fmt = (d) => (d ? new Date(d).toLocaleDateString("fr-CH") : "jamais");
  function say(text, kind) { const m = $("am-msg"); m.className = "form-msg" + (kind ? " " + kind : ""); m.textContent = text; }
  const todayIso = () => { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
  const fmtD = (s) => (s ? s.slice(8, 10) + "." + s.slice(5, 7) + "." + s.slice(0, 4) : "");
  const nameOf = (r) => [r.first_name, r.last_name].filter(Boolean).join(" ") || r.full_name || "(sans nom)";

  async function load() {
    const [{ data, error }, chRes, exRes, blRes] = await Promise.all([sb.rpc("admin_members"), sb.rpc("admin_clinic_changes"), sb.rpc("admin_members_extra"), sb.rpc("admin_blocs_list")]);
    state.blocs = (blRes && blRes.data && blRes.data.blocs) || [];
    // Changements de cliniques programmés, par membre
    state.changes = new Map();
    for (const x of (chRes && chRes.data) || []) {
      if (!state.changes.has(x.user_id)) state.changes.set(x.user_id, []);
      state.changes.get(x.user_id).push(x);
    }
    if (error) throw error;
    state.rows = data || [];
    // Cadre administratif et fin d'accès (comptes temporaires) ; absents si la migration n'est pas encore appliquée
    const extra = new Map(((exRes && exRes.data) || []).map((x) => [x.id, x]));
    for (const r of state.rows) Object.assign(r, extra.get(r.id) || {});
  }

  async function renderClinicRequests() {
    const box = $("am-clinic-requests"), det = $("am-requests");
    box.replaceChildren();
    const { data, error } = await sb.rpc("admin_clinic_requests");
    if (error) { det.hidden = false; $("am-requests-sum").textContent = "Demandes de changement de cliniques"; box.append(el("p", "form-msg error", "Chargement impossible : " + error.message)); return; }
    const list = data || [];
    $("am-requests-sum").textContent = `Demandes de changement de cliniques (${list.length})`;
    det.classList.toggle("has-pending", list.length > 0);
    det.open = list.length > 0;
    if (!list.length) box.append(el("p", "muted", "Aucune demande en attente."));
    for (const r of list) {
      const item = el("article", "card");
      item.append(el("h3", null, r.name), el("p", null, `Actuellement : ${r.current.join(", ") || "aucune"}. Demandé : ${r.clinics.join(", ") || "aucune"}.`));
      const label = el("label", null, "Commentaire (obligatoire pour refuser)");
      const comment = el("input"); comment.type = "text"; comment.maxLength = 500; label.append(comment); item.append(label);
      const actions = el("div", "btn-row"); const buttons = [];
      for (const approve of [true, false]) {
        const b = el("button", approve ? "btn" : "btn btn-outline", approve ? "Accepter" : "Refuser"); b.type = "button"; buttons.push(b);
        b.disabled = r.user_id === state.me;
        b.addEventListener("click", async () => {
          buttons.forEach((x) => { x.disabled = true; });
          try {
            const { error } = await sb.rpc("admin_clinic_request_decide", { p_id: r.id, p_approve: approve, p_comment: comment.value.trim() });
            if (error) { say(error.message, "error"); return; }
            say(approve ? "Changement accepté." : "Changement refusé.", "ok");
            await refresh();
          } catch (_) { say("Connexion interrompue. Réessayez.", "error"); }
          finally { buttons.forEach((x) => { x.disabled = r.user_id === state.me; }); }
        }); actions.append(b);
      }
      item.append(actions); box.append(item);
    }
  }

  // Les « en attente » restent en tête, le reste suit le tri choisi (nom de famille par défaut, module name-sort.js)
  const SORT_MODES = ["family", "first", "role", "clinic"];
  const ROLE_RANK = ["cadre", "cdc", "clinician", "pharmacist", "nurse", "assistant", "direction", "admin"];
  const S = () => window.OnconicSort;
  const personOf = (r) => ({ id: r.id, first: r.first_name, last: r.last_name, name: nameOf(r), role: r.role, clinics: r.clinics });
  const pendingFirst = (a, b) => (b.role === "member") - (a.role === "member")
    || (S() ? S().compareNames(personOf(a), personOf(b), S().getMode("membres", SORT_MODES), { roleOrder: ROLE_RANK }) : nameOf(a).localeCompare(nameOf(b), "fr"));
  function render() {
    const q = norm($("am-q").value);
    const role = $("am-role").value;
    const rows = state.rows.filter((r) => (!role || r.role === role)
      && (!q || norm([r.first_name, r.last_name, r.full_name, r.email].join(" ")).includes(q))).sort(pendingFirst);
    const pending = state.rows.filter((r) => r.role === "member").length;
    $("am-count").textContent = `${plur(rows.length, "membre affiché", "membres affichés")} sur ${state.rows.length}` + (pending ? ` · ${pending} en attente de validation` : "");
    const list = $("am-list");
    const top = list.scrollTop;
    list.replaceChildren(...rows.map(row));
    list.scrollTop = top;
    renderDetail();
  }
  function row(r) {
    const li = el("li");
    const b = el("button", "am-row" + (r.role === "member" ? " am-pending" : "") + (r.id === state.sel ? " is-active" : ""));
    b.type = "button";
    b.dataset.id = r.id;
    if (r.id === state.sel) b.setAttribute("aria-current", "true");
    b.append(el("strong", "am-row-name", nameOf(r)));
    const meta = el("span", "am-row-meta");
    meta.append(el("span", "ug-badge" + (r.role === "member" ? " ug-warn" : ""), r.role === "member" ? "En attente" : ROLE_LABEL[r.role]));
    if (Object.values(r.tools || {}).some((x) => x.custom)) meta.append(el("span", "ug-badge am-exc", "exception"));
    if (r.role === "cadre" && r.absence_validator) meta.append(el("span", "ug-badge", "validateur"));
    if (r.role === "assistant" && r.admin_lead) meta.append(el("span", "ug-badge", "cadre admin"));
    if (r.role === "assistant" && r.agenda_manager) meta.append(el("span", "ug-badge", "agendas médecins"));
    if (r.role === "assistant" && r.cadre_secretary) meta.append(el("span", "ug-badge", "secrétaire de cadre"));
    if (r.access_until) meta.append(el("span", "ug-badge" + (r.access_until < todayIso() ? " ug-warn" : ""), (r.access_until < todayIso() ? "terminé " : "jusqu'au ") + fmtD(r.access_until)));
    b.append(meta);
    const sub = [r.email, (r.clinics || []).length ? r.clinics.join(", ") : ""].filter(Boolean).join(" · ");
    if (sub) b.append(el("span", "am-row-sub", sub));
    b.addEventListener("click", () => select(r.id));
    li.append(b);
    return li;
  }
  function select(id) {
    state.sel = id;
    document.querySelectorAll("#am-list .am-row").forEach((b) => {
      const on = b.dataset.id === id;
      b.classList.toggle("is-active", on);
      if (on) b.setAttribute("aria-current", "true"); else b.removeAttribute("aria-current");
    });
    renderDetail(true);
    try { history.replaceState(null, "", location.pathname + "#u=" + encodeURIComponent(id)); } catch (e) { /* ignoré */ }
  }
  function closeDetail() {
    state.sel = null;
    document.querySelectorAll("#am-list .am-row.is-active").forEach((b) => { b.classList.remove("is-active"); b.removeAttribute("aria-current"); });
    renderDetail();
    try { history.replaceState(null, "", location.pathname); } catch (e) { /* ignoré */ }
  }
  // Panneau de droite (ordinateur) ou vue plein écran (mobile) : la fiche du membre choisi, sinon une aide
  function renderDetail(reset) {
    const host = $("am-detail-body"), panel = $("am-detail");
    const r = state.rows.find((x) => x.id === state.sel);
    const top = panel.scrollTop;
    host.replaceChildren();
    $("am-split").classList.toggle("has-detail", !!r);
    $("am-tool").classList.toggle("is-detail", !!r);
    if (!r) {
      if (state.sel) state.sel = null;
      const empty = el("div", "am-empty");
      empty.append(el("p", "am-empty-title", "Sélectionnez un membre"), document.getElementById("am-help-tpl").content.cloneNode(true));
      host.append(empty);
      return;
    }
    host.append(card(r));
    panel.scrollTop = reset ? 0 : top;
    if (reset && !desktop()) $("am-split").scrollIntoView({ block: "start" });
  }

  // Changements de bloc programmés : « à partir du …, cliniques … ». Les absences qui tombent après cette date
  // sont validées par les cadres des nouvelles cliniques ; le changement devient les cliniques actuelles le jour venu.
  const eu = (d) => String(d).slice(0, 10).split("-").reverse().join(".");
  function plannedChanges(r) {
    const box = el("div", "am-changes");
    box.append(el("p", "am-changes-title", "Changements de cliniques programmés"));
    const list = state.changes.get(r.id) || [];
    if (!list.length) box.append(el("p", "muted am-note", "Aucun changement programmé."));
    for (const x of list) {
      const row = el("div", "am-change");
      row.append(el("span", null, `À partir du ${eu(x.valid_from)} : ${(x.clinics || []).length ? x.clinics.join(", ") : "aucune clinique"}`));
      const del = el("button", "btn btn-outline lt-danger", "Retirer");
      del.type = "button";
      del.addEventListener("click", async () => {
        if (!confirm(`Retirer le changement du ${eu(x.valid_from)} pour ${nameOf(r)} ?`)) return;
        const { error } = await sb.rpc("admin_clinic_change_delete", { p_user: r.id, p_from: String(x.valid_from).slice(0, 10) });
        if (error) return say("Refusé : " + error.message, "error");
        say(`${nameOf(r)} : changement du ${eu(x.valid_from)} retiré.`, "ok");
        await refresh();
      });
      row.append(del);
      box.append(row);
    }
    const add = el("details", "am-change-add");
    add.append(el("summary", null, "Programmer un changement de bloc"));
    const form = el("form", "am-change-form");
    form.noValidate = true;
    const dl = el("label", null, "À partir du");
    const date = el("input");
    date.type = "date"; date.required = true;
    const t = new Date(); t.setDate(t.getDate() + 1);
    date.min = t.toISOString().slice(0, 10);
    dl.append(date);
    const fs = el("fieldset", "am-tools am-clinics");
    fs.append(el("legend", null, "Nouvelles cliniques"));
    for (const cl of ABS_CLINICS) {
      const lab = el("label", "cg-check am-tool");
      const cb = el("input");
      cb.type = "checkbox"; cb.value = cl;
      lab.append(cb, el("span", null, cl));
      fs.append(lab);
    }
    const go = el("button", "btn", "Programmer");
    go.type = "submit";
    form.append(dl, fs, go);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!date.value) return say("Choisissez la date du changement.", "error");
      const chosen = [...fs.querySelectorAll("input:checked")].map((i) => i.value);
      const { error } = await sb.rpc("admin_clinic_change_save", { p_user: r.id, p_from: date.value, p_clinics: chosen });
      if (error) return say("Refusé : " + error.message, "error");
      say(`${nameOf(r)} : à partir du ${eu(date.value)}, ${chosen.length ? chosen.join(", ") : "aucune clinique"}.`, "ok");
      await refresh();
    });
    add.append(form);
    box.append(add);
    return box;
  }

  function card(r) {
    const c = el("div", "am-card" + (r.role === "member" ? " am-pending" : ""));
    const head = el("div", "am-head");
    const who = el("div", "am-who");
    const nm = el("h2", "am-name", nameOf(r));
    who.append(nm);
    const mail = el("a", "am-mail", r.email || "");
    mail.href = "mailto:" + (r.email || "");
    who.append(mail);
    const meta = el("p", "muted am-meta", [r.institution ? "Institution : " + r.institution : "Hors CHUV",
      "inscrit le " + fmt(r.created_at), "dernière connexion : " + fmt(r.last_sign_in_at)].join(" · "));
    who.append(meta);
    // Jamais connecté : renvoi du lien de premier accès (l'invitation a pu expirer ou s'égarer)
    if (!r.last_sign_in_at && r.id !== state.me && !(state.role === "direction" && RESERVED.includes(r.role))) {
      const row = el("div", "am-resend");
      const out = el("span", "muted am-resend-msg");
      const b = el("button", "btn btn-outline ug-copy", "Renvoyer l'invitation"); b.type = "button";
      b.addEventListener("click", async () => {
        if (!confirm(`Renvoyer à ${r.email} un lien pour choisir son mot de passe et activer son compte ?`)) return;
        b.disabled = true; out.textContent = "Envoi…";
        const { data, error } = await sb.functions.invoke("resend-invite", { body: { user_id: r.id } });
        b.disabled = false;
        if (error) {
          let code = "";
          try { code = (await error.context.json()).error; } catch (x) { /* réponse non JSON */ }
          out.textContent = {
            rate_limited: "Un lien vient déjà d'être envoyé : réessayez dans une minute.",
            already_signed_in: "Ce membre s'est déjà connecté : il peut utiliser « Mot de passe oublié ».",
            admin_only: "Seul un administrateur renvoie le lien d'un compte admin ou direction.",
            forbidden: "Réservé à l'administration."
          }[code] || "Envoi impossible (" + (code || "erreur réseau") + ").";
          return;
        }
        out.textContent = `Lien envoyé à ${r.email} (${data.mode === "invite" ? "nouvelle invitation" : "lien de choix du mot de passe"}). Valable un temps limité : qu'il ou elle l'ouvre rapidement, et vérifie les indésirables.`;
      });
      row.append(b, out);
      who.append(row);
    }
    head.append(who);

    const rl = el("label", "am-rolebox", "Rôle");
    const sel = el("select", "am-rolesel");
    ROLES.forEach(([v, l]) => { const o = el("option", null, l); o.value = v; sel.append(o); });
    sel.value = r.role;
    const self = r.id === state.me;
    const locked = state.role === "direction" && RESERVED.includes(r.role);
    if (state.role === "direction") Array.from(sel.options).forEach((o) => { if (RESERVED.includes(o.value)) o.disabled = true; });
    sel.disabled = self || locked;
    if (self) rl.title = "Vous ne pouvez pas modifier votre propre rôle.";
    else if (locked) rl.title = "Seul un administrateur modifie un compte admin ou direction.";
    sel.addEventListener("change", async () => {
      const to = sel.value;
      const msg = to === "admin" ? `Donner les droits administrateur complets à ${nameOf(r)} ?`
        : `Passer ${nameOf(r)} de « ${ROLE_LABEL[r.role]} » à « ${ROLE_LABEL[to]} » ? Ses accès reviendront aux valeurs par défaut du nouveau rôle.`;
      if (!confirm(msg)) { sel.value = r.role; return; }
      const { error } = await sb.rpc("admin_set_role", { p_user: r.id, p_role: to });
      if (error) { sel.value = r.role; return say("Refusé : " + error.message, "error"); }
      say(`${nameOf(r)} : rôle « ${ROLE_LABEL[to]} » enregistré.`, "ok");
      await refresh();
    });
    rl.append(sel);
    head.append(rl);
    c.append(head);

    const tools = el("fieldset", "am-tools");
    tools.append(el("legend", null, "Outils"));
    const fixed = r.role === "admin" || r.role === "direction" || r.role === "member";
    for (const [t, label] of TOOLS) {
      const st = (r.tools || {})[t] || { allowed: false, custom: false };
      const lab = el("label", "cg-check am-tool" + (st.custom ? " am-custom" : ""));
      const cb = el("input");
      cb.type = "checkbox"; cb.checked = !!st.allowed;
      const medOk = t !== "medletters" || (state.role === "admin" && ["clinician", "cdc", "cadre", "pharmacist"].includes(r.role));
      cb.disabled = fixed || !medOk;
      cb.addEventListener("change", async () => {
        cb.disabled = true;
        const { data, error } = await sb.rpc("admin_set_tool", { p_user: r.id, p_tool: t, p_allowed: cb.checked });
        if (error) { cb.checked = !cb.checked; say("Refusé : " + error.message, "error"); }
        else say(`${nameOf(r)} : ${label} ${data ? "ouvert" : "fermé"}.`, "ok");
        await refresh();
      });
      lab.append(cb, el("span", null, label));
      if (st.custom) lab.append(el("span", "ug-badge am-exc", "exception"));
      tools.append(lab);
    }
    c.append(tools);
    if (r.role === "clinician" || r.role === "cdc" || r.role === "cadre") {
      const fs = el("fieldset", "am-tools am-clinics");
      fs.append(el("legend", null, "Cliniques de rattachement (planning et validation des absences)"));
      const mine = new Set(r.clinics || []);
      for (const cl of ABS_CLINICS) {
        const lab = el("label", "cg-check am-tool");
        const cb = el("input");
        cb.type = "checkbox"; cb.checked = mine.has(cl);
        cb.addEventListener("change", async () => {
          cb.disabled = true;
          cb.checked ? mine.add(cl) : mine.delete(cl);
          const { error } = await sb.rpc("admin_set_clinics", { p_user: r.id, p_clinics: [...mine] });
          if (error) { cb.checked ? mine.delete(cl) : mine.add(cl); cb.checked = !cb.checked; say("Refusé : " + error.message, "error"); }
          else say(`${nameOf(r)} : rattaché·e à ${mine.size ? [...mine].join(", ") : "aucune clinique"}.`, "ok");
          cb.disabled = false;
          await refresh();
        });
        lab.append(cb, el("span", null, cl));
        fs.append(lab);
      }
      c.append(fs);
      if (!mine.size) c.append(el("p", "muted am-note", "Aucune clinique de rattachement : ce médecin ne voit pas de collègues par défaut dans le planning des absences et ses demandes iront à l'administrateur."));
      c.append(plannedChanges(r));
    }
    if (r.role === "cdc" || r.role === "cadre") {
      const fs = el("fieldset", "am-tools am-clinics");
      fs.append(el("legend", null, "Cliniques dont le ou la CDC / cadre modifie et valide les fiches Key trials"));
      const mine = new Set(r.cdc_clinics || []);
      for (const cl of CLINICS) {
        const lab = el("label", "cg-check am-tool");
        const cb = el("input");
        cb.type = "checkbox"; cb.checked = mine.has(cl);
        cb.addEventListener("change", async () => {
          cb.disabled = true;
          cb.checked ? mine.add(cl) : mine.delete(cl);
          const { error } = await sb.rpc("admin_set_cdc_clinics", { p_user: r.id, p_clinics: [...mine] });
          if (error) { cb.checked ? mine.delete(cl) : mine.add(cl); cb.checked = !cb.checked; say("Refusé : " + error.message, "error"); }
          else say(`${nameOf(r)} : ${mine.size ? [...mine].join(", ") : "aucune clinique"}.`, "ok");
          cb.disabled = false;
          await refresh();
        });
        lab.append(cb, el("span", null, cl));
        fs.append(lab);
      }
      c.append(fs);
      if (!mine.size) c.append(el("p", "muted am-note", "Aucune clinique choisie : ce membre n'a pas encore le droit de modifier de fiche."));
    }
    if (r.role === "cadre" || r.role === "direction") {
      // Tous les médecins cadres ne valident pas les absences : la case ouvre ce droit, les cliniques se choisissent ensuite
      const fs = el("fieldset", "am-tools am-validator");
      fs.append(el("legend", null, "Validation des absences"));
      const lab = el("label", "cg-check am-tool");
      const cb = el("input");
      cb.type = "checkbox"; cb.checked = !!r.absence_validator;
      cb.addEventListener("change", async () => {
        if (!cb.checked && (r.validates || []).length && !confirm(`Décocher retire ${nameOf(r)} de la validation des absences (${r.validates.join(", ")}). Continuer ?`)) { cb.checked = true; return; }
        cb.disabled = true;
        const { error } = await sb.rpc("admin_set_absence_validator", { p_user: r.id, p_on: cb.checked });
        if (error) { cb.checked = !cb.checked; cb.disabled = false; return say("Refusé : " + error.message, "error"); }
        say(cb.checked ? `${nameOf(r)} est validateur des absences : choisissez ses cliniques dans « Absences : valideurs par clinique ».` : `${nameOf(r)} ne valide plus d'absences.`, "ok");
        await refresh();
      });
      lab.append(cb, el("span", null, "Validateur des absences"));
      fs.append(lab);
      c.append(fs);
      const info = el("p", "muted am-note");
      if (!r.absence_validator) info.textContent = "Ne valide aucune absence : cochez la case pour pouvoir le ou la désigner par clinique.";
      else if ((r.validates || []).length) info.textContent = "Valide les absences de : " + r.validates.join(", ") + ". ";
      else info.textContent = "Aucune clinique désignée pour l'instant : ";
      if (r.absence_validator) { const a = el("a", null, "choisir les cliniques"); a.href = "/admin/absences.html"; info.append(a, document.createTextNode(".")); }
      c.append(info);
    }
    if (r.role === "assistant" && "admin_lead" in r && !r.access_until) {
      const fs = el("fieldset", "am-tools am-validator");
      fs.append(el("legend", null, "Cadre administratif"));
      const lab = el("label", "cg-check am-tool");
      const cb = el("input");
      cb.type = "checkbox"; cb.checked = !!r.admin_lead;
      cb.addEventListener("change", async () => {
        cb.disabled = true;
        const { error } = await sb.rpc("admin_set_admin_lead", { p_user: r.id, p_on: cb.checked });
        if (error) { cb.checked = !cb.checked; cb.disabled = false; return say("Refusé : " + error.message, "error"); }
        say(cb.checked ? `${nameOf(r)} est cadre administratif : elle ou il crée et gère les comptes temporaires.` : `${nameOf(r)} n'est plus cadre administratif.`, "ok");
        await refresh();
      });
      lab.append(cb, el("span", null, "Cadre administratif (crée et gère les comptes temporaires)"));
      fs.append(lab);
      c.append(fs);
    }
    if (r.role === "assistant" && "agenda_manager" in r) {
      // Gestion des agendas médecins : cliniques dont l'assistante bloque les agendas ; un bloc coche d'un coup toutes ses cliniques
      const fs = el("fieldset", "am-tools am-validator");
      fs.append(el("legend", null, "Gestion des agendas médecins"));
      const lab = el("label", "cg-check am-tool");
      const cb = el("input"); cb.type = "checkbox"; cb.checked = !!r.agenda_manager;
      lab.append(cb, el("span", null, "Gère les agendas de consultation des médecins (reçoit les tâches de blocage Ultragenda)"));
      fs.append(lab);
      const box = el("div", "am-agenda-box"); box.hidden = !cb.checked;
      const mine = new Set(r.agenda_clinics || []);
      const grid = el("div", "am-tools am-clinics");
      const boxes = [];
      for (const cl of ABS_CLINICS) {
        const l = el("label", "cg-check am-tool"); const c2 = el("input"); c2.type = "checkbox"; c2.value = cl; c2.checked = mine.has(cl);
        l.append(c2, el("span", null, cl)); grid.append(l); boxes.push(c2);
      }
      box.append(grid);
      if (state.blocs.length) {
        const sh = el("p", "muted am-note", "Raccourci par bloc : ");
        state.blocs.forEach((b) => {
          const bt = el("button", "btn btn-outline ug-copy", b.name); bt.type = "button";
          bt.addEventListener("click", () => boxes.forEach((x) => { if (b.clinics.includes(x.value)) x.checked = true; }));
          sh.append(bt, document.createTextNode(" "));
        });
        box.append(sh);
      }
      const save = el("button", "btn btn-outline ug-copy", "Enregistrer les cliniques"); save.type = "button";
      save.addEventListener("click", async () => {
        const chosen = boxes.filter((x) => x.checked).map((x) => x.value);
        if (!chosen.length) return say("Choisissez au moins une clinique.", "error");
        save.disabled = true;
        const { data, error } = await sb.rpc("admin_set_agenda_manager", { p_user: r.id, p_on: true, p_clinics: chosen });
        save.disabled = false;
        if (error) return say("Refusé : " + error.message, "error");
        say(`${nameOf(r)} gère les agendas : ${chosen.join(", ")}.${data ? "" : " Attention : l'accès à Absences est fermé pour ce compte."}`, data ? "ok" : "error");
        await refresh();
      });
      box.append(save);
      fs.append(box);
      cb.addEventListener("change", async () => {
        box.hidden = !cb.checked;
        if (cb.checked) return;
        cb.disabled = true;
        const { error } = await sb.rpc("admin_set_agenda_manager", { p_user: r.id, p_on: false, p_clinics: [] });
        if (error) { cb.checked = true; box.hidden = false; cb.disabled = false; return say("Refusé : " + error.message, "error"); }
        say(`${nameOf(r)} ne gère plus les agendas médecins.`, "ok");
        await refresh();
      });
      c.append(fs);
      // Secrétaire de médecin cadre : médecins cadres dont elle voit et demande les absences
      const fs2 = el("fieldset", "am-tools am-validator");
      fs2.append(el("legend", null, "Secrétaire de médecin cadre"));
      const lab2 = el("label", "cg-check am-tool");
      const cb2 = el("input"); cb2.type = "checkbox"; cb2.checked = !!r.cadre_secretary;
      lab2.append(cb2, el("span", null, "Secrétaire d'un ou de plusieurs médecins cadres (voit et demande leurs absences, reçoit leurs PDF et tâches Ultragenda)"));
      fs2.append(lab2);
      const box2 = el("div", "am-agenda-box"); box2.hidden = !cb2.checked;
      const sel = new Set(r.secretary_of || []);
      const grid2 = el("div", "am-tools am-clinics"); const boxes2 = [];
      state.rows.filter((x) => x.role === "cadre").forEach((x) => {
        const l = el("label", "cg-check am-tool"); const c3 = el("input"); c3.type = "checkbox"; c3.value = x.id; c3.checked = sel.has(x.id);
        l.append(c3, el("span", null, nameOf(x))); grid2.append(l); boxes2.push(c3);
      });
      if (!boxes2.length) grid2.append(el("p", "muted am-note", "Aucun médecin cadre dans la liste."));
      box2.append(grid2);
      const save2 = el("button", "btn btn-outline ug-copy", "Enregistrer les médecins cadres"); save2.type = "button";
      save2.addEventListener("click", async () => {
        const chosen = boxes2.filter((x) => x.checked).map((x) => x.value);
        if (!chosen.length) return say("Choisissez au moins un médecin cadre.", "error");
        save2.disabled = true;
        const { data, error } = await sb.rpc("admin_set_cadre_secretary", { p_user: r.id, p_on: true, p_cadres: chosen });
        save2.disabled = false;
        if (error) return say("Refusé : " + error.message, "error");
        say(`${nameOf(r)} est secrétaire de ${chosen.length} médecin${chosen.length > 1 ? "s" : ""} cadre${chosen.length > 1 ? "s" : ""}.${data ? "" : " Attention : l'accès à Absences est fermé pour ce compte."}`, data ? "ok" : "error");
        await refresh();
      });
      box2.append(save2);
      fs2.append(box2);
      cb2.addEventListener("change", async () => {
        box2.hidden = !cb2.checked;
        if (cb2.checked) return;
        cb2.disabled = true;
        const { error } = await sb.rpc("admin_set_cadre_secretary", { p_user: r.id, p_on: false, p_cadres: [] });
        if (error) { cb2.checked = true; box2.hidden = false; cb2.disabled = false; return say("Refusé : " + error.message, "error"); }
        say(`${nameOf(r)} n'est plus secrétaire de médecin cadre.`, "ok");
        await refresh();
      });
      c.append(fs2);
      c.append(el("p", "muted am-note", "Ces deux fonctions ouvrent l'accès à Absences si besoin. Les blocs et la diffusion des PDF se règlent dans « Diffusion des absences »."));
    }
    if ("access_until" in r && !["admin", "direction"].includes(r.role) && r.id !== state.me) {
      // Fin d'accès : comptes temporaires (créés par un cadre administratif) ou tout compte à limiter dans le temps
      const fs = el("fieldset", "am-tools am-validator");
      fs.append(el("legend", null, "Fin d'accès"));
      const row = el("div", "am-until");
      const inp = el("input"); inp.type = "date"; inp.value = r.access_until || ""; inp.setAttribute("aria-label", "Dernier jour d'accès");
      const save = el("button", "btn btn-outline ug-copy", "Enregistrer"); save.type = "button";
      save.addEventListener("click", async () => {
        save.disabled = true;
        const { error } = await sb.rpc("admin_set_access_until", { p_user: r.id, p_until: inp.value || null });
        save.disabled = false;
        if (error) return say("Refusé : " + error.message, "error");
        say(inp.value ? `Accès de ${nameOf(r)} limité au ${fmtD(inp.value)} inclus.` : `Accès de ${nameOf(r)} sans limite de durée.`, "ok");
        await refresh();
      });
      row.append(inp, save);
      if (r.access_until) {
        const clear = el("button", "btn btn-outline ug-copy", "Sans limite"); clear.type = "button";
        clear.addEventListener("click", () => { inp.value = ""; save.click(); });
        row.append(clear);
      }
      fs.append(row);
      c.append(fs);
      c.append(el("p", "muted am-note", r.access_until
        ? `Dernier jour d'accès : ${fmtD(r.access_until)}${r.created_by_name ? ", compte temporaire créé par " + r.created_by_name : ""}. Au-delà, le compte n'a plus aucun accès et ne peut plus se connecter.`
        : "Laissez vide pour un compte permanent."));
    }
    const notes = [];
    if (r.role === "admin") notes.push("Administrateur : accès à tout.");
    if (r.role === "direction") notes.push("Admin de direction : gère les membres (sauf les comptes admin et direction), le calendrier commun et les deux annuaires, valide les absences en 2e ligne (et en 1re ligne si désigné·e validateur·trice d'une clinique), saisit des absences au nom d'un membre.");
    if (r.role === "member") notes.push("Compte en attente : choisissez un rôle pour ouvrir les accès.");
    if (r.role === "cdc") notes.push("CDC (chef·fe de clinique) : droits d'un médecin assistant, plus modification et validation des fiches Key trials des cliniques cochées.");
    if (r.role === "cadre") notes.push("Médecin cadre : exactement les droits d'un·e CDC, plus, si la case « Validateur des absences » est cochée, la validation des absences des cliniques où il ou elle est désigné·e (page « Absences : valideurs par clinique »).");
    if (["assistant", "nurse", "pharmacist", "direction", "admin"].includes(r.role)) notes.push("Rattaché·e à la clinique Administration pour les absences (seuls les médecins, CDC et cadres ont des cliniques).");
    if (r.role === "pharmacist") notes.push("Pharmacien·ne : administre aussi les Lettres d'assurance, Limitations LS et Durée de traitement auxquelles il ou elle a accès.");
    if (notes.length) c.append(el("p", "muted am-note", notes.join(" ")));
    if (Object.values(r.tools || {}).some((x) => x.custom)) {
      const b = el("button", "btn btn-outline ug-copy", "Rétablir les accès par défaut");
      b.type = "button";
      b.addEventListener("click", async () => {
        const { error } = await sb.rpc("admin_reset_tools", { p_user: r.id });
        if (error) return say("Refusé : " + error.message, "error");
        say(`${nameOf(r)} : accès par défaut rétablis.`, "ok");
        await refresh();
      });
      c.append(b);
    }
    const help = el("details", "am-helpbox");
    help.append(el("summary", null, "Comment lire ces cases ?"), document.getElementById("am-help-tpl").content.cloneNode(true));
    c.append(help);
    return c;
  }

  // Ajouter un membre (Edge Function member-create) : rôles limités à ce que la base autorise pour l'appelant
  const ADD_ROLES = ["clinician", "cdc", "cadre", "assistant", "nurse", "pharmacist", "direction"];
  const ADD_ERRORS = {
    invalid_email: "Adresse e-mail invalide.",
    invalid_name: "Prénom et nom sont nécessaires.",
    invalid_role: "Rôle non autorisé.",
    invalid_institution: "Institution inconnue.",
    user_exists: "Un compte existe déjà avec cette adresse. Retrouvez-le dans la liste pour modifier son rôle.",
    invite_failed: "L'invitation n'a pas pu être envoyée. Réessayez, ou choisissez le mot de passe provisoire.",
    create_failed: "Le compte n'a pas pu être créé. Réessayez.",
    profile_failed: "Le compte n'a pas pu être configuré et a été retiré. Réessayez.",
    forbidden: "Vous n'avez pas le droit de créer ce rôle.",
    unauthorized: "Session expirée : reconnectez-vous."
  };
  function addChecks(box, list, name) {
    for (const cl of list) {
      const lab = el("label", "cg-check am-tool");
      const cb = el("input");
      cb.type = "checkbox"; cb.value = cl; cb.name = name;
      lab.append(cb, el("span", null, cl));
      box.append(lab);
    }
  }
  const addSay = (text, kind) => { const m = $("am-add-msg"); m.textContent = text; m.className = "form-msg" + (kind ? " " + kind : ""); };
  const addChosen = (box) => [...box.querySelectorAll("input:checked")].map((i) => i.value);
  function addSync() {
    const role = $("am-add-role").value;
    $("am-add-clinics").hidden = !["clinician", "cdc", "cadre"].includes(role);
    $("am-add-cdc").hidden = !["cdc", "cadre"].includes(role);
  }
  async function addSubmit(e) {
    e.preventDefault();
    const btn = $("am-add-submit");
    $("am-add-pass").hidden = true;
    const role = $("am-add-role").value;
    const body = {
      first_name: $("am-add-first").value.trim(), last_name: $("am-add-last").value.trim(), email: $("am-add-email").value.trim(), role,
      institution: $("am-add-inst").value,
      clinics: ["clinician", "cdc", "cadre"].includes(role) ? addChosen($("am-add-clinics")) : [],
      cdc_clinics: ["cdc", "cadre"].includes(role) ? addChosen($("am-add-cdc")) : [],
      mode: document.querySelector('input[name="am-add-mode"]:checked').value
    };
    if (!role) return addSay("Choisissez un rôle.", "error");
    if (!body.first_name || !body.last_name) return addSay(ADD_ERRORS.invalid_name, "error");
    if (!body.email || !$("am-add-email").checkValidity()) return addSay(ADD_ERRORS.invalid_email, "error");
    btn.disabled = true; addSay("Création…");
    let res;
    try { res = await sb.functions.invoke("member-create", { body }); } catch (x) { res = { error: x }; }
    btn.disabled = false;
    if (res.error) {
      let code = "";
      try { code = (await res.error.context.json()).error; } catch (x) { /* réponse non JSON */ }
      return addSay(ADD_ERRORS[code] || "Création impossible (" + (code || "erreur réseau") + ").", "error");
    }
    const data = res.data || {};
    const who = body.first_name + " " + body.last_name;
    addSay(data.mode === "invite" ? `Compte créé pour ${who} (${ROLE_LABEL[role]}). Une invitation a été envoyée à ${body.email}.` : `Compte créé pour ${who} (${ROLE_LABEL[role]}).`, "ok");
    if (data.password) { $("am-add-pass-value").textContent = data.password; $("am-add-pass").hidden = false; }
    $("am-add-form").reset(); addSync();
    await refresh();
  }
  async function initAdd() {
    const det = $("am-add");
    const oks = await Promise.all(ADD_ROLES.map(async (r) => {
      if (r === "direction" && state.role !== "admin") return false; // seul un administrateur crée une direction
      try { const { data } = await sb.rpc("member_create_allowed", { p_role: r }); return data === true; } catch (x) { return false; }
    }));
    const roles = ADD_ROLES.filter((r, i) => oks[i]);
    if (!roles.length) { det.hidden = true; return; } // migration absente ou aucun droit
    const sel = $("am-add-role");
    sel.replaceChildren(...roles.map((r) => { const o = el("option", null, ROLE_LABEL[r]); o.value = r; return o; }));
    addChecks($("am-add-clinics"), ABS_CLINICS, "am-add-clinic");
    addChecks($("am-add-cdc"), CLINICS, "am-add-cdc-clinic");
    sel.addEventListener("change", addSync);
    addSync();
    $("am-add-form").addEventListener("submit", addSubmit);
    $("am-add-pass-copy").addEventListener("click", async (e) => {
      try { await navigator.clipboard.writeText($("am-add-pass-value").textContent); e.target.textContent = "Copié"; } catch (x) { e.target.textContent = "Copie impossible"; }
    });
    det.hidden = false;
  }

  // Recharge les données en gardant le membre choisi et les positions de défilement
  async function refresh() {
    const y = window.scrollY;
    try { await load(); } catch (e) { return say("Chargement impossible : " + e.message, "error"); }
    render();
    renderClinicRequests();
    window.scrollTo(0, y);
  }

  (async () => {
    if (!sb) return ($("ug-status").textContent = "Service indisponible.");
    const { data } = await sb.auth.getSession();
    if (!data.session) return (location.href = "/fr/the-hive.html");
    $("logout").addEventListener("click", async () => { await sb.auth.signOut(); location.href = "/fr/"; });
    state.me = data.session.user.id;
    const { data: role } = await sb.rpc("current_role_name");
    if (role !== "admin" && role !== "direction") return ($("ug-status").textContent = "Page réservée à l'administration.");
    state.role = role;
    try { await load(); } catch (e) { return ($("ug-status").textContent = "Chargement impossible : " + e.message); }
    $("ug-status").hidden = true;
    $("am-tool").hidden = false;
    $("am-add").hidden = true;
    initAdd();
    $("am-q").addEventListener("input", render);
    $("am-role").addEventListener("change", render);
    if (S() && $("am-sort-slot")) $("am-sort-slot").replaceChildren(S().control("membres", { modes: SORT_MODES, onChange: render }));
    $("am-close").addEventListener("click", closeDetail);
    $("am-back").addEventListener("click", closeDetail);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && state.sel && !document.querySelector("dialog[open]")) closeDetail(); });
    const m = /^#u=(.+)$/.exec(location.hash);
    if (m) state.sel = decodeURIComponent(m[1]);
    render();
    renderClinicRequests();
  })();
})();
