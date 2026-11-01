// Administration des membres : liste, rôle et accès par outil. Réservé aux admins (contrôlé aussi en base).
(function () {
  const cfg = window.ONCONIC_CONFIG || {};
  const sb = window.supabase && cfg.supabaseUrl ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey) : null;
  const $ = (id) => document.getElementById(id);

  const ROLES = [["member", "En attente de validation"], ["clinician", "Médecin"], ["assistant", "Assistante médicale"],
    ["pharmacist", "Pharmacien·ne"], ["admin", "Administrateur"]];
  const ROLE_LABEL = Object.fromEntries(ROLES);
  const TOOLS = [["congres", "Congrès"], ["trials", "Key trials"], ["lettres", "Lettres d'assurance"],
    ["limitations", "Limitations LS"], ["duree", "Durée de traitement"], ["medletters", "Lettres médicales"]];
  const state = { rows: [], me: null };

  const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  function el(tag, cls, txt) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }
  const fmt = (d) => (d ? new Date(d).toLocaleDateString("fr-CH") : "jamais");
  function say(text, kind) { const m = $("am-msg"); m.className = "form-msg" + (kind ? " " + kind : ""); m.textContent = text; }
  const nameOf = (r) => [r.first_name, r.last_name].filter(Boolean).join(" ") || r.full_name || "(sans nom)";

  async function load() {
    const { data, error } = await sb.rpc("admin_members");
    if (error) throw error;
    state.rows = data || [];
  }

  function render() {
    const q = norm($("am-q").value);
    const role = $("am-role").value;
    const rows = state.rows.filter((r) => (!role || r.role === role)
      && (!q || norm([r.first_name, r.last_name, r.full_name, r.email].join(" ")).includes(q)));
    const pending = state.rows.filter((r) => r.role === "member").length;
    $("am-count").textContent = `${rows.length} membre(s) affiché(s) sur ${state.rows.length}` + (pending ? ` · ${pending} en attente de validation` : "");
    $("am-list").replaceChildren(...rows.map(card));
  }

  function card(r) {
    const c = el("article", "card am-card" + (r.role === "member" ? " am-pending" : ""));
    const head = el("div", "am-head");
    const who = el("div", "am-who");
    const nm = el("h3", null, nameOf(r));
    who.append(nm);
    const mail = el("a", "am-mail", r.email || "");
    mail.href = "mailto:" + (r.email || "");
    who.append(mail);
    const meta = el("p", "muted am-meta", [r.institution ? "Institution : " + r.institution : "Hors CHUV",
      "inscrit le " + fmt(r.created_at), "dernière connexion : " + fmt(r.last_sign_in_at)].join(" · "));
    who.append(meta);
    head.append(who);

    const rl = el("label", "am-rolebox", "Rôle");
    const sel = el("select", "am-rolesel");
    ROLES.forEach(([v, l]) => { const o = el("option", null, l); o.value = v; sel.append(o); });
    sel.value = r.role;
    const self = r.id === state.me;
    sel.disabled = self;
    if (self) rl.title = "Vous ne pouvez pas modifier votre propre rôle.";
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
    const fixed = r.role === "admin" || r.role === "member";
    for (const [t, label] of TOOLS) {
      const st = (r.tools || {})[t] || { allowed: false, custom: false };
      const lab = el("label", "cg-check am-tool" + (st.custom ? " am-custom" : ""));
      const cb = el("input");
      cb.type = "checkbox"; cb.checked = !!st.allowed;
      const medOk = t !== "medletters" || ["clinician", "pharmacist"].includes(r.role);
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
    const notes = [];
    if (r.role === "admin") notes.push("Administrateur : accès à tout.");
    if (r.role === "member") notes.push("Compte en attente : choisissez un rôle pour ouvrir les accès.");
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
    return c;
  }

  async function refresh() {
    const y = window.scrollY;
    try { await load(); } catch (e) { return say("Chargement impossible : " + e.message, "error"); }
    render();
    window.scrollTo(0, y);
  }

  (async () => {
    if (!sb) return ($("ug-status").textContent = "Service indisponible.");
    const { data } = await sb.auth.getSession();
    if (!data.session) return (location.href = "/fr/the-hive.html");
    $("logout").addEventListener("click", async () => { await sb.auth.signOut(); location.href = "/fr/"; });
    state.me = data.session.user.id;
    const { data: role } = await sb.rpc("current_role_name");
    if (role !== "admin") return ($("ug-status").textContent = "Page réservée à l'administrateur.");
    try { await load(); } catch (e) { return ($("ug-status").textContent = "Chargement impossible : " + e.message); }
    $("ug-status").hidden = true;
    $("am-tool").hidden = false;
    $("am-q").addEventListener("input", render);
    $("am-role").addEventListener("change", render);
    render();
  })();
})();
