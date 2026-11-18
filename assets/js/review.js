// Page ouverte depuis l'e-mail de demande d'accès.
// « review » (16.11.2026) : l'admin connecté choisit le rôle, l'institution, les cliniques, la validation des absences
// et les outils ; l'invitation part seulement après clic (les scanners de liens des messageries ouvrent les URL sans cliquer).
// Les réglages passent par les mêmes fonctions de la base que la page « Membres et accès ».
(function () {
  const cfg = window.ONCONIC_CONFIG || {};
  const sb = window.supabase && cfg.supabaseUrl ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey) : null;
  const $ = (id) => document.getElementById(id);
  const q = new URLSearchParams(location.search);
  const link = { id: q.get("id"), action: q.get("action"), exp: q.get("exp"), sig: q.get("sig") };

  const ACTIONS = {
    review: { title: "Examiner la demande d'accès" },
    invite_clinician: { title: "Inviter comme médecin", button: "Confirmer l'invitation (médecin)" },
    invite_assistant: { title: "Inviter comme assistante", button: "Confirmer l'invitation (assistante)" },
    invite_pharmacist: { title: "Inviter comme pharmacien·ne", button: "Confirmer l'invitation (pharmacien·ne)" },
    decline: { title: "Refuser la demande", button: "Confirmer le refus" }
  };
  const ERRORS = {
    invalid_link: "Ce lien n'est pas valide.",
    expired: "Ce lien a expiré (7 jours). Invitez la personne depuis Supabase.",
    not_found: "Cette demande n'existe plus.",
    already_handled: "Cette demande a déjà été traitée.",
    user_exists: "Un compte existe déjà pour cette adresse : réglez son rôle dans « Membres et accès ».",
    invite_failed: "L'invitation n'a pas pu être envoyée. Réessayez dans quelques minutes.",
    login_required: "Session expirée : reconnectez-vous.",
    forbidden: "Réservé aux administrateurs et à la direction.",
    admin_only_role: "Seul un administrateur donne les rôles admin et direction.",
    invalid_role: "Rôle invalide."
  };
  const ROLES = [["clinician", "Médecin assistant"], ["cdc", "CDC (chef·fe de clinique)"], ["cadre", "Médecin cadre"], ["assistant", "Assistante médicale"],
    ["nurse", "Infirmier·ère"], ["pharmacist", "Pharmacien·ne"], ["direction", "Admin de direction"], ["admin", "Administrateur"]];
  const ROLE_NOTE = {
    clinician: "Médecin : choisissez ses cliniques de rattachement.",
    cdc: "CDC : droits d'un médecin, plus la gestion des fiches Key trials des cliniques cochées.",
    cadre: "Médecin cadre : droits d'un CDC, plus la validation des absences s'il ou elle est validateur·trice.",
    assistant: "Assistante médicale.",
    nurse: "Infirmier·ère : Durée, Key trials, Formation et annuaires.",
    pharmacist: "Pharmacien·ne : droits médecin et assistante, et administration de Lettres d'assurance, Limitations LS et Durée.",
    direction: "Admin de direction : gère les membres, le calendrier commun et les annuaires, vise les absences en 2e ligne.",
    admin: "Administrateur : accès à tout."
  };
  const TOOLS = [["congres", "Congrès"], ["trials", "Key trials"], ["lettres", "Lettres d'assurance"], ["limitations", "Limitations LS"],
    ["duree", "Durée de traitement"], ["absences", "Absences"], ["medletters", "Lettres médicales"]];
  const CLINICS = ["Sénologie", "Gynécologie", "Urologie", "Thoracique", "Neuro-oncologie", "Mélanome", "GI tube", "GI solide", "ORL", "Sarcomes", "Rad-Inter", "ION", "UTOH"];
  const ABS_CLINICS = CLINICS.concat(["Plateforme"]);
  const DOCTORS = ["clinician", "cdc", "cadre"];
  // Droits par défaut, identiques à tool_allowed() en base (sans exception)
  function defaultTool(role, chuv, t) {
    const doc = DOCTORS.includes(role);
    switch (t) {
      case "absences": return chuv && (doc || role === "pharmacist");
      case "congres": case "limitations": return doc || role === "pharmacist";
      case "trials": return doc || role === "pharmacist" || role === "nurse";
      case "lettres": return role === "pharmacist" || (chuv && (doc || role === "assistant"));
      case "duree": return role === "pharmacist" || (chuv && (doc || role === "assistant" || role === "nurse"));
      default: return false;
    }
  }

  const out = $("review-msg"), details = $("review-details"), confirmBtn = $("review-confirm");
  const say = (text, kind) => { out.textContent = text; out.className = "form-msg" + (kind ? " " + kind : ""); };
  const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  const st = { me: null, request: null, validators: {} };

  async function call(confirmed, extra) {
    const { data, error } = await sb.functions.invoke("review-request", { body: { ...link, ...(extra || {}), confirm: confirmed } });
    if (!error) return data;
    let code = "invite_failed";
    try { code = (await error.context.json()).error || code; } catch (_) { /* réponse non JSON */ }
    throw new Error(code);
  }

  function checks(box, list, name) {
    box.replaceChildren(...list.map((v) => {
      const lab = el("label", "rv-check"); const cb = el("input"); cb.type = "checkbox"; cb.name = name; cb.value = v;
      lab.append(cb, el("span", null, v)); return lab;
    }));
  }
  const picked = (box) => [...box.querySelectorAll("input:checked")].map((c) => c.value);

  function renderTools() {
    const role = $("rv-role").value, chuv = document.querySelector('input[name="rv-inst"]:checked').value === "CHUV";
    const fixed = role === "admin" || role === "direction";
    $("rv-tools-box").hidden = fixed; $("rv-fixed").hidden = !fixed;
    $("rv-tools").replaceChildren(...TOOLS.filter(([t]) => t !== "medletters" || (st.me === "admin" && (DOCTORS.includes(role) || role === "pharmacist")))
      .map(([t, label]) => {
        const lab = el("label", "rv-check"); const cb = el("input"); cb.type = "checkbox"; cb.value = t;
        cb.checked = defaultTool(role, chuv, t);
        if (t === "absences" && !chuv) { cb.disabled = true; cb.checked = false; lab.title = "Absences : réservé aux membres du CHUV."; }
        lab.append(cb, el("span", null, label)); return lab;
      }));
  }
  function renderRole() {
    const role = $("rv-role").value;
    $("rv-role-note").textContent = ROLE_NOTE[role];
    $("rv-clinics-box").hidden = !DOCTORS.includes(role);
    $("rv-kt-box").hidden = !(role === "cdc" || role === "cadre");
    $("rv-val-box").hidden = !(role === "cadre" || role === "direction");
    renderTools();
  }

  async function showForm() {
    const { data: s } = await sb.auth.getSession();
    if (!s.session) {
      $("review-login-link").href = "/fr/the-hive.html?next=" + encodeURIComponent(location.pathname + location.search);
      $("review-login").hidden = false;
      return;
    }
    const { data: role } = await sb.rpc("current_role_name");
    if (role !== "admin" && role !== "direction") return say(ERRORS.forbidden, "error");
    st.me = role;
    const { data: conf } = await sb.rpc("admin_absence_config");
    for (const c of (conf && conf.clinics) || []) st.validators[c.clinic] = c.validators || [];
    $("rv-role").replaceChildren(...ROLES.map(([v, l]) => { const o = el("option", null, l); o.value = v; o.disabled = role !== "admin" && (v === "admin" || v === "direction"); return o; }));
    $("rv-role").value = "clinician";
    const r = st.request, chuvGuess = /chuv/i.test(r.email + " " + (r.organisation || ""));
    document.querySelector(`input[name="rv-inst"][value="${chuvGuess ? "CHUV" : ""}"]`).checked = true;
    checks($("rv-clinics"), ABS_CLINICS, "rv-c");
    checks($("rv-kt"), CLINICS, "rv-k");
    checks($("rv-val-clinics"), Object.keys(st.validators).length ? Object.keys(st.validators) : ABS_CLINICS, "rv-v");
    $("rv-val").addEventListener("change", () => { $("rv-val-clinics").hidden = !$("rv-val").checked; });
    $("rv-role").addEventListener("change", renderRole);
    for (const r2 of document.querySelectorAll('input[name="rv-inst"]')) r2.addEventListener("change", renderTools);
    renderRole();
    $("review-form").hidden = false;
    $("review-form").addEventListener("submit", submit);
  }

  async function submit(e) {
    e.preventDefault();
    const role = $("rv-role").value, institution = document.querySelector('input[name="rv-inst"]:checked').value;
    const label = ROLES.find(([v]) => v === role)[1];
    if (!confirm(`Inviter ${st.request.name} comme « ${label} » ?`)) return;
    $("rv-submit").disabled = true; say("Invitation…");
    let res;
    try { res = await call(true, { role, institution }); }
    catch (x) { $("rv-submit").disabled = false; return say(ERRORS[x.message] || ERRORS.invite_failed, "error"); }
    const uid = res.user_id, done = [], fail = [];
    const step = async (what, fn) => { const { error } = await fn(); (error ? fail : done).push(error ? what + " : " + error.message : what); };
    if (!res.role_set) fail.push("Rôle non enregistré : réglez-le dans « Membres et accès ».");
    else {
      done.push("Rôle : " + label + (institution ? " (CHUV)" : " (hors CHUV)"));
      if (DOCTORS.includes(role) && picked($("rv-clinics")).length)
        await step("Cliniques : " + picked($("rv-clinics")).join(", "), () => sb.rpc("admin_set_clinics", { p_user: uid, p_clinics: picked($("rv-clinics")) }));
      if ((role === "cdc" || role === "cadre") && picked($("rv-kt")).length)
        await step("Key trials : " + picked($("rv-kt")).join(", "), () => sb.rpc("admin_set_cdc_clinics", { p_user: uid, p_clinics: picked($("rv-kt")) }));
      if ((role === "cadre" || role === "direction") && $("rv-val").checked) {
        await step("Validateur·trice des absences", () => sb.rpc("admin_set_absence_validator", { p_user: uid, p_on: true }));
        for (const c of picked($("rv-val-clinics")))
          await step("Valide les absences de " + c, () => sb.rpc("admin_set_absence_validators", { p_clinic: c, p_users: [...new Set((st.validators[c] || []).concat(uid))] }));
      }
      if (role !== "admin" && role !== "direction")
        for (const cb of $("rv-tools").querySelectorAll("input")) {
          if (cb.disabled && !cb.checked) continue;
          const name = TOOLS.find(([t]) => t === cb.value)[1];
          if (cb.value === "medletters" && !cb.checked) continue;
          await step(name + (cb.checked ? " ouvert" : " fermé"), () => sb.rpc("admin_set_tool", { p_user: uid, p_tool: cb.value, p_allowed: cb.checked }));
        }
    }
    $("review-form").hidden = true;
    say(fail.length ? "Invitation envoyée, mais certains réglages n'ont pas pu être appliqués." : "Invitation envoyée. La personne va recevoir un e-mail pour choisir son mot de passe.", fail.length ? "error" : "ok");
    const ul = el("ul", "rv-result");
    done.forEach((t) => ul.append(el("li", null, "✓ " + t)));
    fail.forEach((t) => ul.append(el("li", null, "✗ " + t)));
    const a = el("a", null, "Ouvrir sa fiche dans « Membres et accès »"); a.href = "/admin/membres.html#u=" + encodeURIComponent(uid);
    const li = el("li"); li.append(a); ul.append(li);
    out.after(ul);
  }

  if (!sb || !ACTIONS[link.action]) return say(ERRORS.invalid_link, "error");
  $("review-title").textContent = ACTIONS[link.action].title;
  if (link.action === "review") confirmBtn.hidden = true;
  else {
    confirmBtn.textContent = ACTIONS[link.action].button;
    if (link.action === "decline") confirmBtn.classList.add("btn-outline");
  }

  call(false).then(async ({ request }) => {
    st.request = request;
    $("r-name").textContent = request.name;
    $("r-email").textContent = request.email;
    $("r-org").textContent = request.organisation || "—";
    $("r-message").textContent = request.message;
    details.hidden = false;
    if (request.status !== "pending") { confirmBtn.hidden = true; return say(ERRORS.already_handled, "ok"); }
    say("");
    if (link.action === "review") await showForm();
  }).catch((e) => say(ERRORS[e.message] || ERRORS.invite_failed, "error"));

  confirmBtn.addEventListener("click", async () => {
    confirmBtn.disabled = true;
    say("Traitement…");
    try {
      const res = await call(true);
      confirmBtn.hidden = true;
      say(res.status === "declined" ? "Demande refusée." : "Invitation envoyée. La personne va recevoir un e-mail pour choisir son mot de passe.", "ok");
    } catch (e) {
      confirmBtn.disabled = false;
      say(ERRORS[e.message] || ERRORS.invite_failed, "error");
    }
  });
})();
