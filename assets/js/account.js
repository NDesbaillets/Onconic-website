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
    notifyOn: "Notifications activées sur cet appareil.",
    notifyOff: "Notifications désactivées sur cet appareil.",
    notifyDenied: "Les notifications sont bloquées pour ce site. Autorisez-les dans les réglages du navigateur ou de l'iPhone, puis réessayez.",
    notifyUnsupported: "Ce navigateur ne permet pas les notifications.",
    notifyIos: "Sur iPhone et iPad, ajoutez d'abord Onconic à l'écran d'accueil (Partager, puis « Sur l'écran d'accueil »), ouvrez l'app, puis revenez ici.",
    roles: { admin: "Administrateur", clinician: "Médecin assistant", cdc: "CDC (chef·fe de clinique)", cadre: "Médecin cadre", assistant: "Assistante médicale", pharmacist: "Pharmacien·ne", member: "Membre (accès en attente)" },
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
    notifyOn: "Notifications turned on for this device.",
    notifyOff: "Notifications turned off for this device.",
    notifyDenied: "Notifications are blocked for this site. Allow them in the browser or iPhone settings, then try again.",
    notifyUnsupported: "This browser does not support notifications.",
    notifyIos: "On iPhone and iPad, first add Onconic to your Home Screen (Share, then “Add to Home Screen”), open the app, then come back here.",
    roles: { admin: "Administrator", clinician: "Resident physician", cdc: "Senior registrar (CDC)", cadre: "Consultant physician (cadre)", assistant: "Medical assistant", pharmacist: "Pharmacist", member: "Member (access pending)" },
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
      .select("first_name, last_name, username, phone, lang, full_name, role, institution, show_in_events, contactable").eq("id", user.id).single();
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
    f.lang.value = prof.lang === "en" ? "en" : "fr";
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

    // Mes cliniques (médecins) : cliniques actuelles modifiables, changements programmés par l'admin en lecture seule
    if ($("clinics")) {
      const { data: mc } = await sb.rpc("my_clinics");
      if (mc && mc.editable) {
        const box = $("clinics-list");
        const mine = new Set(mc.clinics || []);
        for (const c of mc.options || []) {
          const lab = document.createElement("label");
          lab.className = "cg-check";
          const cb = document.createElement("input");
          cb.type = "checkbox"; cb.name = "clinic"; cb.value = c; cb.checked = mine.has(c);
          lab.append(cb, " " + c);
          box.append(lab);
        }
        const eu = (d) => String(d).slice(0, 10).split("-").reverse().join(".");
        const ch = $("clinics-changes");
        for (const x of mc.changes || []) {
          const p = document.createElement("p");
          p.className = "muted";
          p.textContent = (fr ? "Changement programmé par l'administration : à partir du " : "Change scheduled by the administration: from ") + eu(x.valid_from) + ", " +
            ((x.clinics || []).length ? x.clinics.join(", ") : (fr ? "aucune clinique" : "no clinic")) + ".";
          ch.append(p);
        }
        $("clinics-form").addEventListener("submit", async (e) => {
          e.preventDefault();
          const out = $("clinics-msg");
          const chosen = [...box.querySelectorAll('input[name="clinic"]:checked')].map((i) => i.value);
          const { error } = await sb.rpc("my_set_clinics", { p_clinics: chosen });
          msg(out, error ? T.error : (fr ? "Cliniques enregistrées." : "Clinics saved."), error ? "error" : "ok");
        });
        $("clinics").hidden = false;
        if (h.has("cliniques")) $("clinics").scrollIntoView();
      }
    }

    // Notifications push : « un autre membre participe au même congrès que moi » (réglage par appareil)
    const nf = $("notify-form");
    if (nf) (async () => {
      const box = nf.notify_events, out = $("notify-msg");
      const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
      const installed = navigator.standalone === true || (window.matchMedia && matchMedia("(display-mode: standalone)").matches);
      if (!("serviceWorker" in navigator && "PushManager" in window && "Notification" in window)) {
        box.disabled = true;
        return msg(out, ios && !installed ? T.notifyIos : T.notifyUnsupported, "");
      }
      const ready = () => Promise.race([navigator.serviceWorker.ready, new Promise((_, no) => setTimeout(() => no(new Error("sw")), 8000))]);
      const bytes = (s) => { const b = atob((s + "=".repeat((4 - s.length % 4) % 4)).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from(b, (c) => c.charCodeAt(0)); };
      const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
      const publicKey = async () => {
        const { data, error } = await sb.functions.invoke("notify-event-join", { body: { action: "public_key" } });
        if (error || !data || !data.publicKey) throw error || new Error("key");
        return bytes(data.publicKey);
      };
      // Abonne cet appareil (ou rafraîchit son abonnement) et l'enregistre côté serveur
      const subscribe = async (reg) => {
        const key = await publicKey();
        let sub = await reg.pushManager.getSubscription();
        if (sub && sub.options && sub.options.applicationServerKey && !same(new Uint8Array(sub.options.applicationServerKey), key)) {
          await sub.unsubscribe(); // clés serveur changées : nouvel abonnement
          sub = null;
        }
        if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
        const j = sub.toJSON();
        const { error } = await sb.rpc("push_subscribe", { p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth, p_ua: navigator.userAgent });
        if (error) throw error;
      };
      let reg;
      try { reg = await ready(); } catch (e) { box.disabled = true; return msg(out, T.notifyUnsupported, ""); }
      if (Notification.permission === "denied") msg(out, T.notifyDenied, "");
      else {
        const { data: me } = await sb.from("profiles").select("notify_events").eq("id", user.id).single();
        const sub = await reg.pushManager.getSubscription();
        if (sub && me && me.notify_events && Notification.permission === "granted") {
          box.checked = true;
          subscribe(reg).catch(() => {}); // rafraîchit l'abonnement sans bruit
        }
      }
      nf.addEventListener("change", async () => {
        box.disabled = true;
        msg(out, "", "");
        try {
          if (box.checked) {
            if (Notification.permission !== "granted") {
              const perm = await Notification.requestPermission();
              if (perm !== "granted") { box.checked = false; return msg(out, T.notifyDenied, "error"); }
            }
            await subscribe(await ready());
            const { error } = await sb.from("profiles").update({ notify_events: true }).eq("id", user.id);
            if (error) throw error;
            msg(out, T.notifyOn, "ok");
          } else {
            const sub = await (await ready()).pushManager.getSubscription();
            if (sub) {
              await sb.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
              await sub.unsubscribe();
            }
            // Plus aucun appareil : le consentement du compte est retiré
            const { count } = await sb.from("push_subscriptions").select("id", { count: "exact", head: true });
            if (!count) await sb.from("profiles").update({ notify_events: false }).eq("id", user.id);
            msg(out, T.notifyOff, "ok");
          }
        } catch (e) {
          box.checked = !box.checked;
          msg(out, T.error, "error");
        } finally { box.disabled = false; }
      });
    })();

    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      const out = f.querySelector(".form-msg");
      const username = clean(f.username.value);
      const phone = clean(f.phone.value);
      if (username && !/^[a-z0-9._-]{3,30}$/.test(username)) return msg(out, T.usernameFormat, "error");
      if (phone && !/^\+?[0-9 ().-]{6,20}$/.test(phone)) return msg(out, T.phoneFormat, "error");
      const fn = clean(f.first_name.value), ln = clean(f.last_name.value);
      const { error } = await sb.from("profiles").update({
        first_name: fn, last_name: ln, username, phone, lang: f.lang.value === "en" ? "en" : "fr",
        full_name: [fn, ln].filter(Boolean).join(" ") || null
      }).eq("id", user.id);
      if (error) return msg(out, error.code === "23505" ? T.usernameTaken : T.error, "error");
      msg(out, T.saved, "ok");
      // La page suit la langue choisie
      if ((f.lang.value === "en") === fr) setTimeout(() => (location.href = f.lang.value === "en" ? "/app/account.html" : "/fr/app/compte.html"), 800);
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

    $("logout").addEventListener("click", async () => {
      await sb.auth.signOut();
      location.href = base + "/";
    });
    $("signout-all").addEventListener("click", async () => {
      msg($("session-msg"), T.signedOut);
      await sb.auth.signOut({ scope: "global" });
      location.href = base + "/";
    });
  })();
})();
