// Oncoodle : sondages de dates (créneaux, oui / peut-être / non) et de participation, destinataires par clinique, fonction ou personne.
// Toutes les données passent par des fonctions SQL (oncoodle_*) qui contrôlent l'appelant ; aucune table n'est lue directement.
(function () {
  const C = window.OncoodleCore;
  const cfg = window.ONCONIC_CONFIG || {};
  const sb = window.supabase && cfg.supabaseUrl ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey) : null;

  const CLINICS = ["Sénologie", "Gynécologie", "Urologie", "Thoracique", "Neuro-oncologie", "Mélanome", "Lower GI", "Upper GI", "ORL", "Sarcomes", "Rad-Inter", "ION", "UTOH"];
  const ANSWERS = [["yes", "Oui"], ["maybe", "Peut-être"], ["no", "Non"]];
  const ANSWER_TEXT = { yes: "Oui", maybe: "Peut-être", no: "Non" };
  const SYMBOL = { yes: "✓", maybe: "?", no: "✗" };
  const TABS = [["todo", "À répondre"], ["open", "Ouverts"], ["mine", "Que j'organise"], ["closed", "Clos"]];
  const WEEK = [[1, "Lun"], [2, "Mar"], [3, "Mer"], [4, "Jeu"], [5, "Ven"], [6, "Sam"], [0, "Dim"]];

  const $ = (id) => document.getElementById(id);
  const goList = () => { if (location.hash && location.hash !== "#") location.hash = ""; else route(); };
  const state = { flash: "", list: [], tab: null, people: [], role: "", me: null, detail: null, answers: {}, comment: "", saving: false, form: null, previewTimer: 0, previewSeq: 0 };

  function el(tag, cls, txt) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }
  function button(label, cls, onClick) {
    const b = el("button", cls, label);
    b.type = "button";
    if (onClick) b.addEventListener("click", onClick);
    return b;
  }
  const badge = (txt, cls) => el("span", "ug-badge " + (cls || ""), txt);
  const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;
  const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const todayIso = () => { const t = new Date(); return C.iso(new Date(Date.UTC(t.getFullYear(), t.getMonth(), t.getDate()))); };
  function say(id, text, kind) { const m = $(id); m.textContent = text || ""; m.className = "form-msg" + (kind ? " " + kind : ""); }
  const fmtDeadline = (s) => {
    const d = new Date(s);
    const p = (n) => String(n).padStart(2, "0");
    return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} à ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const toLocalInput = (s) => {
    const d = new Date(s), p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  // ----- Appels -----
  async function call(name, args) {
    const { data, error } = await sb.rpc(name, args || {});
    if (error) throw new Error(error.code === "42501" ? "Accès refusé." : error.message);
    return data;
  }
  // Envoi immédiat des messages en file (sinon la file est vidée toutes les 5 minutes) ; jamais bloquant
  function kick() { try { sb.functions.invoke("notify-oncoodle", { body: {} }).catch(() => {}); } catch (e) { /* facultatif */ } }

  // ----- Liste -----
  async function loadList() {
    state.list = (await call("oncoodle_list")) || [];
  }
  const when = (p) => {
    if (p.status === "closed" && p.final_day) return `${C.fmtShort(p.final_day)}${p.final_start ? ", " + p.final_start : ""}`;
    if (!p.first_day) return "";
    return p.first_day === p.last_day ? C.fmtShort(p.first_day) : `${C.fmtShort(p.first_day)} → ${C.fmtShort(p.last_day)}`;
  };
  function renderTabs() {
    const box = $("oc-tabs");
    box.replaceChildren();
    const count = state.list.filter((p) => p.needs_answer).length;
    for (const [id, label] of TABS) {
      const b = el("button", "ug-chip", label + (id === "todo" && count ? ` (${count})` : ""));
      b.type = "button";
      b.setAttribute("aria-pressed", String(state.tab === id));
      b.addEventListener("click", () => { state.tab = id; renderList(); });
      box.append(b);
    }
  }
  const filters = {
    todo: (p) => p.needs_answer,
    open: (p) => p.status === "open",
    mine: (p) => p.is_creator,
    closed: (p) => p.status !== "open",
  };
  function renderList() {
    if (!state.tab) state.tab = state.list.some((p) => p.needs_answer) ? "todo" : "open";
    renderTabs();
    const rows = state.list.filter(filters[state.tab]);
    const ul = $("oc-list");
    ul.replaceChildren();
    $("oc-count").textContent = rows.length ? plural(rows.length, "sondage", "sondages") : "";
    if (!rows.length) {
      const li = el("li", "oc-empty");
      li.append(el("p", null, state.tab === "todo" ? "Aucune réponse n'est attendue de votre part." : "Aucun sondage ici pour le moment."));
      ul.append(li);
    }
    for (const p of rows) {
      const li = el("li");
      const b = el("button", "oc-card" + (p.needs_answer ? " need" : "") + (p.status === "closed" ? " closed" : "") + (p.status === "cancelled" ? " cancelled" : ""));
      b.type = "button";
      b.append(el("h3", null, p.title), el("span", "oc-when", when(p)));
      const meta = el("span", "oc-meta");
      meta.append(document.createTextNode(p.is_creator ? "Vous organisez" : `Organisé par ${p.creator}`));
      meta.append(document.createTextNode(`${p.n_responded} sur ${p.n_invited} ont répondu`));
      if (p.status === "open" && p.deadline) meta.append(document.createTextNode(`Avant le ${fmtDeadline(p.deadline)}`));
      if (p.needs_answer) meta.append(badge("Réponse attendue", "ug-warn"));
      else if (p.invited && p.answered && p.status === "open") meta.append(badge("Répondu"));
      if (p.status === "closed") meta.append(badge("Date retenue", "lt-marker"));
      if (p.status === "cancelled") meta.append(badge("Annulé"));
      if (p.kind === "rsvp") meta.append(badge("Participation"));
      b.append(meta);
      b.addEventListener("click", () => { location.hash = "p=" + p.id; });
      li.append(b);
      ul.append(li);
    }
  }

  // ----- Navigation -----
  function show(view) {
    $("oc-list-view").hidden = view !== "list";
    $("oc-detail-view").hidden = view !== "detail";
    $("oc-form-view").hidden = view !== "form";
    window.scrollTo(0, 0);
  }
  async function route() {
    const m = /^#p=(\d+)$/.exec(location.hash);
    if (m) return openDetail(Number(m[1]));
    try { await loadList(); } catch (e) { return say("oc-status", "Chargement impossible : " + e.message, "error"); }
    show("list");
    renderList();
  }

  // ----- Détail -----
  async function openDetail(id, note) {
    note = note || state.flash; state.flash = "";
    show("detail");
    const box = $("oc-detail");
    box.replaceChildren(el("p", "muted", "Chargement…"));
    try { state.detail = await call("oncoodle_get", { p_poll: id }); }
    catch (e) { box.replaceChildren(el("p", "form-msg error", e.message)); return; }
    const d = state.detail;
    state.answers = Object.assign({}, d.me ? d.me.votes : {});
    state.comment = d.me && d.me.comment ? d.me.comment : "";
    renderDetail(note);
  }
  function cond(o, d) {
    const out = [];
    const hol = C.holidayOf(o.day), wd = C.weekday(o.day);
    if (hol) out.push(["Jour férié : " + hol, "warn"]);
    else if (wd === 0 || wd === 6) out.push(["Week-end", "warn"]);
    if (o.mine_absent) out.push([o.mine_absent === "approved" ? "Vous êtes absent·e ce jour (Absences)" : "Vous avez une demande d'absence ce jour (en attente)", "warn"]);
    if (o.absent > 0) out.push([`${plural(o.absent, "invité absent", "invités absents")} (Absences)${o.absent_req ? `, dont ${o.absent_req} obligatoire${o.absent_req > 1 ? "s" : ""}` : ""}`, "warn"]);
    for (const l of o.cal || []) out.push(["Agenda commun : " + l, "warn"]);
    return out;
  }
  function tally(o) {
    const t = el("span", "oc-tally", `${o.yes} oui · ${o.maybe} peut-être · ${o.no} non`);
    if (o.req_no > 0) {
      t.append(document.createElement("br"));
      const w = el("span", "oc-warn", `${plural(o.req_no, "participant obligatoire refuse", "participants obligatoires refusent")}`);
      t.append(w);
    }
    return t;
  }
  function choice(optId, locked) {
    const g = el("div", "oc-choice");
    g.setAttribute("role", "group");
    g.setAttribute("aria-label", "Ma réponse");
    for (const [a, label] of ANSWERS) {
      const b = el("button", null, label);
      b.type = "button";
      b.dataset.a = a;
      b.disabled = locked;
      b.setAttribute("aria-pressed", String(state.answers[optId] === a));
      b.addEventListener("click", () => {
        state.answers[optId] = state.answers[optId] === a ? undefined : a;
        for (const x of g.querySelectorAll("button")) x.setAttribute("aria-pressed", String(state.answers[optId] === x.dataset.a));
      });
      g.append(b);
    }
    return g;
  }

  function renderDetail(note) {
    const d = state.detail, p = d.poll, box = $("oc-detail");
    box.replaceChildren();
    const rsvp = p.kind === "rsvp";
    const head = el("div", "oc-head");
    head.append(el("h2", null, p.title));
    const badges = el("div", "oc-badges");
    badges.append(badge(rsvp ? "Participation" : "Choix de date"));
    badges.append(badge(p.status === "open" ? (p.locked ? "Réponses closes" : "Ouvert") : p.status === "closed" ? "Date retenue" : "Annulé", p.status === "closed" ? "lt-marker" : p.locked ? "ug-warn" : ""));
    badges.append(badge(`${d.counts.responded} sur ${d.counts.invited} ont répondu`));
    if (p.deadline && p.status === "open") badges.append(badge(`Avant le ${fmtDeadline(p.deadline)}`, p.locked ? "ug-warn" : ""));
    head.append(badges);
    head.append(el("p", "muted", p.is_creator ? "Vous organisez ce sondage." : `Organisé par ${p.creator}.`));
    if (p.description) head.append(el("p", "oc-desc", p.description));
    if (p.location) head.append(el("p", null, "Lieu : " + p.location));
    box.append(head);
    if (note) box.append(el("p", "form-msg ok", note));

    const final = d.options.find((o) => o.id === p.final_option_id);
    if (p.status === "closed" && final) {
      const b = el("p", "oc-banner");
      b.append(el("strong", null, "Date retenue : "), document.createTextNode(`${C.fmtLong(final.day)}${final.start ? ", " + C.timeRange(final) : ""}`));
      if (p.final_message) { b.append(document.createElement("br"), document.createTextNode(p.final_message)); }
      box.append(b);
      box.append(button("Ajouter à mon agenda (.ics)", "btn btn-outline", () => downloadIcs(p, final)));
    } else if (p.status === "cancelled") {
      const b = el("p", "oc-banner warn");
      b.append(el("strong", null, "Sondage annulé."));
      if (p.final_message) b.append(document.createElement("br"), document.createTextNode(p.final_message));
      box.append(b);
    } else if (p.locked) {
      box.append(el("p", "oc-banner warn", p.is_creator ? "L'échéance est passée : les réponses sont closes. Choisissez la date retenue." : "L'échéance est passée : les réponses sont closes."));
    }

    // Tableau des créneaux
    const ranks = new Map(C.rank(d.options).map((r) => [r.id, r]));
    const anyAnswer = d.options.some((o) => o.yes + o.maybe + o.no > 0);
    const canAnswer = !!d.me && !p.locked;
    const wrap = el("div", "oc-table-wrap" + (rsvp ? " oc-big" : ""));
    const table = el("table", "oc-table");
    const cap = el("caption", "visually-hidden", rsvp ? "Date de l'événement" : "Créneaux proposés");
    table.append(cap);
    const hr = el("tr");
    hr.append(el("th", null, rsvp ? "Date" : "Créneau"), el("th", null, "Disponibilités"));
    if (d.me) hr.append(el("th", null, "Ma réponse"));
    if (p.is_creator && p.status === "open" && !rsvp) hr.append(el("th", null, "Choix"));
    const th = el("thead"); th.append(hr); table.append(th);
    const tb = el("tbody");
    for (const o of d.options) {
      const tr = el("tr", ranks.get(o.id).best && anyAnswer && p.status === "open" ? "best" : "");
      const td = el("td", "oc-day");
      td.append(document.createTextNode(C.fmtLong(o.day)));
      td.append(el("span", "oc-sub", C.timeRange(o)));
      if (ranks.get(o.id).best && anyAnswer && p.status === "open" && !rsvp) td.append(badge("Meilleur choix", "ug-warn"));
      if (o.id === p.final_option_id) td.append(badge("Retenu", "lt-marker"));
      tr.append(td);
      const info = el("td");
      info.append(tally(o));
      for (const [txt] of cond(o, d)) info.append(el("span", "oc-warn", txt));
      tr.append(info);
      if (d.me) {
        const mine = el("td");
        if (canAnswer) mine.append(choice(o.id, false));
        else mine.append(document.createTextNode(state.answers[o.id] ? ANSWER_TEXT[state.answers[o.id]] : "Pas de réponse"));
        tr.append(mine);
      }
      if (p.is_creator && p.status === "open" && !rsvp) {
        const c = el("td");
        c.append(button("Retenir", "btn btn-outline", () => closeDialog(o.id)));
        tr.append(c);
      }
      tb.append(tr);
    }
    table.append(tb);
    wrap.append(table);
    box.append(wrap);

    if (d.me && d.me.required) box.append(el("p", "ug-note", "Votre participation est demandée pour ce sondage (participant·e obligatoire)."));
    if (canAnswer) {
      const lab = el("label", "oc-comment", "Commentaire (facultatif)");
      const inp = el("input");
      inp.maxLength = 300; inp.value = state.comment; inp.autocomplete = "off";
      inp.placeholder = "ex. uniquement en visioconférence";
      inp.addEventListener("input", () => { state.comment = inp.value; });
      lab.append(inp);
      box.append(lab);
      const row = el("div", "btn-row");
      const save = button(d.me.responded ? "Mettre à jour mes réponses" : "Enregistrer mes réponses", "btn", saveAnswers);
      save.id = "oc-save";
      row.append(save);
      box.append(row, el("p", "form-msg", ""));
      box.lastChild.id = "oc-ans-msg";
      box.lastChild.setAttribute("role", "status");
      box.lastChild.setAttribute("aria-live", "polite");
    }

    renderOverview(box, d, rsvp);
    renderTools(box, d);
  }

  async function saveAnswers() {
    if (state.saving) return;
    const d = state.detail;
    const votes = d.options.map((o) => ({ option_id: o.id, answer: state.answers[o.id] || null }));
    if (!votes.some((v) => v.answer)) return say("oc-ans-msg", "Répondez à au moins un créneau.", "error");
    state.saving = true; $("oc-save").disabled = true;
    try {
      await call("oncoodle_vote", { p_poll: d.poll.id, p_votes: votes, p_comment: state.comment || null });
      await openDetail(d.poll.id, "Réponses enregistrées.");
    } catch (e) { say("oc-ans-msg", e.message, "error"); }
    state.saving = false;
    const b = $("oc-save"); if (b) b.disabled = false;
  }

  function renderOverview(box, d, rsvp) {
    const p = d.poll;
    if (!d.invitees.length) {
      if (!p.is_creator && p.visibility === "creator") box.append(el("p", "muted", "L'organisateur·trice garde les réponses nominatives confidentielles : seuls les totaux sont affichés."));
      return;
    }
    box.append(el("h3", null, "Réponses"));
    if (rsvp) {
      const o = d.options[0];
      const groups = [["yes", "Participent"], ["maybe", "Peut-être"], ["no", "Ne participent pas"], [null, "Pas encore répondu"]];
      for (const [a, label] of groups) {
        const who = d.invitees.filter((i) => (i.votes[o.id] || null) === a);
        const h = el("p", null);
        h.append(el("strong", null, `${label} (${who.length})`));
        if (who.length) h.append(document.createTextNode(" : " + who.map((i) => i.name + (i.required ? " ★" : "")).join(", ")));
        box.append(h);
      }
    } else {
      const wrap = el("div", "oc-table-wrap");
      const t = el("table", "oc-table oc-who");
      t.append(el("caption", "visually-hidden", "Réponses de chaque personne invitée"));
      const hr = el("tr");
      hr.append(el("th", null, "Personne"));
      for (const o of d.options) hr.append(el("th", null, C.optionLabel(o)));
      const th = el("thead"); th.append(hr); t.append(th);
      const tb = el("tbody");
      for (const i of d.invitees) {
        const tr = el("tr");
        const n = el("td", null, i.name);
        if (i.required) { n.append(document.createTextNode(" "), el("span", "oc-star", "★")); n.lastChild.setAttribute("title", "Participant·e obligatoire"); }
        if (!i.responded) n.append(el("span", "oc-sub", "Pas encore répondu"));
        tr.append(n);
        for (const o of d.options) {
          const a = i.votes[o.id] || "none";
          const c = el("td", "oc-cell " + a, a === "none" ? "–" : SYMBOL[a]);
          c.setAttribute("aria-label", a === "none" ? "Pas de réponse" : ANSWER_TEXT[a]);
          tr.append(c);
        }
        tb.append(tr);
      }
      t.append(tb); wrap.append(t); box.append(wrap);
    }
    const notes = d.invitees.filter((i) => i.comment);
    if (notes.length) {
      box.append(el("h3", null, "Commentaires"));
      const ul = el("ul", "oc-comments");
      for (const i of notes) { const li = el("li"); li.append(el("strong", null, i.name + " : "), document.createTextNode(i.comment)); ul.append(li); }
      box.append(ul);
    }
    box.append(el("p", "muted", "★ = participant·e obligatoire. Le meilleur choix tient compte d'abord des participants obligatoires, puis des « oui » (les « peut-être » comptent moitié), puis des absences."));
  }

  function renderTools(box, d) {
    const p = d.poll;
    if (!p.is_creator) return;
    box.append(el("h3", null, "Organisation"));
    const tools = el("div", "oc-tools");
    if (p.status === "open") {
      tools.append(button("Modifier", "btn btn-outline", () => openForm(d)));
      const waiting = d.invitees.filter((i) => !i.responded && i.id !== p.creator_id).length;
      const recent = p.reminded_at && Date.now() - new Date(p.reminded_at).getTime() < 12 * 3600e3;
      const r = button(`Relancer (${waiting} sans réponse)`, "btn btn-outline", remind);
      r.disabled = p.locked || !waiting || recent;
      if (recent) r.title = "Une relance a déjà été envoyée il y a moins de 12 heures.";
      tools.append(r);
      tools.append(button(p.kind === "rsvp" ? "Confirmer l'événement" : "Choisir la date et clôturer", "btn", () => closeDialog(null)));
      tools.append(button("Annuler le sondage", "btn btn-outline", cancelDialog));
    }
    if (p.status === "closed") tools.append(button("Rouvrir le sondage", "btn btn-outline", reopen));
    tools.append(button("Supprimer", "btn btn-outline lt-danger", deleteDialog));
    box.append(tools, el("p", "form-msg", ""));
    box.lastChild.id = "oc-tools-msg";
    box.lastChild.setAttribute("role", "status");
    box.lastChild.setAttribute("aria-live", "polite");
  }

  function downloadIcs(p, o) {
    const blob = new Blob([C.buildIcs({ id: p.id, title: p.title, location: p.location, day: o.day, start: o.start, end: o.end })], { type: "text/calendar;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "oncoodle.ics";
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // ----- Actions de l'organisateur -----
  let dlgHandler = null;
  function dialog(title, body, okLabel, handler) {
    $("oc-dlg-title").textContent = title;
    $("oc-dlg-body").replaceChildren(...body);
    $("oc-dlg-ok").textContent = okLabel;
    say("oc-dlg-msg", "");
    dlgHandler = handler;
    $("oc-dlg").showModal();
  }
  async function onDialogSubmit(ev) {
    ev.preventDefault();
    if (!dlgHandler) return;
    $("oc-dlg-ok").disabled = true;
    try { await dlgHandler(); $("oc-dlg").close(); }
    catch (e) { say("oc-dlg-msg", e.message, "error"); }
    $("oc-dlg-ok").disabled = false;
  }
  function closeDialog(optionId) {
    const d = state.detail, p = d.poll, rsvp = p.kind === "rsvp";
    const body = [];
    let sel = optionId;
    if (rsvp) {
      body.push(el("p", null, "Les invités reçoivent la confirmation et un fichier agenda."));
    } else {
      const ranks = C.rank(d.options);
      const best = ranks.find((r) => r.best);
      if (sel == null && best) sel = best.id;
      const list = el("div", "oc-dlg-list");
      list.setAttribute("role", "radiogroup");
      list.setAttribute("aria-label", "Créneau retenu");
      for (const o of d.options) {
        const lab = el("label", "cg-check");
        const r = el("input"); r.type = "radio"; r.name = "final"; r.value = String(o.id); r.checked = o.id === sel;
        r.addEventListener("change", () => { sel = o.id; });
        lab.append(r, document.createTextNode(`${C.fmtLong(o.day)}, ${C.timeRange(o)}  ·  ${o.yes} oui, ${o.maybe} peut-être, ${o.no} non`));
        list.append(lab);
      }
      body.push(el("p", null, "Choisissez le créneau retenu. Les invités reçoivent un e-mail avec un fichier agenda."), list);
    }
    const msgLab = el("label", null, "Message aux participants (facultatif, envoyé par e-mail)");
    const msg = el("textarea"); msg.maxLength = 500; msg.rows = 3;
    msgLab.append(msg);
    const calLab = el("label", "cg-check");
    const cal = el("input"); cal.type = "checkbox";
    const direct = state.role === "admin" || state.role === "direction";
    calLab.append(cal, document.createTextNode(direct ? "Ajouter l'événement à l'agenda commun (visible de tous dans le planning des absences, titre compris)" : "Proposer l'événement à la direction pour l'agenda commun (le titre serait visible de tous)"));
    body.push(msgLab, calLab);
    dialog(rsvp ? "Confirmer l'événement" : "Choisir la date et clôturer", body, rsvp ? "Confirmer" : "Clôturer et prévenir", async () => {
      if (!rsvp && !sel) throw new Error("Choisissez le créneau retenu.");
      await call("oncoodle_close", { p_poll: p.id, p_option: rsvp ? null : sel, p_message: msg.value.trim() || null, p_calendar: cal.checked });
      kick();
      await openDetail(p.id, "Sondage clos : les participants sont prévenus.");
    });
  }
  function cancelDialog() {
    const p = state.detail.poll;
    const lab = el("label", null, "Message aux invités (facultatif)");
    const msg = el("textarea"); msg.maxLength = 500; msg.rows = 3; lab.append(msg);
    dialog("Annuler le sondage", [el("p", null, "Les invités sont prévenus. Le sondage reste consultable puis disparaît après 180 jours."), lab], "Annuler le sondage", async () => {
      await call("oncoodle_cancel", { p_poll: p.id, p_message: msg.value.trim() || null });
      kick();
      await openDetail(p.id, "Sondage annulé.");
    });
  }
  function deleteDialog() {
    const p = state.detail.poll;
    dialog("Supprimer le sondage", [el("p", null, "Le sondage et toutes les réponses sont supprimés définitivement. Aucun message n'est envoyé : annulez plutôt le sondage pour prévenir les invités.")], "Supprimer", async () => {
      await call("oncoodle_delete", { p_poll: p.id });
      goList();
    });
  }
  async function remind() {
    const p = state.detail.poll;
    try {
      const n = await call("oncoodle_remind", { p_poll: p.id });
      kick();
      await openDetail(p.id, `${plural(n, "relance envoyée", "relances envoyées")} (entre 8 h et 19 h).`);
    } catch (e) { say("oc-tools-msg", e.message, "error"); }
  }
  async function reopen() {
    const p = state.detail.poll;
    try { await call("oncoodle_reopen", { p_poll: p.id }); kick(); await openDetail(p.id, "Sondage rouvert : les invités sont prévenus."); }
    catch (e) { say("oc-tools-msg", e.message, "error"); }
  }

  // ----- Formulaire (création et modification) -----
  const newForm = () => ({ mode: "create", pollId: null, kind: "slots", slots: [], rules: [{ clinics: [], roles: [] }], users: [], excl: [], includeMe: true, required: new Set(),
    current: [], removeUsers: new Set(), removeOptions: new Set(), template: "" });

  function fillTemplates() {
    const s = $("oc-template");
    for (const t of C.TEMPLATES) { const o = el("option", null, t.label); o.value = t.id; s.append(o); }
  }
  function openForm(detail) {
    const f = (state.form = newForm());
    const form = $("oc-form");
    form.reset();
    say("oc-form-msg", ""); say("g-msg", ""); say("oc-slots-msg", "");
    $("oc-form-title").textContent = detail ? "Modifier le sondage" : "Nouveau sondage";
    $("oc-submit").textContent = detail ? "Enregistrer les modifications" : "Envoyer le sondage";
    $("oc-template").value = "";
    $("oc-template").closest("label").hidden = !!detail;
    $("oc-kind").hidden = !!detail;
    $("oc-me-wrap").hidden = !!detail;
    $("oc-aud-legend").textContent = detail ? "Ajouter des destinataires" : "Destinataires";
    $("oc-current").hidden = !detail;
    $("g-from").value = todayIso();
    $("g-to").value = C.addDays(todayIso(), 14);
    $("g-starts").value = "12:00";
    $("g-dur").value = "60";
    f.genDays = new Set([1, 2, 3, 4, 5]);
    if (detail) {
      const p = detail.poll;
      f.mode = "edit"; f.pollId = p.id; f.kind = p.kind;
      form.elements.title.value = p.title;
      form.elements.description.value = p.description || "";
      form.elements.location.value = p.location || "";
      form.elements.visibility.value = p.visibility;
      form.elements.deadline.value = p.deadline ? toLocalInput(p.deadline) : "";
      f.slots = detail.options.map((o) => ({ id: o.id, day: o.day, start: o.start, end: o.end }));
      f.current = detail.invitees.length ? detail.invitees : [];
      f.rules = [];
      for (const i of f.current) if (i.required) f.required.add(i.id);
      f.initialRequired = new Set(f.required);
    } else {
      form.elements.kind.value = "slots";
    }
    renderKind();
    renderDays();
    renderSlots();
    renderRules();
    renderChips();
    renderCurrent();
    schedulePreview();
    show("form");
  }
  function renderKind() {
    const f = state.form, rsvp = f.kind === "rsvp";
    $("oc-gen").hidden = rsvp;
    $("oc-slots-legend").textContent = rsvp ? "Date de l'événement" : "Créneaux proposés (2 au minimum)";
    $("oc-manual-title").textContent = rsvp ? "Date et heure" : "Ajouter un créneau";
    $("m-add").textContent = rsvp ? "Définir la date" : "Ajouter";
  }
  function renderDays() {
    const box = $("g-days");
    box.replaceChildren();
    for (const [n, label] of WEEK) {
      const b = el("button", "ug-chip", label);
      b.type = "button";
      b.setAttribute("aria-pressed", String(state.form.genDays.has(n)));
      b.addEventListener("click", () => {
        const s = state.form.genDays;
        s.has(n) ? s.delete(n) : s.add(n);
        b.setAttribute("aria-pressed", String(s.has(n)));
      });
      box.append(b);
    }
  }
  function renderSlots() {
    const f = state.form, ul = $("oc-slots");
    ul.replaceChildren();
    const sorted = f.slots.slice().sort((a, b) => (a.day + (a.start || "")).localeCompare(b.day + (b.start || "")));
    for (const s of sorted) {
      const gone = s.id && f.removeOptions.has(s.id);
      const li = el("li", gone ? "gone" : "");
      li.append(el("span", null, `${C.fmtLong(s.day)}, ${C.timeRange(s)}${C.holidayOf(s.day) ? "  (jour férié)" : ""}${s.id ? "" : "  · nouveau"}`));
      const x = button(gone ? "Rétablir" : "×", "oc-x", () => {
        if (s.id) { gone ? f.removeOptions.delete(s.id) : f.removeOptions.add(s.id); }
        else f.slots.splice(f.slots.indexOf(s), 1);
        renderSlots();
      });
      x.setAttribute("aria-label", (gone ? "Rétablir " : "Retirer ") + `le créneau du ${C.fmtShort(s.day)}`);
      li.append(x);
      ul.append(li);
    }
    const n = f.slots.filter((s) => !(s.id && f.removeOptions.has(s.id))).length;
    say("oc-slots-msg", f.kind === "rsvp" ? (n ? "" : "Définissez la date de l'événement.") : `${plural(n, "créneau", "créneaux")}`);
    if (f.mode === "edit" && f.removeOptions.size) say("oc-slots-msg", `${plural(n, "créneau", "créneaux")}. Les réponses sur les créneaux retirés seront perdues.`, "error");
  }
  function addSlots(list) {
    const f = state.form;
    if (f.kind === "rsvp") f.slots = f.slots.filter((s) => s.id && f.removeOptions.has(s.id)).concat(list.slice(0, 1));
    else f.slots = C.mergeSlots(f.slots, list, 40 + f.removeOptions.size);
    renderSlots();
  }
  function onGenerate() {
    const f = state.form;
    const starts = $("g-starts").value.split(/[,;\s]+/).filter(Boolean);
    if (starts.some((s) => !/^([01]\d|2[0-3]):[0-5]\d$/.test(s))) return say("g-msg", "Heures au format 12:00, 12:30.", "error");
    const g = C.generateSlots({ from: $("g-from").value, to: $("g-to").value, weekdays: [...f.genDays], starts, duration: Number($("g-dur").value), skipHolidays: $("g-holidays").checked, today: todayIso(), max: 40 });
    if (g.error) return say("g-msg", g.error, "error");
    if (!g.slots.length) return say("g-msg", "Aucun créneau ne correspond à ces critères.", "error");
    const before = f.slots.length;
    addSlots(g.slots);
    say("g-msg", `${plural(f.slots.length - before, "créneau ajouté", "créneaux ajoutés")}${g.truncated ? " (limite de 40 atteinte)" : ""}.`, "ok");
  }
  function onManualAdd() {
    const day = $("m-day").value, st = $("m-start").value, en = $("m-end").value;
    if (!day) return say("oc-slots-msg", "Choisissez un jour.", "error");
    if (day < todayIso()) return say("oc-slots-msg", "Un créneau ne peut pas être dans le passé.", "error");
    if (!!st !== !!en) return say("oc-slots-msg", "Indiquez l'heure de début et de fin, ou aucune.", "error");
    if (st && en <= st) return say("oc-slots-msg", "L'heure de fin doit suivre l'heure de début.", "error");
    addSlots([{ day, start: st || null, end: en || null }]);
  }
  function applyTemplate() {
    const f = state.form, t = C.TEMPLATES.find((x) => x.id === $("oc-template").value);
    if (!t) return;
    const form = $("oc-form");
    f.kind = t.kind;
    form.elements.kind.value = t.kind;
    const known = C.TEMPLATES.map((x) => x.title);
    if (!form.elements.title.value.trim() || known.includes(form.elements.title.value)) form.elements.title.value = t.title;
    if (!form.elements.description.value.trim() || C.TEMPLATES.some((x) => x.description && x.description === form.elements.description.value)) form.elements.description.value = t.description;
    f.genDays = new Set(t.gen.weekdays);
    $("g-starts").value = t.gen.starts.join(", ");
    $("g-dur").value = String(t.gen.duration);
    if (t.kind === "rsvp") { $("m-start").value = t.gen.starts[0]; $("m-end").value = C.fromMin(C.toMin(t.gen.starts[0]) + t.gen.duration); }
    renderKind(); renderDays(); renderSlots();
  }

  // Destinataires : groupes, personnes, exclusions
  function renderRules() {
    const f = state.form, box = $("oc-rules");
    box.replaceChildren();
    f.rules.forEach((r, idx) => {
      const fs = el("fieldset", "oc-rule");
      fs.append(el("legend", null, `Groupe ${idx + 1}`));
      const all = el("label", "cg-check");
      const ca = el("input"); ca.type = "checkbox"; ca.checked = !!r.all;
      ca.addEventListener("change", () => { r.all = ca.checked; if (r.all) { r.clinics = []; r.roles = []; } renderRules(); schedulePreview(); });
      all.append(ca, document.createTextNode("Tous les membres de The Hive"));
      fs.append(all);
      if (!r.all) {
        fs.append(el("h4", null, "Cliniques (une ou plusieurs)"));
        const cl = el("div", "oc-opts");
        for (const c of CLINICS) cl.append(checkbox(c, r.clinics.includes(c), (on) => { toggle(r.clinics, c, on); schedulePreview(); }));
        fs.append(cl);
        fs.append(el("h4", null, "Fonctions (une ou plusieurs)"));
        const ro = el("div", "oc-opts");
        for (const k of C.ROLE_ORDER) ro.append(checkbox(C.ROLE_PLURAL[k], r.roles.includes(k), (on) => { toggle(r.roles, k, on); schedulePreview(); }));
        fs.append(ro);
        fs.append(el("p", "muted", "Clinique et fonction se combinent : seules les personnes qui répondent aux deux critères sont retenues. Laissez un critère vide pour ne pas le limiter. Les infirmier·ères et assistantes n'ont pas de clinique : choisissez-les par fonction."));
      }
      fs.append(button("Retirer ce groupe", "btn btn-outline", () => { f.rules.splice(idx, 1); renderRules(); schedulePreview(); }));
      box.append(fs);
    });
  }
  function checkbox(label, checked, onChange) {
    const lab = el("label", "cg-check");
    const i = el("input"); i.type = "checkbox"; i.checked = checked;
    i.addEventListener("change", () => onChange(i.checked));
    lab.append(i, document.createTextNode(label));
    return lab;
  }
  const toggle = (arr, v, on) => { const k = arr.indexOf(v); if (on && k < 0) arr.push(v); if (!on && k >= 0) arr.splice(k, 1); };

  function picker(inputId, listId, target, cls) {
    const input = $(inputId), list = $(listId);
    const hide = () => { list.hidden = true; list.replaceChildren(); };
    const update = () => {
      const q = norm(input.value);
      list.replaceChildren();
      if (q.length < 2) return void (list.hidden = true);
      const f = state.form, taken = new Set(f.users.concat(f.excl).map((u) => u.id).concat(f.current.map((c) => c.id)));
      const hits = state.people.filter((p) => !taken.has(p.id) && p.id !== state.me && norm(`${p.name} ${C.ROLE_SINGULAR[p.role] || ""} ${(p.clinics || []).join(" ")}`).includes(q)).slice(0, 8);
      for (const p of hits) {
        const li = el("li"), b = el("button", null, `${p.name}  ·  ${C.ROLE_SINGULAR[p.role] || p.role}${p.clinics && p.clinics.length ? " · " + p.clinics.join(", ") : ""}`);
        b.type = "button";
        b.addEventListener("click", () => { state.form[target].push({ id: p.id, name: p.name }); input.value = ""; hide(); renderChips(); schedulePreview(); input.focus(); });
        li.append(b); list.append(li);
      }
      if (!hits.length) { const li = el("li"); li.append(el("button", null, "Aucune personne trouvée")); li.firstChild.disabled = true; list.append(li); }
      list.hidden = false;
    };
    input.addEventListener("input", update);
    input.addEventListener("keydown", (e) => { if (e.key === "Escape") hide(); });
    input.closest(".oc-pick").addEventListener("focusout", (e) => { if (!e.currentTarget.contains(e.relatedTarget)) hide(); });
  }
  function renderChips() {
    const f = state.form;
    for (const [id, arr, cls] of [["oc-users", f.users, ""], ["oc-excl", f.excl, "ex"]]) {
      const box = $(id);
      box.replaceChildren();
      for (const u of arr) {
        const c = el("span", "oc-chip " + cls, u.name);
        const x = button("×", null, () => { arr.splice(arr.indexOf(u), 1); renderChips(); schedulePreview(); });
        x.setAttribute("aria-label", "Retirer " + u.name);
        c.append(x); box.append(c);
      }
    }
  }
  function renderCurrent() {
    const f = state.form, box = $("oc-current");
    if (f.mode !== "edit") return;
    box.replaceChildren(el("h3", null, `Destinataires actuels (${f.current.length})`));
    const ul = el("ul");
    for (const i of f.current) {
      const li = el("li", f.removeUsers.has(i.id) ? "gone" : "");
      li.append(el("span", null, i.name));
      const right = el("span");
      right.append(checkbox("Obligatoire", f.required.has(i.id), (on) => { on ? f.required.add(i.id) : f.required.delete(i.id); }));
      if (i.id !== state.detail.poll.creator_id) right.append(button(f.removeUsers.has(i.id) ? "Rétablir" : "Retirer", "oc-x", () => { f.removeUsers.has(i.id) ? f.removeUsers.delete(i.id) : f.removeUsers.add(i.id); renderCurrent(); }));
      li.append(right); ul.append(li);
    }
    box.append(ul);
    if (!f.current.length) box.append(el("p", "muted", "La liste n'est pas visible : l'organisation garde les réponses nominatives confidentielles, vous pouvez toutefois ajouter des destinataires."));
  }
  function audience() {
    const f = state.form;
    return C.cleanAudience({ rules: f.rules, users: f.users.map((u) => u.id), exclude: f.excl.map((u) => u.id) });
  }
  function schedulePreview() {
    clearTimeout(state.previewTimer);
    state.previewTimer = setTimeout(runPreview, 250);
  }
  async function runPreview() {
    const f = state.form, box = $("oc-preview"), seq = ++state.previewSeq;
    const a = audience();
    if (C.isEmptyAudience(a)) { box.replaceChildren(el("p", "muted", f.mode === "edit" ? "Aucun destinataire à ajouter." : "Ajoutez un groupe ou des personnes pour voir qui sera invité.")); f.members = []; return; }
    box.replaceChildren(el("p", "muted", "Calcul…"));
    let r;
    try { r = await call("oncoodle_audience_preview", { p_audience: a }); }
    catch (e) { if (seq === state.previewSeq) box.replaceChildren(el("p", "form-msg error", e.message)); return; }
    if (seq !== state.previewSeq) return;
    const known = new Set(f.current.map((c) => c.id));
    f.members = (r.members || []).filter((m) => m.id !== state.me && !known.has(m.id));
    const head = f.mode === "edit"
      ? `${plural(f.members.length, "nouveau destinataire", "nouveaux destinataires")}`
      : `${plural(f.members.length, "personne invitée", "personnes invitées")}${f.includeMe ? ", vous compris·e comme participant·e" : ""}`;
    box.replaceChildren(el("p", null, ""));
    box.firstChild.append(el("strong", null, head));
    if (r.truncated) box.append(el("p", "muted", "Liste tronquée à 400 personnes."));
    const ul = el("ul");
    for (const m of f.members) {
      const li = el("li");
      li.append(el("span", null, `${m.name}  ·  ${C.ROLE_SINGULAR[m.role] || m.role}  ·  ${m.via}`));
      li.append(checkbox("Obligatoire", f.required.has(m.id), (on) => { on ? f.required.add(m.id) : f.required.delete(m.id); }));
      ul.append(li);
    }
    box.append(ul);
    if (f.members.length > 300) box.append(el("p", "form-msg error", "Plus de 300 destinataires : le sondage sera refusé."));
  }

  async function onSubmit(ev) {
    ev.preventDefault();
    const f = state.form, form = $("oc-form"), btn = $("oc-submit");
    const title = form.elements.title.value.trim();
    if (title.length < 3) return say("oc-form-msg", "Donnez un titre d'au moins 3 caractères.", "error");
    const active = f.slots.filter((s) => !(s.id && f.removeOptions.has(s.id)));
    if (f.kind === "rsvp" && active.length !== 1) return say("oc-form-msg", "Définissez la date de l'événement.", "error");
    if (f.kind === "slots" && active.length < 2) return say("oc-form-msg", "Proposez au moins deux créneaux.", "error");
    const dlv = form.elements.deadline.value;
    const deadline = dlv ? new Date(dlv).toISOString() : null;
    if (deadline && new Date(deadline) < new Date(Date.now() + 5 * 60e3)) return say("oc-form-msg", "L'échéance doit être dans le futur.", "error");
    const a = audience();
    btn.disabled = true; say("oc-form-msg", "Enregistrement…");
    try {
      if (f.mode === "create") {
        if (C.isEmptyAudience(a)) throw new Error("Choisissez au moins un groupe ou une personne.");
        if (!f.members || !f.members.length) { await runPreview(); if (!f.members.length) throw new Error("Aucun destinataire : ajoutez au moins une personne autre que vous."); }
        const required = [...f.required].filter((id) => f.members.some((m) => m.id === id));
        const id = await call("oncoodle_create", { p_poll: { kind: f.kind, title, description: form.elements.description.value.trim(), location: form.elements.location.value.trim(),
          visibility: form.elements.visibility.value, deadline, options: active.map(({ day, start, end }) => ({ day, start, end })), audience: a, include_me: $("oc-me").checked, required } });
        kick();
        state.tab = null;
        state.flash = "Sondage créé : les invitations sont en cours d'envoi.";
        if (location.hash === "#p=" + id) await openDetail(id); else location.hash = "p=" + id;
      } else {
        const ch = { title, description: form.elements.description.value.trim(), location: form.elements.location.value.trim(), visibility: form.elements.visibility.value, deadline: deadline || "" };
        const add = f.slots.filter((s) => !s.id).map(({ day, start, end }) => ({ day, start, end }));
        if (add.length) ch.add_options = add;
        if (f.removeOptions.size) ch.remove_options = [...f.removeOptions];
        if (!C.isEmptyAudience(a)) ch.add_audience = a;
        if (f.removeUsers.size) ch.remove_users = [...f.removeUsers];
        await call("oncoodle_update", { p_poll: f.pollId, p_changes: ch });
        // Statut « obligatoire » : après l'ajout, pour que les nouveaux destinataires existent
        const want = new Set([...f.required].filter((id) => !f.removeUsers.has(id)));
        const known = new Set(f.current.map((c) => c.id).concat((f.members || []).map((m) => m.id)));
        const diffs = [...known].filter((id) => want.has(id) !== f.initialRequired.has(id)).map((id) => ({ user_id: id, required: want.has(id) }));
        if (diffs.length) await call("oncoodle_update", { p_poll: f.pollId, p_changes: { set_required: diffs } });
        kick();
        await openDetail(f.pollId, "Modifications enregistrées.");
      }
    } catch (e) { say("oc-form-msg", e.message, "error"); }
    btn.disabled = false;
  }

  // ----- Réglages -----
  async function loadPrefs() {
    try {
      const p = await call("oncoodle_prefs");
      const box = $("oc-pref-email");
      box.checked = p.email !== false;
      box.addEventListener("change", async () => {
        try { await call("oncoodle_set_prefs", { p_email: box.checked }); say("oc-pref-msg", "Réglage enregistré.", "ok"); }
        catch (e) { say("oc-pref-msg", e.message, "error"); box.checked = !box.checked; }
      });
    } catch (e) { /* réglages indisponibles : sans effet sur le reste */ }
  }

  // ----- Démarrage -----
  (async () => {
    if (!sb) return say("oc-status", "Service indisponible.");
    const { data } = await sb.auth.getSession();
    if (!data.session) return (location.href = "/fr/the-hive.html");
    $("logout").addEventListener("click", async () => { await sb.auth.signOut(); location.href = "/fr/"; });
    state.me = data.session.user.id;
    const { data: profile } = await sb.from("profiles").select("role").eq("id", state.me).single();
    state.role = profile ? profile.role : "member";
    const { data: allowed } = await sb.rpc("has_tool", { p_tool: "oncoodle" });
    if (state.role !== "admin" && allowed !== true) return say("oc-status", "Cet espace est réservé aux membres validés de The Hive.");
    try { state.people = (await call("oncoodle_people")) || []; } catch (e) { return say("oc-status", "Chargement impossible : " + e.message, "error"); }
    fillTemplates();
    picker("oc-pick-in", "oc-pick-list", "users");
    picker("oc-ex-in", "oc-ex-list", "excl");
    $("oc-new").addEventListener("click", () => openForm(null));
    $("oc-back").addEventListener("click", goList);
    $("oc-cancel-form").addEventListener("click", () => { if (state.form && state.form.mode === "edit") openDetail(state.form.pollId); else goList(); });
    $("oc-form").addEventListener("submit", onSubmit);
    $("oc-template").addEventListener("change", applyTemplate);
    $("oc-kind").addEventListener("change", (e) => { if (e.target.name === "kind") { state.form.kind = e.target.value; state.form.slots = state.form.slots.filter((s) => s.id); renderKind(); renderSlots(); } });
    $("oc-add-rule").addEventListener("click", () => { state.form.rules.push({ clinics: [], roles: [] }); renderRules(); });
    $("oc-me").addEventListener("change", (e) => { state.form.includeMe = e.target.checked; schedulePreview(); });
    $("g-run").addEventListener("click", onGenerate);
    $("m-add").addEventListener("click", onManualAdd);
    $("oc-dlg-form").addEventListener("submit", onDialogSubmit);
    $("oc-dlg-cancel").addEventListener("click", () => $("oc-dlg").close());
    window.addEventListener("hashchange", route);
    loadPrefs();
    await route();
    $("oc-status").hidden = true;
    $("oc-tool").hidden = false;
  })();
})();
