// Page « Mon compte » : données personnelles, adresse e-mail, mot de passe, sessions.
(function () {
  const cfg = window.ONCONIC_CONFIG || {};
  const sb = window.supabase && cfg.supabaseUrl ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey) : null;
  const fr = document.documentElement.lang === "fr";
  const base = fr ? "/fr" : "";
  const T = fr ? {
    saved: "Profil enregistré.",
    usernameTaken: "Ce pseudo est déjà pris.",
    usernameFormat: "Pseudo : 3 à 30 caractères, minuscules, chiffres, point, tiret ou tiret bas.",
    phoneFormat: "Numéro de téléphone invalide.",
    error: "Une erreur est survenue. Réessayez.",
    emailSame: "C'est déjà votre adresse actuelle.",
    emailSent: "Un lien de confirmation a été envoyé. Le changement prend effet après confirmation (selon les réglages, sur l'ancienne et la nouvelle adresse).",
    emailDone: "Votre adresse e-mail a été mise à jour.",
    pwShort: "Au moins 12 caractères.",
    pwMismatch: "Les mots de passe ne correspondent pas.",
    pwWrong: "Mot de passe actuel incorrect.",
    pwDone: "Mot de passe modifié.",
    signedOut: "Déconnexion de tous les appareils…",
    roles: { admin: "Administrateur", clinician: "Médecin", assistant: "Assistante médicale", pharmacist: "Pharmacien·ne", member: "Membre (accès en attente)" },
    none: "—"
  } : {
    saved: "Profile saved.",
    usernameTaken: "This username is already taken.",
    usernameFormat: "Username: 3 to 30 characters, lowercase letters, digits, dot, dash or underscore.",
    phoneFormat: "Invalid phone number.",
    error: "Something went wrong. Please try again.",
    emailSame: "This is already your current address.",
    emailSent: "A confirmation link has been sent. The change applies once confirmed (depending on settings, on both the old and the new address).",
    emailDone: "Your email address has been updated.",
    pwShort: "At least 12 characters.",
    pwMismatch: "Passwords do not match.",
    pwWrong: "Current password is incorrect.",
    pwDone: "Password changed.",
    signedOut: "Signing out of all devices…",
    roles: { admin: "Administrator", clinician: "Physician", assistant: "Medical assistant", pharmacist: "Pharmacist", member: "Member (access pending)" },
    none: "—"
  };

  const $ = (id) => document.getElementById(id);
  function msg(el, text, kind) { el.textContent = text; el.className = "form-msg" + (kind ? " " + kind : ""); }
  const clean = (v) => { const s = v.trim(); return s === "" ? null : s; };

  (async () => {
    if (!sb) return;
    // Retour depuis le lien de confirmation d'un changement d'adresse
    const h = new URLSearchParams(location.hash.slice(1));
    const { data } = await sb.auth.getSession();
    if (!data.session) return (location.href = base + (fr ? "/the-hive.html" : "/hive.html"));
    const user = data.session.user;

    if (h.get("type") === "email_change") msg($("email-msg"), T.emailDone, "ok");
    else if (h.get("message")) msg($("email-msg"), h.get("message"), "ok");
    if (location.hash) history.replaceState(null, "", location.pathname);

    const { data: p } = await sb.from("profiles")
      .select("first_name, last_name, username, phone, full_name, role, institution, show_in_events, contactable").eq("id", user.id).single();
    const prof = p || {};
    let first = prof.first_name, last = prof.last_name;
    if (!first && !last && prof.full_name) {
      // Ancien profil : seul le nom complet existe, on le propose découpé
      const parts = prof.full_name.trim().split(/\s+/);
      first = parts.shift(); last = parts.join(" ");
    }
    const f = $("profile-form");
    f.first_name.value = first || "";
    f.last_name.value = last || "";
    f.username.value = prof.username || "";
    f.phone.value = prof.phone || "";
    $("acc-role").textContent = T.roles[prof.role] || prof.role || T.none;
    $("acc-inst").textContent = prof.institution || T.none;
    $("acc-email").textContent = user.email;
    $("account").hidden = false;

    // Consentements « The Hive au congrès » : enregistrés à chaque clic ; le contact suppose l'affichage du nom
    const cf = $("consent-form");
    if (cf) {
      const sync = () => { cf.contactable.disabled = !cf.show_in_events.checked; if (!cf.show_in_events.checked) cf.contactable.checked = false; };
      cf.show_in_events.checked = !!prof.show_in_events;
      cf.contactable.checked = !!prof.contactable;
      sync();
      cf.addEventListener("change", async () => {
        sync();
        const out = $("consent-msg");
        const { error } = await sb.from("profiles").update({
          show_in_events: cf.show_in_events.checked, contactable: cf.contactable.checked
        }).eq("id", user.id);
        msg(out, error ? T.error : out.dataset.saved, error ? "error" : "ok");
      });
      if (h.has("ruche")) $("ruche").scrollIntoView();
    }

    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      const out = f.querySelector(".form-msg");
      const username = clean(f.username.value);
      const phone = clean(f.phone.value);
      if (username && !/^[a-z0-9._-]{3,30}$/.test(username)) return msg(out, T.usernameFormat, "error");
      if (phone && !/^\+?[0-9 ().-]{6,20}$/.test(phone)) return msg(out, T.phoneFormat, "error");
      const fn = clean(f.first_name.value), ln = clean(f.last_name.value);
      const { error } = await sb.from("profiles").update({
        first_name: fn, last_name: ln, username, phone,
        full_name: [fn, ln].filter(Boolean).join(" ") || null
      }).eq("id", user.id);
      if (error) return msg(out, error.code === "23505" ? T.usernameTaken : T.error, "error");
      msg(out, T.saved, "ok");
    });

    $("email-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const out = $("email-msg");
      const email = e.target.email.value.trim().toLowerCase();
      if (email === (user.email || "").toLowerCase()) return msg(out, T.emailSame, "error");
      const { error } = await sb.auth.updateUser({ email }, { emailRedirectTo: location.origin + location.pathname });
      if (error) return msg(out, error.message || T.error, "error");
      e.target.reset();
      msg(out, T.emailSent, "ok");
    });

    $("password-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const fpw = e.target;
      const out = fpw.querySelector(".form-msg");
      if (fpw.password.value.length < 12) return msg(out, T.pwShort, "error");
      if (fpw.password.value !== fpw.confirm.value) return msg(out, T.pwMismatch, "error");
      // Vérifie le mot de passe actuel avant de le changer
      const { error: authErr } = await sb.auth.signInWithPassword({ email: user.email, password: fpw.current.value });
      if (authErr) return msg(out, T.pwWrong, "error");
      const { error } = await sb.auth.updateUser({ password: fpw.password.value });
      if (error) return msg(out, error.message || T.error, "error");
      fpw.reset();
      msg(out, T.pwDone, "ok");
    });

    $("signout-all").addEventListener("click", async () => {
      msg($("session-msg"), T.signedOut);
      await sb.auth.signOut({ scope: "global" });
      location.href = base + "/";
    });
  })();
})();
