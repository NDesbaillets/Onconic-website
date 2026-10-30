// Première connexion après invitation : mot de passe, coordonnées et consentements en une seule étape.
(function () {
  const cfg = window.ONCONIC_CONFIG || {};
  const sb = window.supabase && cfg.supabaseUrl ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey) : null;
  const fr = document.documentElement.lang === "fr";
  const base = fr ? "/fr" : "";
  const T = fr ? {
    expired: "Ce lien d'invitation est invalide ou a expiré. Demandez un nouveau lien avec « Mot de passe oublié ? » sur la page de connexion de The Hive.",
    pwShort: "Le mot de passe doit compter au moins 12 caractères.",
    pwMismatch: "Les mots de passe ne correspondent pas.",
    names: "Indiquez votre prénom et votre nom.",
    phone: "Numéro de téléphone invalide (ex. +41 79 123 45 67).",
    saving: "Activation…",
    error: "Une erreur est survenue. Réessayez.",
    done: "Bienvenue ! Redirection vers The Hive…"
  } : {
    expired: "This invitation link is invalid or has expired. Request a new link with “Forgot password?” on The Hive sign-in page.",
    pwShort: "The password must be at least 12 characters long.",
    pwMismatch: "Passwords do not match.",
    names: "Please enter your first and last name.",
    phone: "Invalid phone number (e.g. +41 79 123 45 67).",
    saving: "Activating…",
    error: "Something went wrong. Please try again.",
    done: "Welcome! Taking you to The Hive…"
  };
  const $ = (id) => document.getElementById(id);
  const msg = (el, text, kind) => { el.textContent = text; el.className = "form-msg" + (kind ? " " + kind : ""); };

  (async () => {
    const status = $("welcome-status"), f = $("welcome-form");
    const expired = () => {
      const a = document.createElement("a");
      a.href = base + (fr ? "/the-hive.html" : "/hive.html");
      a.textContent = "The Hive";
      msg(status, T.expired + " ", "error");
      status.append(a);
    };
    if (!sb || /error_code=/.test(location.hash)) return expired();
    // supabase-js lit le jeton de l'invitation dans l'adresse et ouvre la session
    const { data } = await sb.auth.getSession();
    if (!data.session) return expired();
    const user = data.session.user;
    if (location.hash) history.replaceState(null, "", location.pathname);

    const { data: p } = await sb.from("profiles").select("first_name, last_name, full_name, phone, show_in_events, contactable").eq("id", user.id).single();
    const prof = p || {};
    const full = (prof.full_name || (user.user_metadata || {}).full_name || "").trim().split(/\s+/);
    f.first_name.value = prof.first_name || (full.length > 1 ? full[0] : "");
    f.last_name.value = prof.last_name || (full.length > 1 ? full.slice(1).join(" ") : full[0] || "");
    f.phone.value = prof.phone || "";
    f.show_in_events.checked = !!prof.show_in_events;
    f.contactable.checked = !!prof.contactable;
    const sync = () => { f.contactable.disabled = !f.show_in_events.checked; if (!f.show_in_events.checked) f.contactable.checked = false; };
    sync();
    f.show_in_events.addEventListener("change", sync);
    status.hidden = true;
    f.hidden = false;
    f.password.focus();

    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      const out = $("welcome-msg");
      const pw = f.password.value;
      const first = f.first_name.value.trim(), last = f.last_name.value.trim(), phone = f.phone.value.trim();
      if (pw.length < 12) return msg(out, T.pwShort, "error");
      if (pw !== f.confirm.value) return msg(out, T.pwMismatch, "error");
      if (!first || !last) return msg(out, T.names, "error");
      if (phone && !/^\+?[0-9 ().-]{6,20}$/.test(phone)) return msg(out, T.phone, "error");
      const btn = f.querySelector('button[type="submit"]');
      btn.disabled = true;
      msg(out, T.saving);
      const { error: pwError } = await sb.auth.updateUser({ password: pw });
      if (pwError) { btn.disabled = false; return msg(out, pwError.message || T.error, "error"); }
      const { error } = await sb.from("profiles").update({
        first_name: first, last_name: last, full_name: `${first} ${last}`, phone: phone || null,
        show_in_events: f.show_in_events.checked, contactable: f.contactable.checked
      }).eq("id", user.id);
      if (error) { btn.disabled = false; return msg(out, T.error, "error"); }
      msg(out, T.done, "ok");
      setTimeout(() => (location.href = base + "/app/"), 1200);
    });
  })();
})();
