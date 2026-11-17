// Mon compte : choix des notifications reçues, par type et par canal (e-mail, notification sur l'appareil).
// Les types proposés viennent de la base selon le rôle et les outils du membre (my_notification_prefs) ; tout est activé par défaut.
(function () {
  const box = document.getElementById("notify-prefs");
  if (!box) return;
  const cfg = window.ONCONIC_CONFIG || {};
  const sb = window.supabase && cfg.supabaseUrl ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey) : null;
  if (!sb) return;
  const fr = document.documentElement.lang !== "en";

  const KINDS = {
    to_validate: [fr ? "Nouvelle demande d'absence à valider" : "New absence request to approve", fr ? "Envoyée par lot à chaque validateur concerné." : "Sent in batches to each relevant approver."],
    to_validate_change: [fr ? "Demande de modification ou de suppression d'une absence validée" : "Request to change or delete an approved absence", ""],
    reminder: [fr ? "Rappels des demandes en attente" : "Reminders for pending requests", fr ? "S'ajoute aux types ci-dessus : sans le type de base, aucun rappel." : "Applies on top of the types above: if the base type is off, no reminder."],
    to_direction: [fr ? "Visa de la direction (2e ligne)" : "Direction sign-off (second line)", fr ? "Les messages de la direction partent vers la boîte commune dès qu'un·e destinataire les souhaite." : "Direction messages go to the shared mailbox as long as one recipient wants them."],
    peer_rejected: [fr ? "Un autre validateur a refusé une demande que j'ai traitée" : "Another approver rejected a request I was asked about", ""],
    to_opinion: [fr ? "Pré-avis de la direction (facultatif)" : "Direction opinion (optional)", ""],
    approved: [fr ? "Mon absence est validée" : "My absence is approved", ""],
    rejected: [fr ? "Ma demande d'absence est refusée" : "My absence request is rejected", ""],
    change_approved: [fr ? "Ma demande de changement est acceptée" : "My change request is accepted", ""],
    change_rejected: [fr ? "Ma demande de changement est refusée" : "My change request is rejected", ""],
    direction_change: [fr ? "La direction a modifié ou annulé mon absence" : "The direction modified or cancelled my absence", ""],
    event_join: [fr ? "Un autre membre participe au même congrès que moi" : "Another member attends the same conference as me", ""],
  };
  const GROUPS = [
    ["validate", fr ? "Demandes d'absence à traiter" : "Absence requests to handle", ["to_validate", "to_validate_change", "peer_rejected"]],
    ["direction", fr ? "Direction" : "Direction", ["to_direction", "to_opinion"]],
    ["reminders", fr ? "Rappels" : "Reminders", ["reminder"]],
    ["mine", fr ? "Mes absences" : "My absences", ["approved", "rejected", "change_approved", "change_rejected", "direction_change"]],
    ["events", fr ? "Congrès" : "Conferences", ["event_join"]],
  ];
  const T = fr
    ? { title: "Choisir mes notifications", intro: "Tout est activé par défaut. Décochez ce que vous ne voulez pas recevoir ; vos demandes restent visibles dans l'application. La case « Notification » n'a d'effet que si les notifications sont activées sur cet appareil (ci-dessus).",
        email: "E-mail", push: "Notification", all: "Tout", none: "Pas d'e-mail", saved: "Enregistré.", error: "Enregistrement impossible. Réessayez.", reset: "Tout réactiver", resetDone: "Toutes les notifications sont réactivées." }
    : { title: "Choose my notifications", intro: "Everything is on by default. Untick what you do not want to receive; your requests stay visible in the app. The “Notification” box only matters if notifications are turned on for this device (above).",
        email: "Email", push: "Notification", all: "All", none: "No email", saved: "Saved.", error: "Could not save. Please try again.", reset: "Turn everything back on", resetDone: "All notifications are back on." };

  const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  let state = [];
  const out = el("p", "form-msg");
  out.setAttribute("role", "status"); out.setAttribute("aria-live", "polite");
  const say = (t, k) => { out.textContent = t; out.className = "form-msg" + (k ? " " + k : ""); };

  async function rpc(name, args) {
    const { data, error } = await sb.rpc(name, args || {});
    if (error) throw error;
    return data;
  }
  const find = (k) => state.find((x) => x.kind === k);

  async function setOne(kind, channel, on) {
    const d = await rpc("my_set_notification_pref", { p_kind: kind, p_channel: channel, p_on: on });
    state = d.kinds;
  }

  function render() {
    box.replaceChildren();
    if (!state.length) { box.hidden = true; return; }
    box.hidden = false;
    box.append(el("h3", "np-title", T.title), el("p", "muted account-note", T.intro));
    for (const [gid, gtitle, kinds] of GROUPS) {
      const rows = kinds.map(find).filter(Boolean);
      if (!rows.length) continue;
      const table = el("table", "np-table");
      table.append(el("caption", "np-caption", gtitle));
      const head = el("tr");
      head.append(el("th", "np-label", ""));
      for (const ch of ["email", "push"]) {
        const th = el("th", "np-ch");
        th.scope = "col";
        const avail = rows.filter((r) => r[ch] !== null);
        if (avail.length) {
          const all = document.createElement("input");
          all.type = "checkbox";
          all.checked = avail.every((r) => r[ch]);
          all.indeterminate = !all.checked && avail.some((r) => r[ch]);
          all.setAttribute("aria-label", `${gtitle} : ${ch === "email" ? T.email : T.push}, ${T.all}`);
          all.addEventListener("change", async () => {
            all.disabled = true;
            try { for (const r of avail) if (r[ch] !== all.checked) await setOne(r.kind, ch, all.checked); say(T.saved, "ok"); }
            catch (e) { say(T.error, "error"); try { state = (await rpc("my_notification_prefs")).kinds; } catch (_) { /* ignoré */ } }
            render();
          });
          const lab = el("label", "np-all");
          lab.append(all, document.createTextNode(" " + (ch === "email" ? T.email : T.push)));
          th.append(lab);
        } else th.textContent = ch === "email" ? T.email : T.push;
        head.append(th);
      }
      const thead = el("thead"); thead.append(head); table.append(thead);
      const tb = el("tbody");
      for (const r of rows) {
        const tr = el("tr");
        const [label, hint] = KINDS[r.kind];
        const td = el("td", "np-label");
        td.append(document.createTextNode(label));
        if (hint) td.append(el("span", "np-hint", hint));
        tr.append(td);
        for (const ch of ["email", "push"]) {
          const c = el("td", "np-ch");
          if (r[ch] === null) c.textContent = "—";
          else {
            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.checked = !!r[ch];
            cb.setAttribute("aria-label", `${label} : ${ch === "email" ? T.email : T.push}`);
            cb.addEventListener("change", async () => {
              cb.disabled = true;
              try { await setOne(r.kind, ch, cb.checked); say(T.saved, "ok"); }
              catch (e) { cb.checked = !cb.checked; say(T.error, "error"); }
              render();
            });
            c.append(cb);
          }
          tr.append(c);
        }
        tb.append(tr);
      }
      table.append(tb);
      const wrap = el("div", "np-wrap"); wrap.append(table);
      box.append(wrap);
    }
    const reset = el("button", "btn btn-outline", T.reset);
    reset.type = "button";
    reset.addEventListener("click", async () => {
      try { state = (await rpc("my_reset_notification_prefs")).kinds; render(); say(T.resetDone, "ok"); }
      catch (e) { say(T.error, "error"); }
    });
    box.append(reset, out);
  }

  (async () => {
    try {
      const { data } = await sb.auth.getSession();
      if (!data || !data.session) return;
      state = (await rpc("my_notification_prefs")).kinds || [];
      render();
    } catch (e) { /* réglages indisponibles (fonction non installée) : la case générale reste seule */ }
  })();
})();
