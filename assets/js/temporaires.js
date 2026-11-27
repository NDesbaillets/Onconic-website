// Comptes temporaires : création par un cadre administratif (Edge Function temp-account), prolongation et fin d'accès.
(function () {
  const cfg = window.ONCONIC_CONFIG || {};
  const sb = window.supabase && cfg.supabaseUrl ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey) : null;
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  const pad = (n) => String(n).padStart(2, "0");
  const iso = (d) => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  const addDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return iso(d); };
  const fmt = (s) => (s ? String(s).slice(8, 10) + "." + String(s).slice(5, 7) + "." + String(s).slice(0, 4) : "");
  const fmtTs = (s) => (s ? new Date(s).toLocaleDateString("fr-CH") : "jamais");
  function say(node, text, kind) { node.textContent = text; node.className = "form-msg" + (kind ? " " + kind : ""); }

  const ERRORS = {
    invalid_email: "Adresse e-mail invalide.",
    invalid_name: "Prénom et nom sont nécessaires.",
    invalid_until: "La fin d'accès doit être comprise entre aujourd'hui et dans un an.",
    user_exists: "Un compte existe déjà avec cette adresse. S'il s'agit d'un ancien compte temporaire, prolongez-le dans la liste ci-dessous.",
    invite_failed: "L'invitation n'a pas pu être envoyée. Réessayez, ou choisissez le mot de passe provisoire.",
    forbidden: "Réservé aux cadres administratifs.",
    unauthorized: "Session expirée : reconnectez-vous."
  };

  async function load() {
    const { data, error } = await sb.rpc("temp_accounts");
    if (error) return say($("tmp-status"), "Chargement impossible : " + error.message, "error");
    const rows = data || [];
    const active = rows.filter((r) => r.active).length;
    $("tmp-count").textContent = rows.length ? `${active} actif${active > 1 ? "s" : ""}, ${rows.length - active} terminé${rows.length - active > 1 ? "s" : ""}.` : "Aucun compte temporaire pour l'instant.";
    // Comptes actifs d'abord, puis terminés ; dans chaque groupe, nom de famille (OnconicSort) après réception
    const byName = (list) => (window.OnconicSort ? window.OnconicSort.sortPeople(list, { mode: "family" }) : list);
    $("tmp-list").replaceChildren(...byName(rows.filter((r) => r.active)).concat(byName(rows.filter((r) => !r.active))).map(item));
  }

  function item(r) {
    const box = el("article", "tmp-item" + (r.active ? "" : " tmp-off"));
    const head = el("div", "tmp-head");
    head.append(el("strong", null, [r.first_name, r.last_name].filter(Boolean).join(" ") || r.email),
      el("span", "ug-badge " + (r.active ? "tmp-on" : "tmp-end"), r.active ? "actif jusqu'au " + fmt(r.access_until) : "terminé le " + fmt(r.access_until)));
    box.append(head);
    box.append(el("p", "tmp-meta", `${r.email} · créé le ${fmtTs(r.created_at)}${r.created_by_name ? " par " + r.created_by_name : ""} · dernière connexion : ${fmtTs(r.last_sign_in_at)}`));
    const row = el("div", "tmp-row");
    const lab = el("label", null, r.active ? "Nouvelle fin d'accès" : "Réactiver jusqu'au");
    const inp = el("input"); inp.type = "date"; inp.min = iso(new Date()); inp.max = addDays(366); inp.value = r.active ? r.access_until : addDays(28);
    lab.append(inp);
    const msg = el("p", "form-msg");
    const save = el("button", "btn btn-outline", r.active ? "Modifier" : "Réactiver"); save.type = "button";
    save.addEventListener("click", () => setUntil(r, inp.value, msg));
    row.append(lab, save);
    if (r.active) {
      const stop = el("button", "btn btn-outline", "Mettre fin maintenant"); stop.type = "button";
      stop.addEventListener("click", () => {
        if (confirm(`Mettre fin à l'accès de ${r.first_name || r.email} ? La personne est déconnectée et ne peut plus se reconnecter.`)) setUntil(r, addDays(-1), msg);
      });
      row.append(stop);
    }
    box.append(row, msg);
    return box;
  }

  async function setUntil(r, date, msg) {
    if (!date) return say(msg, "Choisissez une date.", "error");
    const { error } = await sb.rpc("temp_account_set_until", { p_user: r.id, p_until: date });
    if (error) return say(msg, error.message, "error");
    await load();
  }

  async function create(e) {
    e.preventDefault();
    const msg = $("tmp-msg"), btn = $("tmp-create");
    $("tmp-pass").hidden = true;
    const body = {
      first_name: $("tmp-first").value.trim(), last_name: $("tmp-last").value.trim(),
      email: $("tmp-email").value.trim(), access_until: $("tmp-until").value,
      mode: document.querySelector('input[name="tmp-mode"]:checked').value
    };
    if (!body.first_name || !body.last_name) return say(msg, ERRORS.invalid_name, "error");
    if (!$("tmp-email").checkValidity() || !body.email) return say(msg, ERRORS.invalid_email, "error");
    if (!body.access_until) return say(msg, ERRORS.invalid_until, "error");
    btn.disabled = true; say(msg, "Création…");
    const { data, error } = await sb.functions.invoke("temp-account", { body });
    btn.disabled = false;
    if (error) {
      let code = "";
      try { code = (await error.context.json()).error; } catch (x) { /* réponse non JSON */ }
      return say(msg, ERRORS[code] || "Création impossible (" + (code || "erreur réseau") + ").", "error");
    }
    const who = body.first_name + " " + body.last_name;
    say(msg, data.mode === "invite"
      ? `Compte créé pour ${who}, actif jusqu'au ${fmt(body.access_until)}. Une invitation a été envoyée à ${body.email}.`
      : `Compte créé pour ${who}, actif jusqu'au ${fmt(body.access_until)}.`, "ok");
    if (data.password) { $("tmp-pass-value").textContent = data.password; $("tmp-pass").hidden = false; }
    $("tmp-form").reset(); $("tmp-until").value = addDays(28);
    await load();
  }

  (async () => {
    if (!sb) return say($("tmp-status"), "Service indisponible.", "error");
    const { data } = await sb.auth.getSession();
    if (!data.session) return (location.href = "/fr/the-hive.html");
    $("logout").addEventListener("click", async () => { await sb.auth.signOut(); location.href = "/fr/"; });
    const { data: ok } = await sb.rpc("can_manage_temps");
    if (ok !== true) return say($("tmp-status"), "Cet outil est réservé aux cadres administratifs. Demandez à l'administrateur de vous attribuer cette fonction.");
    $("tmp-until").min = iso(new Date()); $("tmp-until").max = addDays(366); $("tmp-until").value = addDays(28);
    $("tmp-form").addEventListener("submit", create);
    $("tmp-pass-copy").addEventListener("click", async (e) => {
      try { await navigator.clipboard.writeText($("tmp-pass-value").textContent); e.target.textContent = "Copié"; } catch (x) { e.target.textContent = "Copie impossible"; }
    });
    $("tmp-status").hidden = true;
    $("tmp-tool").hidden = false;
    await load();
  })();
})();
