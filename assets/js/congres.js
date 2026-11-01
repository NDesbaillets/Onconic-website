// Congrès et formations : liste, calendrier, fiches modifiables par tous les membres, participation.
// Les coordonnées des participants viennent de event_attendees(), qui applique les consentements côté base.
(function () {
  const cfg = window.ONCONIC_CONFIG || {};
  const sb = window.supabase && cfg.supabaseUrl ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey) : null;

  const BLOCS = [
    ["Bloc 1", ["Sénologie", "Gynécologie", "Urologie"]],
    ["Bloc 2", ["Thoracique", "Neuro-oncologie", "Mélanome"]],
    ["Bloc 3", ["Lower GI", "Upper GI", "ORL", "Sarcomes", "Radiologie interventionnelle"]]
  ];
  const ALL = "Transversal"; // concerne toutes les cliniques
  const KINDS = [["congrès", "Congrès"], ["formation", "Formations"], ["symposium", "Symposiums"], ["webinaire", "Webinaires"]];
  const STATUS = [["going", "J'y vais"], ["maybe", "Peut-être"], ["presenting", "Je présente"]];
  const STATUS_LABEL = { going: "y va", maybe: "peut-être", presenting: "présente" };
  const MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
  const DAYS = ["lun", "mar", "mer", "jeu", "ven", "sam", "dim"];

  const $ = (id) => document.getElementById(id);
  const state = {
    events: [], att: new Map(), me: null, role: "", q: "", clinic: "", kind: "", mine: false, past: false,
    view: "calendar", month: null, day: null, detail: null, editing: null
  };

  const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  function el(tag, cls, txt) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }
  const badge = (txt, cls) => el("span", "ug-badge " + (cls || ""), txt);
  function button(label, cls, onClick) {
    const b = el("button", cls, label);
    b.type = "button";
    b.addEventListener("click", onClick);
    return b;
  }

  // ----- Dates (chaînes AAAA-MM-JJ, sans fuseau horaire) -----
  const pd = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); };
  const iso = (d) => d.toISOString().slice(0, 10);
  const todayIso = () => { const t = new Date(); return iso(new Date(Date.UTC(t.getFullYear(), t.getMonth(), t.getDate()))); };
  const addDays = (s, n) => { const d = pd(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
  const fmtShort = (s) => { const d = pd(s); const m = MONTHS[d.getUTCMonth()]; return `${d.getUTCDate()} ${m.length > 4 ? m.slice(0, 4) + "." : m}`; };
  const fmtFull = (s) => { const d = pd(s); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
  const fmtCH = (s) => s.split("-").reverse().join(".");
  function range(e) {
    const a = pd(e.start_date), b = pd(e.end_date);
    if (e.start_date === e.end_date) return fmtFull(e.start_date);
    if (a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth())
      return `${a.getUTCDate()}–${b.getUTCDate()} ${MONTHS[b.getUTCMonth()]} ${b.getUTCFullYear()}`;
    if (a.getUTCFullYear() === b.getUTCFullYear()) return `${fmtShort(e.start_date)} – ${fmtFull(e.end_date)}`;
    return `${fmtFull(e.start_date)} – ${fmtFull(e.end_date)}`;
  }

  // ----- Données -----
  async function load() {
    const { data: events, error } = await sb.from("events").select("*").order("start_date").order("title").range(0, 1999);
    if (error) throw error;
    state.events = events || [];
    state.att = new Map();
    if (state.events.length) {
      const { data: rows } = await sb.rpc("event_attendees", { p_event_ids: state.events.map((e) => e.id) });
      for (const r of rows || []) {
        if (!state.att.has(r.event_id)) state.att.set(r.event_id, []);
        state.att.get(r.event_id).push(r);
      }
    }
    for (const e of state.events) e._hay = norm([e.title, e.description, e.city, e.country, e.venue, e.kind, (e.clinics || []).join(" ")].join(" "));
  }
  const mine = (e) => (state.att.get(e.id) || []).find((a) => a.is_me);

  // ----- Filtres -----
  function matches(e, ignorePast) {
    if (!ignorePast && !state.past && e.end_date < todayIso()) return false;
    if (state.clinic && !(e.clinics || []).some((c) => norm(c) === state.clinic || c === ALL)) return false;
    if (state.kind && e.kind !== state.kind) return false;
    if (state.mine && !mine(e)) return false;
    const tokens = norm(state.q).split(" ").filter(Boolean);
    return tokens.every((t) => e._hay.includes(t));
  }

  function fillClinics() {
    const sel = $("f-clinic");
    const upcoming = state.events.filter((e) => e.end_date >= todayIso());
    const count = (c) => upcoming.filter((e) => (e.clinics || []).some((x) => norm(x) === norm(c) || x === ALL)).length;
    const opt = (c) => { const o = el("option", null, `${c} (${count(c)})`); o.value = norm(c); return o; };
    const first = el("option", null, `Toutes les cliniques (${upcoming.length})`);
    first.value = "";
    sel.replaceChildren(first, ...BLOCS.map(([bloc, list]) => { const g = el("optgroup"); g.label = bloc; g.append(...list.map(opt)); return g; }));
    sel.value = state.clinic;
  }

  function kindChips() {
    const box = $("cg-kinds");
    const make = (v, label) => {
      const b = button(label, "ug-chip", () => { state.kind = state.kind === v ? "" : v; kindChips(); render(); });
      b.setAttribute("aria-pressed", String(state.kind === v));
      return b;
    };
    box.replaceChildren(make("", "Tous"), ...KINDS.map(([v, l]) => make(v, l)));
  }

  // ----- Affichage : calendrier par défaut ; liste seulement sur recherche ou si demandée -----
  const listMode = () => state.view === "list" || state.q.trim() !== "";

  function render() {
    const list = state.events.filter((e) => matches(e));
    $("ug-count").textContent = `${list.length} événement${list.length > 1 ? "s" : ""}` + (state.past ? "" : " à venir");
    renderPrivacyHint();
    const lm = listMode();
    $("v-list").setAttribute("aria-pressed", String(lm));
    $("v-cal").setAttribute("aria-pressed", String(!lm));
    $("cg-list").hidden = !lm;
    $("cg-cal").hidden = lm;
    $("cg-detail").hidden = lm;
    if (!lm) { renderCalendar(); renderDetail(); return; }
    const out = $("cg-list");
    out.replaceChildren();
    if (!list.length) {
      const p = el("div", "cg-empty");
      p.append(el("p", null, state.q ? `Aucun événement ne correspond à « ${state.q} ».` : "Aucun événement pour ces filtres."));
      p.append(button(state.q ? `Créer « ${state.q} »` : "Ajouter un événement", "btn", () => openForm(null, { title: state.q })));
      out.append(p);
      return;
    }
    let month = "";
    for (const e of list) {
      const m = e.start_date.slice(0, 7);
      if (m !== month) {
        month = m;
        const d = pd(e.start_date);
        out.append(el("h2", "cg-month", `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`));
      }
      out.append(card(e));
    }
  }

  function renderDetail() {
    const box = $("cg-detail");
    const e = state.detail && state.events.find((x) => x.id === state.detail);
    if (!e) { box.replaceChildren(); return; }
    const d = card(e);
    box.replaceChildren(d, button("Fermer la fiche", "btn btn-outline ug-copy cg-close", () => { state.detail = null; renderDetail(); }));
    d.open = true;
  }

  function renderPrivacyHint() {
    const going = state.events.some((e) => mine(e));
    const hint = $("cg-privacy");
    hint.hidden = !(going && state.me && !state.me.show_in_events);
    if (!hint.hidden && !hint.firstChild) {
      hint.append("Votre participation n'est visible que par vous : les autres membres voient seulement « un autre membre ». Pour afficher votre nom, ");
      const a = el("a", null, "activez-le dans Mon compte");
      a.href = "/fr/app/compte.html#ruche";
      hint.append(a, ".");
    }
  }

  function card(e) {
    const d = el("details", "ug-card cg-card");
    d.id = "ev-" + e.id;
    const s = el("summary");
    const date = el("div", "cg-date");
    const sd = pd(e.start_date);
    date.append(el("strong", null, String(sd.getUTCDate())), el("span", null, MONTHS[sd.getUTCMonth()].slice(0, 3)));
    const head = el("div", "ug-head");
    head.append(el("span", "ug-name", e.title));
    const meta = el("div", "ug-meta");
    meta.append(badge(e.kind));
    if (e.format !== "présentiel") meta.append(badge(e.format));
    if (e.to_confirm) meta.append(badge("Dates à confirmer", "ug-warn"));
    (e.clinics || []).forEach((c) => meta.append(badge(c === ALL ? "Toutes cliniques" : c, "cg-clinic-badge")));
    head.append(meta);
    head.append(el("p", "cg-when", [range(e), [e.city, e.country].filter(Boolean).join(", ")].filter(Boolean).join(" · ")));
    const att = state.att.get(e.id) || [];
    const me = mine(e);
    const line = el("p", "cg-who");
    if (me) line.append(badge("Vous : " + STATUS[STATUS.findIndex(([k]) => k === me.status)][1], "cg-me"), " ");
    const others = att.filter((a) => !a.is_me);
    if (others.length) line.append(`${others.length} autre${others.length > 1 ? "s" : ""} membre${others.length > 1 ? "s" : ""} de The Hive`);
    if (me || others.length) head.append(line);
    s.append(date, head);
    d.append(s);
    d.addEventListener("toggle", () => { if (d.open && !d.dataset.ready) body(d, e); });
    return d;
  }

  function body(d, e) {
    d.dataset.ready = "1";
    const b = el("div", "ug-body cg-body");
    if (e.description) b.append(el("p", "cg-desc", e.description));
    const facts = el("dl", "ug-dl");
    const fact = (k, v) => { if (v) facts.append(el("dt", null, k), el("dd", null, v)); };
    fact("Dates", range(e));
    fact("Lieu", [e.venue, e.city, e.country].filter(Boolean).join(", "));
    fact("Abstracts", e.abstract_deadline && "jusqu'au " + fmtCH(e.abstract_deadline));
    fact("Tarif réduit", e.early_deadline && "jusqu'au " + fmtCH(e.early_deadline));
    b.append(facts);
    const links = el("div", "btn-row cg-links");
    if (e.url) { const a = el("a", "btn btn-outline ug-copy", "Site officiel"); a.href = e.url; a.target = "_blank"; a.rel = "noopener noreferrer"; links.append(a); }
    links.append(button("Ajouter à mon agenda", "btn btn-outline ug-copy", () => ics(e)));
    b.append(links);

    // Participation
    const part = el("div", "cg-part");
    part.append(el("h3", null, "Qui d'autre butine ?"));
    const me = mine(e);
    const choice = el("div", "cg-status", null);
    choice.setAttribute("role", "group");
    choice.setAttribute("aria-label", "Ma participation");
    for (const [k, label] of STATUS) {
      const c = button(label, "ug-chip", () => setStatus(e, me && me.status === k ? null : k));
      c.setAttribute("aria-pressed", String(!!me && me.status === k));
      choice.append(c);
    }
    part.append(choice);
    const att = (state.att.get(e.id) || []).filter((a) => !a.is_me);
    const named = att.filter((a) => a.name), anon = att.length - named.length;
    if (!att.length) part.append(el("p", "muted", "Aucun autre membre inscrit pour l'instant."));
    const ul = el("ul", "cg-people");
    for (const a of named) {
      const li = el("li");
      li.append(el("strong", null, a.name), el("span", "muted", " " + STATUS_LABEL[a.status]));
      const contact = el("span", "cg-contact");
      if (a.email) { const m = el("a", null, "E-mail"); m.href = `mailto:${a.email}?subject=${encodeURIComponent(e.title)}`; contact.append(m); }
      const wa = waLink(a.phone, e.title);
      if (wa) { const w = el("a", null, "WhatsApp"); w.href = wa; w.target = "_blank"; w.rel = "noopener noreferrer"; contact.append(w); }
      li.append(contact);
      ul.append(li);
    }
    if (named.length) part.append(ul);
    if (anon) part.append(el("p", "muted", `${named.length ? "Et " : ""}${anon} membre${anon > 1 ? "s" : ""} qui préfère${anon > 1 ? "nt" : ""} rester discret${anon > 1 ? "s" : ""}.`));
    part.append(whatsapp(e, !!me));
    b.append(part);

    // Gestion
    const tools = el("div", "btn-row cg-tools");
    tools.append(button("Modifier", "btn btn-outline ug-copy", () => openForm(e)));
    tools.append(button("Dupliquer pour une autre édition", "btn btn-outline ug-copy", () => openForm(null, duplicate(e))));
    if (state.role === "admin" || e.created_by === state.me.id) tools.append(button("Supprimer", "btn btn-outline ug-copy lt-danger", () => remove(e)));
    b.append(tools);
    b.append(el("p", "muted cg-stamp", `Dernière modification le ${new Date(e.updated_at).toLocaleDateString("fr-CH")}${e.source ? " · source : " + e.source : ""}`));
    d.append(b);
  }

  // WhatsApp ne permet pas de créer un groupe depuis un site : un participant le crée dans l'app,
  // colle ici le lien d'invitation, et chaque participant le rejoint en un clic.
  function whatsapp(e, going) {
    const box = el("div", "cg-wa");
    const share = el("a", "btn btn-outline ug-copy", "Partager sur WhatsApp");
    share.href = `https://wa.me/?text=${encodeURIComponent(`${e.title} (${range(e)}) : qui y va ? https://onconic.ch/app/congres.html?e=${e.id}`)}`;
    share.target = "_blank"; share.rel = "noopener noreferrer";
    if (e.whatsapp_url) {
      const join = el("a", "btn ug-copy", "Rejoindre le groupe WhatsApp");
      join.href = e.whatsapp_url; join.target = "_blank"; join.rel = "noopener noreferrer";
      box.append(el("div", "btn-row", null));
      box.lastChild.append(join, share);
      return box;
    }
    box.append(share);
    if (!going) return box;
    const help = el("details", "cg-wa-help");
    help.append(el("summary", null, "Créer le groupe WhatsApp des participants"));
    const ol = el("ol");
    ["Dans WhatsApp, créez un groupe (« Nouveau groupe ») avec un premier participant.",
      "Ouvrez les infos du groupe › « Inviter via un lien » › « Copier le lien ».",
      "Collez le lien ci-dessous : tous les membres inscrits pourront rejoindre le groupe en un clic."].forEach((t) => ol.append(el("li", null, t)));
    const row = el("div", "cg-wa-row");
    const input = el("input");
    input.type = "url"; input.placeholder = "https://chat.whatsapp.com/…"; input.setAttribute("aria-label", "Lien d'invitation du groupe");
    const save = button("Enregistrer le lien", "btn ug-copy", async () => {
      const v = input.value.trim();
      if (!/^https:\/\/chat\.whatsapp\.com\/\S+$/.test(v)) { input.setCustomValidity("Lien attendu : https://chat.whatsapp.com/…"); input.reportValidity(); return; }
      const { error } = await sb.from("events").update({ whatsapp_url: v }).eq("id", e.id);
      if (error) return alert("Enregistrement impossible : " + error.message);
      await refresh(e.id);
    });
    input.addEventListener("input", () => input.setCustomValidity(""));
    row.append(input, save);
    help.append(ol, row);
    box.append(help);
    return box;
  }

  // Numéro suisse ou international → lien wa.me (chiffres seulement, indicatif sans « + »)
  function waLink(phone, title) {
    if (!phone) return null;
    let p = phone.trim().replace(/[^\d+]/g, "");
    if (p.startsWith("+")) p = p.slice(1);
    else if (p.startsWith("00")) p = p.slice(2);
    else if (p.startsWith("0")) p = "41" + p.slice(1);
    if (!/^\d{8,15}$/.test(p)) return null;
    return `https://wa.me/${p}?text=${encodeURIComponent(`Bonjour, je vois sur Onconic que tu vas aussi à ${title}.`)}`;
  }

  async function setStatus(e, status) {
    const q = status
      ? sb.from("event_participants").upsert({ event_id: e.id, user_id: state.me.id, status }, { onConflict: "event_id,user_id" })
      : sb.from("event_participants").delete().eq("event_id", e.id).eq("user_id", state.me.id);
    const { error } = await q;
    if (error) return alert("Impossible d'enregistrer : " + error.message);
    await refresh(e.id);
  }

  async function remove(e) {
    if (!confirm(`Supprimer « ${e.title} » pour tous les membres ?`)) return;
    const { error } = await sb.from("events").delete().eq("id", e.id);
    if (error) return alert("Suppression refusée : " + error.message);
    await refresh();
  }

  async function refresh(openId) {
    await load();
    fillClinics();
    render();
    if (openId) reveal(openId);
  }

  function reveal(id) {
    const e = state.events.find((x) => x.id === id);
    if (!e) return;
    if (e.end_date < todayIso() && !state.past) { state.past = true; $("f-past").checked = true; }
    if (listMode()) {
      if (!matches(e)) { state.q = ""; $("q").value = ""; state.clinic = ""; $("f-clinic").value = ""; state.kind = ""; state.mine = false; $("f-mine").checked = false; kindChips(); }
      render();
      if (listMode()) {
        const d = document.getElementById("ev-" + id);
        if (d) { d.open = true; d.scrollIntoView({ behavior: "smooth", block: "start" }); }
        return;
      }
    }
    // Calendrier : on se place sur le mois de l'événement et sa fiche s'ouvre sous la grille
    state.month = e.start_date.slice(0, 7) + "-01";
    state.detail = id;
    render();
    $("cg-detail").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // ----- Export agenda (.ics, journées entières) -----
  function ics(e) {
    const esc = (s) => String(s || "").replace(/\\/g, "\\\\").replace(/([,;])/g, "\\$1").replace(/\n/g, "\\n");
    const day = (s) => s.replace(/-/g, "");
    const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Onconic//Congres//FR", "CALSCALE:GREGORIAN", "BEGIN:VEVENT",
      `UID:event-${e.id}@onconic.ch`, `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`,
      `DTSTART;VALUE=DATE:${day(e.start_date)}`, `DTEND;VALUE=DATE:${day(addDays(e.end_date, 1))}`,
      `SUMMARY:${esc(e.title)}`, `LOCATION:${esc([e.venue, e.city, e.country].filter(Boolean).join(", "))}`,
      `DESCRIPTION:${esc([e.description, e.url].filter(Boolean).join("\n"))}`];
    if (e.url) lines.push(`URL:${e.url}`);
    lines.push("END:VEVENT", "END:VCALENDAR");
    const url = URL.createObjectURL(new Blob([lines.join("\r\n")], { type: "text/calendar" }));
    const a = el("a");
    a.href = url; a.download = norm(e.title).replace(/ /g, "-").slice(0, 60) + ".ics";
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  // ----- Calendrier -----
  function setView(v) {
    state.view = v;
    if (v === "calendar" && state.q) { state.q = ""; $("q").value = ""; }
    render();
  }

  function renderCalendar() {
    const box = $("cg-cal");
    if (!state.month) state.month = todayIso().slice(0, 7) + "-01";
    const first = pd(state.month);
    const y = first.getUTCFullYear(), m = first.getUTCMonth();
    const nav = el("div", "cg-cal-nav");
    const shift = (n) => { const d = new Date(Date.UTC(y, m + n, 1)); state.month = iso(d); state.day = null; renderCalendar(); };
    nav.append(button("‹", "btn btn-outline ug-copy", () => shift(-1)), el("h2", "cg-month", `${MONTHS[m]} ${y}`),
      button("›", "btn btn-outline ug-copy", () => shift(1)),
      button("Aujourd'hui", "btn btn-outline ug-copy", () => { state.month = todayIso().slice(0, 7) + "-01"; state.day = todayIso(); renderCalendar(); }));
    const grid = el("div", "cg-grid-cal");
    grid.setAttribute("role", "grid");
    DAYS.forEach((d) => grid.append(el("div", "cg-dow", d)));
    const lead = (first.getUTCDay() + 6) % 7; // lundi en premier
    const start = addDays(state.month, -lead);
    const events = state.events.filter((e) => matches(e, true));
    for (let i = 0; i < 42; i++) {
      const day = addDays(start, i);
      if (i >= 35 && pd(day).getUTCMonth() !== m) break;
      const cell = el("div", "cg-day" + (pd(day).getUTCMonth() !== m ? " out" : "") + (day === todayIso() ? " today" : "") + (day === state.day ? " sel" : ""));
      cell.tabIndex = 0;
      cell.setAttribute("role", "gridcell");
      cell.append(el("span", "cg-num", String(pd(day).getUTCDate())));
      const todays = events.filter((e) => e.start_date <= day && e.end_date >= day);
      cell.setAttribute("aria-label", `${fmtFull(day)} : ${todays.length} événement${todays.length > 1 ? "s" : ""}`);
      for (const e of todays.slice(0, 3)) {
        const chip = button(e.title, "cg-chip k-" + norm(e.kind) + (mine(e) ? " mine" : ""), (ev) => { ev.stopPropagation(); reveal(e.id); });
        chip.title = `${e.title} · ${range(e)}`;
        cell.append(chip);
      }
      if (todays.length > 3) cell.append(el("span", "cg-more", `+${todays.length - 3}`));
      const pick = () => { state.day = day; renderCalendar(); };
      cell.addEventListener("click", pick);
      cell.addEventListener("keydown", (k) => { if (k.key === "Enter" || k.key === " ") { k.preventDefault(); pick(); } });
      grid.append(cell);
    }
    const dayList = el("div", "cg-daylist");
    if (state.day) {
      const todays = events.filter((e) => e.start_date <= state.day && e.end_date >= state.day);
      dayList.append(el("h3", null, fmtFull(state.day)));
      if (!todays.length) dayList.append(el("p", "muted", "Aucun événement ce jour-là."));
      for (const e of todays) {
        const row = button(`${e.title} · ${range(e)}${e.city ? " · " + e.city : ""}`, "cg-dayitem", () => reveal(e.id));
        dayList.append(row);
      }
    }
    box.replaceChildren(nav, grid, dayList);
  }

  // ----- Formulaire -----
  function duplicate(e) {
    const bump = (s) => s && (() => { const d = pd(s); d.setUTCFullYear(d.getUTCFullYear() + 1); return iso(d); })();
    const c = Object.assign({}, e);
    delete c.id;
    c.title = e.title.replace(/\b(20\d\d)\b/, (y) => String(+y + 1));
    if (c.title === e.title) c.title = e.title + " (nouvelle édition)";
    c.start_date = bump(e.start_date); c.end_date = bump(e.end_date);
    c.abstract_deadline = null; c.early_deadline = null; c.whatsapp_url = null;
    c.to_confirm = true;
    return c;
  }

  function openForm(e, preset) {
    state.editing = e;
    const f = $("cg-form");
    f.reset();
    $("cg-form-msg").textContent = "";
    $("cg-form-title").textContent = e ? "Modifier l'événement" : preset && preset.start_date ? "Nouvelle édition" : "Nouvel événement";
    const src = e || preset || {};
    for (const k of ["title", "kind", "format", "start_date", "end_date", "city", "country", "venue", "url", "description", "abstract_deadline", "early_deadline", "whatsapp_url"]) {
      if (f.elements[k] && src[k] != null) f.elements[k].value = src[k];
    }
    f.elements.to_confirm.checked = !!src.to_confirm;
    const box = $("cg-clinics");
    box.querySelectorAll("label").forEach((l) => l.remove());
    for (const c of [ALL].concat(BLOCS.flatMap(([, l]) => l))) {
      const l = el("label", "cg-check");
      const i = el("input");
      i.type = "checkbox"; i.name = "clinics"; i.value = c;
      // Nouvelle fiche : la clinique filtrée est cochée d'office
      i.checked = src.clinics ? src.clinics.includes(c) : !!state.clinic && norm(c) === state.clinic;
      l.append(i, " " + (c === ALL ? "Toutes (transversal)" : c));
      box.append(l);
    }
    similar();
    $("cg-dialog").showModal();
    f.elements.title.focus();
  }

  // Doublons probables : mêmes mots significatifs dans le titre (années et mots courants ignorés)
  const STOP = new Set(["congress", "congres", "annual", "meeting", "the", "of", "on", "and", "for", "de", "du", "la", "le", "des", "et", "international", "european", "world", "swiss", "symposium", "conference", "workshop"]);
  const words = (t) => new Set(norm(t).split(" ").filter((w) => w.length > 2 && !/^\d+$/.test(w) && !STOP.has(w)));
  function similar() {
    const box = $("cg-similar");
    const t = $("cg-form").elements.title.value;
    const w = words(t);
    box.replaceChildren();
    if (w.size === 0) { box.hidden = true; return; }
    // Score : mots communs, pénalisé par les mots en trop ; puis l'édition la plus récente
    const score = (e) => { const x = words(e.title); const common = [...x].filter((k) => w.has(k)).length; return common ? common * 2 - (x.size - common) : -99; };
    const hits = state.events.filter((e) => (!state.editing || e.id !== state.editing.id) && [...words(e.title)].filter((x) => w.has(x)).length >= Math.min(2, w.size))
      .sort((a, b) => score(b) - score(a) || b.start_date.localeCompare(a.start_date)).slice(0, 4);
    box.hidden = !hits.length;
    if (!hits.length) return;
    box.append(el("p", null, "Existe peut-être déjà :"));
    for (const e of hits) {
      const row = el("div", "cg-sim-row");
      row.append(el("span", null, `${e.title} · ${range(e)}`),
        button("Ouvrir", "btn btn-outline ug-copy", () => { $("cg-dialog").close(); reveal(e.id); }),
        button("Dupliquer", "btn btn-outline ug-copy", () => openForm(null, duplicate(e))));
      box.append(row);
    }
  }

  async function save(ev) {
    ev.preventDefault();
    const f = $("cg-form"), msg = $("cg-form-msg");
    const v = (k) => (f.elements[k].value || "").trim() || null;
    const row = {
      title: v("title"), kind: v("kind"), format: v("format"), start_date: v("start_date"), end_date: v("end_date") || v("start_date"),
      city: v("city"), country: v("country"), venue: v("venue"), url: v("url"), description: v("description"),
      abstract_deadline: v("abstract_deadline"), early_deadline: v("early_deadline"), whatsapp_url: v("whatsapp_url"),
      to_confirm: f.elements.to_confirm.checked, clinics: [...f.querySelectorAll('input[name="clinics"]:checked')].map((i) => i.value)
    };
    const err = (t) => { msg.className = "form-msg error"; msg.textContent = t; };
    if (!row.title || row.title.length < 3) return err("Le titre est obligatoire.");
    if (!row.start_date) return err("La date de début est obligatoire.");
    if (row.end_date < row.start_date) return err("La date de fin précède la date de début.");
    if (!row.clinics.length) return err("Cochez au moins une clinique.");
    if (row.url && !/^https?:\/\//.test(row.url)) return err("Le site officiel doit commencer par https://");
    if (row.whatsapp_url && !/^https:\/\/chat\.whatsapp\.com\//.test(row.whatsapp_url)) return err("Le lien WhatsApp doit commencer par https://chat.whatsapp.com/");
    msg.className = "form-msg"; msg.textContent = "Enregistrement…";
    const q = state.editing
      ? sb.from("events").update(row).eq("id", state.editing.id).select("id").single()
      : sb.from("events").insert(Object.assign(row, { created_by: state.me.id, source: "membre" })).select("id").single();
    const { data, error } = await q;
    if (error) return err(error.code === "23505" ? "Cet événement existe déjà à cette date." : "Refusé : " + error.message);
    $("cg-dialog").close();
    await refresh(data.id);
  }

  // ----- Démarrage -----
  (async () => {
    if (!sb) return ($("ug-status").textContent = "Service indisponible.");
    const { data } = await sb.auth.getSession();
    if (!data.session) return (location.href = "/fr/the-hive.html");
    $("logout").addEventListener("click", async () => { await sb.auth.signOut(); location.href = "/fr/"; });
    const { data: profile } = await sb.from("profiles").select("role, show_in_events, contactable").eq("id", data.session.user.id).single();
    state.role = profile ? profile.role : "member";
    state.me = Object.assign({ id: data.session.user.id }, profile || {});
    if (!["admin", "clinician", "assistant", "pharmacist"].includes(state.role)) {
      $("ug-status").textContent = "Cet espace est réservé aux membres validés de The Hive.";
      return;
    }
    try { await load(); } catch (e) { $("ug-status").textContent = "Chargement impossible : " + e.message; return; }
    $("ug-status").hidden = true;
    $("cg-tool").hidden = false;
    fillClinics();
    kindChips();
    $("q").addEventListener("input", (e) => { state.q = e.target.value; render(); });
    $("f-clinic").addEventListener("change", (e) => { state.clinic = e.target.value; render(); });
    $("f-mine").addEventListener("change", (e) => { state.mine = e.target.checked; render(); });
    $("f-past").addEventListener("change", (e) => { state.past = e.target.checked; render(); });
    $("v-list").addEventListener("click", () => setView("list"));
    $("v-cal").addEventListener("click", () => setView("calendar"));
    $("cg-new").addEventListener("click", () => openForm(null, { title: state.q }));
    $("cg-form").addEventListener("submit", save);
    $("cg-form").elements.title.addEventListener("input", similar);
    $("cg-form").elements.start_date.addEventListener("change", (e) => {
      const end = $("cg-form").elements.end_date;
      if (!end.value || end.value < e.target.value) end.value = e.target.value;
    });
    $("cg-cancel").addEventListener("click", () => $("cg-dialog").close());
    render();
    const id = +new URLSearchParams(location.search).get("e");
    if (id) reveal(id);
  })();
})();
