// Diffusion des absences validées : blocs de cliniques et destinataires du PDF par médecin. Réservé à l'administration (contrôlé aussi en base).
(function () {
  const cfg = window.ONCONIC_CONFIG || {};
  const sb = window.supabase && cfg.supabaseUrl ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey) : null;
  const $ = (id) => document.getElementById(id);
  const state = { blocs: [], clinics: [], leads: [], docs: [], members: [], open: null };
  const ROLE = { clinician: "Médecin assistant", cdc: "CDC", cadre: "Médecin cadre" };

  function el(tag, cls, txt) { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  function say(text, kind) { const m = $("df-msg"); m.className = "form-msg" + (kind ? " " + kind : ""); m.textContent = text; }
  const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  function check(value, label, on) {
    const l = el("label", "cg-check am-tool"); const c = el("input"); c.type = "checkbox"; c.value = value; c.checked = !!on;
    l.append(c, el("span", null, label));
    return { label: l, input: c };
  }

  // Formulaire d'un bloc (création si b est vide)
  function blocForm(b) {
    const f = el("form", "card aa-card"); f.noValidate = true;
    const nl = el("label", null, "Nom du bloc"); const name = el("input"); name.type = "text"; name.maxLength = 40; name.value = b.name || ""; nl.append(name);
    const ml = el("label", null, "Boîte commune (facultative)"); const mail = el("input"); mail.type = "email"; mail.maxLength = 254; mail.value = b.email || ""; mail.autocomplete = "off"; ml.append(mail);
    const cl = el("fieldset", "aa-cadres"); cl.append(el("legend", null, "Cliniques"));
    const cls = state.clinics.map((c) => { const x = check(c, c, (b.clinics || []).includes(c)); cl.append(x.label); return x.input; });
    const ll = el("fieldset", "aa-cadres"); ll.append(el("legend", null, "Cadres administratifs responsables"));
    const lds = state.leads.map((p) => { const x = check(p.id, p.name, (b.lead_ids || []).includes(p.id)); ll.append(x.label); return x.input; });
    if (!state.leads.length) ll.append(el("p", "muted", "Aucun cadre administratif : cochez la fonction dans Membres et accès."));
    const out = el("p", "form-msg"); out.setAttribute("role", "status");
    const row = el("div", "btn-row"); const save = el("button", "btn", b.id ? "Enregistrer" : "Créer le bloc"); save.type = "submit"; row.append(save);
    if (b.id) {
      const del = el("button", "btn btn-outline lt-danger", "Supprimer"); del.type = "button";
      del.addEventListener("click", async () => {
        if (!confirm(`Supprimer le bloc « ${b.name} » ? Les cliniques n'auront plus de boîte commune.`)) return;
        const { error } = await sb.rpc("admin_bloc_delete", { p_id: b.id });
        if (error) return say(error.message, "error");
        say("Bloc supprimé.", "ok"); await load();
      });
      row.append(del);
    }
    f.append(el("h3", null, b.id ? b.name : "Nouveau bloc"), nl, ml, cl, ll, out, row);
    f.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      save.disabled = true;
      const { error } = await sb.rpc("admin_bloc_save", { p_id: b.id || null, p_name: name.value, p_clinics: cls.filter((x) => x.checked).map((x) => x.value), p_email: mail.value, p_lead_ids: lds.filter((x) => x.checked).map((x) => x.value) });
      save.disabled = false;
      if (error) return (out.className = "form-msg error", out.textContent = error.message);
      say(b.id ? "Bloc enregistré." : "Bloc créé.", "ok"); await load();
    });
    return f;
  }

  function renderBlocs() {
    const box = $("df-blocs"); box.replaceChildren();
    if (!state.blocs.length) box.append(el("p", "muted", "Aucun bloc : seuls la gestion des absences, les secrétaires et la personnalisation reçoivent le PDF."));
    state.blocs.forEach((b) => box.append(blocForm(b)));
    const nb = $("df-new-body"); nb.replaceChildren(blocForm({}));
  }

  function docCard(d) {
    const card = el("article", "card aa-card");
    const head = el("div", "aa-head");
    head.append(el("h3", null, d.name), el("span", "ug-badge", ROLE[d.role] || d.role));
    card.append(head);
    const meta = [];
    if ((d.clinics || []).length) meta.push(d.clinics.join(", "));
    meta.push((d.blocs || []).length ? "Bloc : " + d.blocs.join(", ") : "Aucun bloc");
    if (d.mode) meta.push(d.mode === "replace" ? "Personnalisé : remplace" : "Personnalisé : ajoute");
    meta.push(`${d.recipients} destinataire${d.recipients > 1 ? "s" : ""}`);
    card.append(el("p", "muted", meta.join(" · ")));
    const act = el("div", "btn-row");
    const b = el("button", "btn btn-outline", state.open === d.id ? "Fermer" : "Destinataires"); b.type = "button";
    b.addEventListener("click", () => { state.open = state.open === d.id ? null : d.id; renderDocs(); });
    act.append(b); card.append(act);
    if (state.open === d.id) { const slot = el("div"); card.append(slot); routingEditor(d, slot); }
    return card;
  }

  async function routingEditor(d, slot) {
    slot.append(el("p", "muted", "Chargement…"));
    const { data, error } = await sb.rpc("admin_form_routing_get", { p_user: d.id });
    slot.replaceChildren();
    if (error) return slot.append(el("p", "form-msg error", error.message));
    const sec = el("div");
    sec.append(el("p", null, "Par défaut : " + ((data.default.blocs || []).filter((x) => x.email).length ? "boîte du bloc (" + data.default.blocs.filter((x) => x.email).map((x) => x.name).join(", ") + ")" : "aucune boîte commune")
      + (data.default.members.length ? " ; " + data.default.members.map((m) => m.name).join(", ") : "") + "."));
    sec.append(el("p", "muted", "Destinataires effectifs : " + ([...data.effective.emails, ...data.effective.members.map((m) => m.name + " (adresse personnelle)")].join(", ") || "aucun")));
    const form = el("form", "ab-edit"); form.noValidate = true;
    const modeL = el("label", null, "Personnalisation"); const mode = el("select");
    [["", "Aucune (calcul par défaut)"], ["add", "Ajouter aux destinataires par défaut"], ["replace", "Remplacer les destinataires par défaut"]].forEach(([v, l]) => { const o = el("option", null, l); o.value = v; mode.append(o); });
    mode.value = data.mode || ""; modeL.append(mode);
    const eL = el("label", null, "Adresses e-mail (une par ligne, 20 au plus)"); const emails = el("textarea"); emails.rows = 3; emails.value = (data.emails || []).join("\n"); eL.append(emails);
    const mq = el("label", null, "Membres (adresse personnelle, 20 au plus)"); const q = el("input"); q.type = "search"; q.placeholder = "Filtrer par nom"; mq.append(q);
    const list = el("div", "aa-cadres"); const picks = new Set(data.member_ids || []);
    const draw = () => {
      list.replaceChildren();
      state.members.filter((m) => picks.has(m.id) || !q.value || norm(m.name).includes(norm(q.value))).slice(0, 80).forEach((m) => {
        const x = check(m.id, m.name, picks.has(m.id)); x.input.addEventListener("change", () => { x.input.checked ? picks.add(m.id) : picks.delete(m.id); });
        list.append(x.label);
      });
    };
    q.addEventListener("input", draw); draw();
    const out = el("p", "form-msg"); out.setAttribute("role", "status");
    const row = el("div", "btn-row"); const save = el("button", "btn", "Enregistrer"); save.type = "submit"; row.append(save);
    form.append(modeL, eL, mq, list, out, row);
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault(); save.disabled = true;
      const res = mode.value ? await sb.rpc("admin_form_routing_set", { p_user: d.id, p_mode: mode.value, p_emails: emails.value.split(/[\n;]+/).map((x) => x.trim()).filter(Boolean), p_members: [...picks] })
        : await sb.rpc("admin_form_routing_delete", { p_user: d.id });
      save.disabled = false;
      if (res.error) return (out.className = "form-msg error", out.textContent = res.error.message);
      say(`Destinataires de ${d.name} enregistrés.`, "ok"); await loadDocs();
    });
    slot.append(sec, form);
  }

  function renderDocs() {
    const q = norm($("df-q").value);
    const box = $("df-docs"); box.replaceChildren();
    state.docs.filter((d) => !q || norm(d.name + " " + (d.clinics || []).join(" ")).includes(q)).forEach((d) => box.append(docCard(d)));
  }
  async function loadDocs() {
    const { data, error } = await sb.rpc("admin_form_routing_overview");
    if (error) return say(error.message, "error");
    state.docs = data || []; renderDocs();
  }
  async function load() {
    const { data, error } = await sb.rpc("admin_blocs_list");
    if (error) return say("Chargement impossible : " + error.message, "error");
    Object.assign(state, { blocs: data.blocs, clinics: data.clinics, leads: data.leads });
    renderBlocs(); await loadDocs();
  }

  (async () => {
    if (!sb) return ($("ug-status").textContent = "Service indisponible.");
    const { data } = await sb.auth.getSession();
    if (!data.session) return (location.href = "/fr/the-hive.html");
    $("logout").addEventListener("click", async () => { await sb.auth.signOut(); location.href = "/fr/"; });
    const { data: role } = await sb.rpc("current_role_name");
    if (role !== "admin" && role !== "direction") return ($("ug-status").textContent = "Page réservée à l'administration.");
    const m = await sb.rpc("admin_members");
    state.members = (m.data || []).filter((x) => x.role !== "member").map((x) => ({ id: x.id, name: [x.first_name, x.last_name].filter(Boolean).join(" ") || x.full_name || x.email }));
    $("ug-status").hidden = true; $("df-tool").hidden = false;
    $("df-q").addEventListener("input", renderDocs);
    await load();
  })();
})();
