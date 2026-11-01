// Connexion, mot de passe oublié, formulaires et protection de l'espace « Hive ».
// Dépend de config.js et de supabase-js (chargé par CDN dans les pages concernées).
(function () {
  const cfg = window.ONCONIC_CONFIG || {};
  const lang = document.documentElement.lang === "fr" ? "fr" : "en";
  const base = lang === "fr" ? "/fr" : "";

  const T = {
    en: {
      notConfigured: "The member area is not open yet.",
      badLogin: "Incorrect email or password.",
      enterEmail: "Enter your email address above first.",
      resetSent: "If an account exists for this address, a reset link has been sent.",
      pwShort: "At least 12 characters.",
      pwMismatch: "Passwords do not match.",
      pwUpdated: "Password updated. Redirecting…",
      linkExpired: "This link is invalid or has expired. Request a new one from the sign-in page (Forgot password?).",
      sent: "Thank you. We will get back to you shortly.",
      error: "Something went wrong. Please try again or write to contact@onconic.ch."
    },
    fr: {
      notConfigured: "L'espace membres n'est pas encore ouvert.",
      badLogin: "Adresse e-mail ou mot de passe incorrect.",
      enterEmail: "Indiquez d'abord votre adresse e-mail ci-dessus.",
      resetSent: "Si un compte existe pour cette adresse, un lien de réinitialisation a été envoyé.",
      pwShort: "Au moins 12 caractères.",
      pwMismatch: "Les mots de passe ne correspondent pas.",
      pwUpdated: "Mot de passe modifié. Redirection…",
      linkExpired: "Ce lien est invalide ou a expiré. Demandez-en un nouveau depuis la page de connexion (Mot de passe oublié ?).",
      sent: "Merci. Nous revenons vers vous rapidement.",
      error: "Une erreur est survenue. Réessayez ou écrivez à contact@onconic.ch."
    }
  }[lang];

  const ready = cfg.supabaseUrl && cfg.supabaseAnonKey && window.supabase;
  const sb = ready ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey) : null;

  function msg(el, text, kind) {
    if (!el) return;
    el.textContent = text;
    el.className = "form-msg" + (kind ? " " + kind : "");
  }

  // Formulaire de connexion
  const login = document.getElementById("login-form");
  if (login) {
    const out = login.querySelector(".form-msg");
    if (sb) sb.auth.getSession().then(({ data }) => { if (data.session) location.href = base + "/app/"; });

    login.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!sb) return msg(out, T.notConfigured, "error");
      const { error } = await sb.auth.signInWithPassword({
        email: login.email.value.trim(),
        password: login.password.value
      });
      if (error) return msg(out, T.badLogin, "error");
      location.href = base + "/app/";
    });

    const forgot = document.getElementById("forgot");
    forgot && forgot.addEventListener("click", async (e) => {
      e.preventDefault();
      if (!sb) return msg(out, T.notConfigured, "error");
      const email = login.email.value.trim();
      if (!email) return msg(out, T.enterEmail, "error");
      await sb.auth.resetPasswordForEmail(email, {
        redirectTo: "https://" + location.host + base + (lang === "fr" ? "/nouveau-mot-de-passe.html" : "/reset-password.html")
      });
      msg(out, T.resetSent, "ok"); // même message que le compte existe ou non
    });
  }

  // Nouveau mot de passe (lien reçu par e-mail)
  const reset = document.getElementById("reset-form");
  if (reset) {
    const out = reset.querySelector(".form-msg");
    if (/error_code=/.test(location.hash)) msg(out, T.linkExpired, "error");
    reset.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!sb) return msg(out, T.notConfigured, "error");
      const pw = reset.password.value;
      if (pw.length < 12) return msg(out, T.pwShort, "error");
      if (pw !== reset.confirm.value) return msg(out, T.pwMismatch, "error");
      const { error } = await sb.auth.updateUser({ password: pw });
      if (error) return msg(out, T.error, "error");
      msg(out, T.pwUpdated, "ok");
      setTimeout(() => (location.href = base + "/app/"), 1500);
    });
  }

  // Formulaire de contact / demande d'adhésion
  const contact = document.getElementById("contact-form");
  if (contact) {
    const out = contact.querySelector(".form-msg");
    const kind = new URLSearchParams(location.search).get("type");
    if (kind && contact.kind.querySelector(`option[value="${kind}"]`)) contact.kind.value = kind;

    contact.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (contact.website.value) return; // robot
      if (!sb) return msg(out, T.error + " [client]", "error");
      const { error } = await sb.functions.invoke("contact-request", {
        body: {
          kind: contact.kind.value,
          name: contact.name.value.trim(),
          email: contact.email.value.trim(),
          organisation: contact.organisation.value.trim(),
          message: contact.message.value.trim(),
          website: contact.website.value,
          lang
        }
      });
      if (error) {
        console.error("contact-request failed", error);
        return msg(out, T.error + " [" + ((error.context && error.context.status) || "network") + "]", "error");
      }
      contact.reset();
      msg(out, T.sent, "ok");
    });
  }

  // Espace connecté : redirige si pas de session, affiche les espaces selon le rôle
  const app = document.getElementById("hive-app");
  if (app) {
    (async () => {
      if (!sb) return (location.href = base + (lang === "fr" ? "/the-hive.html" : "/hive.html"));
      const { data } = await sb.auth.getSession();
      if (!data.session) return (location.href = base + (lang === "fr" ? "/the-hive.html" : "/hive.html"));

      const { data: profile } = await sb.from("profiles")
        .select("full_name, role, med_plus").eq("id", data.session.user.id).single();
      const role = profile ? profile.role : "member";
      // Accès réels par outil (rôle + exceptions posées par l'admin) ; repli sur le rôle si la fonction manque
      const { data: tools, error: toolsError } = await sb.rpc("my_tools");
      const myTools = toolsError ? null : tools || [];
      const plus = myTools ? myTools.includes("medletters") : role === "admin";
      // Le pharmacien cumule les droits du médecin et de l'assistante : leurs deux espaces sont les siens
      const has = (list) => role === "admin" || list.includes(role) || (role === "pharmacist" && (list.includes("clinician") || list.includes("assistant")));
      document.getElementById("user-name").textContent = (profile && profile.full_name) || data.session.user.email;

      // Alvéoles groupées par public : son propre espace d'abord ; l'espace de l'autre métier reste visible,
      // grisé, pour que chacun sache ce qui existe (accès réservé par la base de données de toute façon).
      const LOCKED = lang === "fr"
        ? { clinician: "Réservé aux médecins", assistant: "Réservé à l'admin" }
        : { clinician: "Physicians only", assistant: "Admin only" };
      const active = (role === "clinician" || role === "assistant") ? role : null; // pharmacien : aucun espace grisé
      app.querySelectorAll(".hive-group").forEach((group) => {
        const gid = group.dataset.group;
        const other = active && gid !== "common" && gid !== active;
        // Outils « médecin plus » : invisibles pour tous les autres, même grisés
        group.querySelectorAll("[data-plus]").forEach((el) => { if (!plus) el.remove(); });
        let anyAllowed = false;
        group.querySelectorAll("[data-roles]").forEach((el) => {
          const tool = el.dataset.tool;
          const allowed = tool && myTools ? myTools.includes(tool) : has(el.dataset.roles.split(" "));
          if (allowed && !el.classList.contains("hex-soon")) anyAllowed = true;
          el.hidden = !allowed && !other;
          if (!allowed && other) {
            el.classList.add("hex-locked");
            el.setAttribute("aria-disabled", "true");
            el.removeAttribute("href");
            const tag = el.querySelector(".hex-tag");
            if (tag) tag.textContent = LOCKED[gid];
          }
        });
        // Espace de l'autre métier grisé, sauf si l'admin y a ouvert un outil à ce membre
        group.classList.toggle("hive-group-other", !!other && !anyAllowed);
        group.hidden = ![...group.querySelectorAll(".hex")].some((el) => !el.hidden);
      });
      if (active) {
        const own = app.querySelector(`.hive-group[data-group="${active}"]`);
        if (own) own.parentNode.insertBefore(own, app.querySelector('.hive-group[data-group="common"]'));
      }
      app.hidden = false;

      document.getElementById("logout").addEventListener("click", async () => {
        await sb.auth.signOut();
        location.href = base + "/";
      });
    })();
  }
})();
