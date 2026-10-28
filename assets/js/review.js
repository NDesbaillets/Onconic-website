// Page de confirmation ouverte depuis l'e-mail de demande d'accès.
// Affiche la demande, puis exécute l'action seulement après clic sur « Confirmer »
// (les scanners de liens des messageries ouvrent les URL sans cliquer).
(function () {
  const cfg = window.ONCONIC_CONFIG || {};
  const sb = window.supabase && cfg.supabaseUrl ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey) : null;
  const q = new URLSearchParams(location.search);
  const link = { id: q.get("id"), action: q.get("action"), exp: q.get("exp"), sig: q.get("sig") };

  const ACTIONS = {
    invite_clinician: { title: "Inviter comme médecin", button: "Confirmer l'invitation (médecin)" },
    invite_assistant: { title: "Inviter comme assistante", button: "Confirmer l'invitation (assistante)" },
    decline: { title: "Refuser la demande", button: "Confirmer le refus" }
  };
  const ERRORS = {
    invalid_link: "Ce lien n'est pas valide.",
    expired: "Ce lien a expiré (7 jours). Invitez la personne depuis Supabase.",
    not_found: "Cette demande n'existe plus.",
    already_handled: "Cette demande a déjà été traitée.",
    user_exists: "Un compte existe déjà pour cette adresse. Modifiez son rôle dans Supabase (table profiles).",
    invite_failed: "L'invitation n'a pas pu être envoyée. Réessayez dans quelques minutes."
  };

  const out = document.getElementById("review-msg");
  const details = document.getElementById("review-details");
  const confirm = document.getElementById("review-confirm");
  const say = (text, kind) => { out.textContent = text; out.className = "form-msg" + (kind ? " " + kind : ""); };

  async function call(confirmed) {
    const { data, error } = await sb.functions.invoke("review-request", { body: { ...link, confirm: confirmed } });
    if (!error) return data;
    let code = "invite_failed";
    try { code = (await error.context.json()).error || code; } catch (_) { /* réponse non JSON */ }
    throw new Error(code);
  }

  if (!sb || !ACTIONS[link.action]) return say(ERRORS.invalid_link, "error");
  document.getElementById("review-title").textContent = ACTIONS[link.action].title;
  confirm.textContent = ACTIONS[link.action].button;
  if (link.action === "decline") confirm.classList.add("btn-outline");

  call(false).then(({ request }) => {
    document.getElementById("r-name").textContent = request.name;
    document.getElementById("r-email").textContent = request.email;
    document.getElementById("r-org").textContent = request.organisation || "—";
    document.getElementById("r-message").textContent = request.message;
    details.hidden = false;
    if (request.status !== "pending") {
      confirm.hidden = true;
      return say(ERRORS.already_handled, "ok");
    }
    say("");
  }).catch((e) => say(ERRORS[e.message] || ERRORS.invite_failed, "error"));

  confirm.addEventListener("click", async () => {
    confirm.disabled = true;
    say("Traitement…");
    try {
      const res = await call(true);
      confirm.hidden = true;
      say(res.status === "declined"
        ? "Demande refusée."
        : "Invitation envoyée. La personne va recevoir un e-mail pour choisir son mot de passe.", "ok");
    } catch (e) {
      confirm.disabled = false;
      say(ERRORS[e.message] || ERRORS.invite_failed, "error");
    }
  });
})();
