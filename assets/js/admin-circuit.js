// Circuits de validation des absences : circuit général et circuits alternatifs (membres, rôles, cliniques), schéma, édition des étapes, simulateur et journal.
// Réservé à l'administration (contrôlé aussi en base). Les validateurs restent désignés par clinique dans /admin/absences.html ; cette page règle les étapes, leur ordre et leurs conditions.
(function () {
  const cfg = window.ONCONIC_CONFIG || {};
  const sb = window.supabase && cfg.supabaseUrl ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey) : null;
  const $ = (id) => document.getElementById(id);
  const ROLES = { clinician: "médecin assistant", cdc: "CDC", cadre: "médecin cadre", direction: "direction", admin: "admin", assistant: "assistante", nurse: "infirmier·ère", pharmacist: "pharmacien·ne" };
  const KINDS = [["vacances", "vacances"], ["congres", "congrès"], ["autre", "autre"]];
  const KIND_NAME = { vacances: "vacances", congres: "congrès", autre: "autre" };
  const TYPE_NAME = { preavis: "Pré-avis", clinique: "Validateurs de clinique", visa: "Visa de la direction", personnes: "Personnes désignées" };

  function el(tag, cls, txt) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }
  const pill = (txt, cls) => el("span", "cc-pill" + (cls ? " " + cls : ""), txt);
  const names = (list) => (list || []).map((x) => x.name).join(", ");
  const REASONS = { member: "nommé", role: "rôle", clinic: "clinique", default: "défaut", draft: "brouillon du circuit sélectionné" };
  const ROLE_CODES = ["clinician", "cdc", "cadre", "assistant", "pharmacist", "admin", "direction", "nurse"];
  const state = { overview: null, steps: [], orig: "", circuits: [], sel: null, detail: null, assign: { member: new Set(), role: new Set(), clinic: new Set() }, assignOrig: "", who: [], req: 0 };
  const current = () => state.circuits.find((c) => c.id === state.sel) || state.circuits[0] || { id: null, name: "", is_default: true };

  // ----- Schéma (étapes enregistrées) -----
  function conditions(s) {
    const out = [];
    if (Array.isArray(s.kinds) && s.kinds.length && s.kinds.length < 3) out.push("seulement : " + s.kinds.map((k) => KIND_NAME[k] || k).join(", "));
    if (s.min_days) out.push("dès " + s.min_days + " jours ouvrables");
    return out;
  }
  function node(s, o) {
    const n = el("div", "cc-node" + (s.kind === "preavis" || !s.blocking ? " optional" : "") + (s.active ? "" : " inactive"));
    n.append(el("h3", null, s.label));
    const pills = el("div", "cc-pills");
    pills.append(pill(s.blocking ? "bloquant" : "consultatif", s.blocking ? "block" : ""));
    if (!s.active) pills.append(pill("désactivée", "off"));
    n.append(pills);
    let rule, who;
    if (s.kind === "preavis") {
      rule = "Facultatif, non bloquant, en parallèle de la première étape bloquante.";
      who = "Direction : " + (names((o.direction || []).filter((d) => d.has_tool)) || "aucun membre");
    } else if (s.kind === "clinique") {
      rule = s.rule === "any" ? "Un seul validateur suffit ; un refus suffit." : "Tous doivent valider ; un refus suffit.";
      who = "Désignés par clinique (voir le tableau)";
    } else if (s.kind === "visa") {
      rule = "Un seul visa suffit ; signe le formulaire PDF.";
      who = o.visa_fallback_admins ? "Repli : administrateurs (" + names(o.admins) + ")" : "Direction : " + (names((o.direction || []).filter((d) => d.has_tool)) || "aucun membre");
    } else {
      rule = s.blocking ? (s.rule === "any" ? "Une seule validation suffit ; un refus suffit." : "Tous doivent valider ; un refus suffit.") : "Avis demandé ; la demande n'attend pas cette étape.";
      who = (s.persons || []).length ? names(s.persons) : "Aucune personne désignée";
      if (s.pdf_slot === "chef_service") rule += " Remplit la case « avis du chef de service » du formulaire.";
    }
    n.append(el("p", null, rule), el("p", null, who));
    const c = conditions(s);
    if (c.length) n.append(el("p", "cc-cond", c.join(" · ")));
    return n;
  }
  function flow(o, stepList) {
    const steps = [...(stepList || [])].sort((a, b) => a.pos - b.pos);
    const pre = steps.find((s) => s.kind === "preavis");
    const rest = steps.filter((s) => s.kind !== "preavis");
    const arrow = () => el("span", "cc-arrow", "→");
    const cols = [];
    const c1 = el("div", "cc-col"), start = el("div", "cc-node");
    start.append(el("h3", null, "Envoi de la demande"));
    c1.append(start);
    cols.push(c1);
    rest.forEach((s, i) => {
      const col = el("div", "cc-col");
      if (i === 0 && pre) col.append(node(pre, o));
      col.append(node(s, o));
      cols.push(col);
    });
    const end = el("div", "cc-node"); end.append(el("h3", null, "Validée : formulaire PDF"), el("p", null, "Signé par le visa"));
    const last = el("div", "cc-col"); last.append(end);
    cols.push(last);
    const out = [];
    cols.forEach((c, i) => { if (i) out.push(arrow()); out.push(c); });
    $("cc-flow").replaceChildren(...out);
  }

  function warnings(o) {
    const box = $("cc-warn");
    if (!(o.warnings || []).length) return box.replaceChildren(el("p", null, "Aucun problème de configuration"));
    const ul = el("ul");
    for (const w of o.warnings) ul.append(el("li", null, w));
    box.replaceChildren(ul);
  }

  function table(o) {
    const t = $("cc-table");
    const head = el("tr");
    for (const h of ["Clinique", "Membres", "Validateurs", "Les demandes vont à"]) head.append(el("th", null, h));
    const thead = el("thead"); thead.append(head);
    const body = el("tbody");
    for (const c of o.clinics || []) {
      const tr = el("tr");
      tr.append(el("td", null, c.clinic), el("td", null, String(c.members)));
      const v = el("td");
      if (!(c.validators || []).length) v.append(el("span", "muted", "Aucun"));
      for (const x of c.validators || []) {
        const p = pill(x.name + (x.role === "direction" ? " (direction)" : ""), x.active ? "" : "off");
        if (!x.active) p.title = x.reason;
        v.append(p);
        if (!x.active) v.append(el("span", "cc-reason", "(" + x.reason + ") "));
      }
      tr.append(v);
      tr.append(el("td", c.goes_to === "validators" ? "" : "amber", c.goes_to === "validators" ? "Validateurs (" + c.active_count + ")" : "Directement au visa"));
      body.append(tr);
    }
    t.replaceChildren(thead, body);
  }

  // ----- Édition -----
  const clone = (x) => JSON.parse(JSON.stringify(x));
  function fromServer(steps) {
    return [...(steps || [])].sort((a, b) => a.pos - b.pos).map((s) => ({
      kind: s.kind, label: s.label, rule: s.kind === "visa" ? "any" : s.rule || "all", blocking: s.kind === "preavis" ? false : !!s.blocking, active: !!s.active,
      persons: (s.persons || []).map((p) => (typeof p === "string" ? p : p.id)),
      kinds: Array.isArray(s.kinds) && s.kinds.length ? [...s.kinds] : null,
      min_days: s.min_days || null, pdf_slot: s.pdf_slot || null,
    }));
  }
  // Positions recalculées : pré-avis à 0, les autres 10, 20, 30… dans l'ordre affiché. Lève une erreur lisible si une étape est incomplète.
  function serialize() {
    let pos = 0;
    return state.steps.map((s) => {
      if (!String(s.label || "").trim()) throw new Error("Chaque étape doit avoir un libellé.");
      if (s.kinds && !s.kinds.length) throw new Error("Étape « " + s.label.trim() + " » : cochez au moins un motif.");
      if (s.min_days != null && !(Number.isInteger(s.min_days) && s.min_days >= 1 && s.min_days <= 365)) throw new Error("Étape « " + s.label.trim() + " » : la durée minimale va de 1 à 365 jours ouvrables.");
      const p = s.kind === "preavis" ? 0 : (pos += 10);
      return {
        pos: p, kind: s.kind, label: s.label.trim(), rule: s.kind === "visa" ? "any" : s.rule, blocking: s.kind === "preavis" ? false : s.kind === "visa" ? true : s.blocking, active: s.active,
        persons: s.kind === "personnes" ? s.persons : [], kinds: s.kinds && s.kinds.length < 3 ? s.kinds : null, min_days: s.min_days, pdf_slot: s.kind === "personnes" ? s.pdf_slot : null,
      };
    });
  }
  const snapshot = () => JSON.stringify(state.steps);
  function dirty() {
    const d = snapshot() !== state.orig;
    $("cc-dirty").hidden = !d;
    $("cc-save").disabled = !d; $("cc-cancel").disabled = !d;
  }
  function field(label, control, cls) {
    const l = el("label", "cc-field" + (cls ? " " + cls : ""));
    l.append(el("span", null, label), control);
    return l;
  }
  function check(label, checked, onchange) {
    const l = el("label", "cc-check");
    const c = el("input"); c.type = "checkbox"; c.checked = checked;
    c.addEventListener("change", () => onchange(c.checked));
    l.append(c, el("span", null, label));
    return l;
  }
  function memberLabel(m) { return m.name + " · " + (ROLES[m.role] || m.role) + (m.clinics && m.clinics.length ? " · " + m.clinics.join(", ") : ""); }

  function personsPicker(s) {
    const box = el("div", "cc-persons");
    const known = new Map();
    for (const m of state.overview.members || []) known.set(m.id, memberLabel(m));
    for (const st of (state.detail && state.detail.steps) || []) for (const p of st.persons || []) if (!known.has(p.id)) known.set(p.id, p.name || p.id);
    const filter = el("input"); filter.type = "search"; filter.placeholder = "Filtrer par nom"; filter.setAttribute("aria-label", "Filtrer les personnes");
    const list = el("div", "cc-person-list");
    const rows = [];
    for (const [id, label] of [...known].sort((a, b) => a[1].localeCompare(b[1], "fr"))) {
      const row = check(label, s.persons.includes(id), (on) => {
        s.persons = on ? [...new Set([...s.persons, id])] : s.persons.filter((x) => x !== id);
        count.textContent = s.persons.length + " désignée" + (s.persons.length > 1 ? "s" : "");
        dirty();
      });
      row.dataset.name = label.toLowerCase();
      rows.push(row); list.append(row);
    }
    filter.addEventListener("input", () => { const q = filter.value.trim().toLowerCase(); for (const r of rows) r.hidden = !!q && !r.dataset.name.includes(q); });
    const count = el("span", "muted", s.persons.length + " désignée" + (s.persons.length > 1 ? "s" : ""));
    box.append(field("Personnes désignées", filter), count, list);
    return box;
  }

  function editorCard(s, i) {
    const card = el("article", "card cc-ed" + (s.active ? "" : " inactive") + (s.kind === "preavis" ? " optional" : ""));
    const head = el("div", "cc-ed-head");
    head.append(pill(TYPE_NAME[s.kind] || s.kind));
    if (!s.active) head.append(pill("désactivée", "off"));
    const label = el("input"); label.type = "text"; label.maxLength = 80; label.value = s.label; label.setAttribute("aria-label", "Libellé de l'étape");
    label.addEventListener("input", () => { s.label = label.value; dirty(); });
    head.append(field("Libellé", label, "grow"));
    if (s.kind !== "preavis") {
      const first = state.steps.findIndex((x) => x.kind !== "preavis");
      const mv = el("div", "cc-moves");
      const up = el("button", "btn btn-outline", "↑"); up.type = "button"; up.title = "Monter"; up.setAttribute("aria-label", "Monter l'étape"); up.disabled = i <= first;
      const down = el("button", "btn btn-outline", "↓"); down.type = "button"; down.title = "Descendre"; down.setAttribute("aria-label", "Descendre l'étape"); down.disabled = i >= state.steps.length - 1;
      const move = (d) => { const t = state.steps[i]; state.steps[i] = state.steps[i + d]; state.steps[i + d] = t; renderEditor(); dirty(); };
      up.addEventListener("click", () => move(-1)); down.addEventListener("click", () => move(1));
      mv.append(up, down);
      head.append(mv);
    }
    card.append(head);

    const opts = el("div", "cc-ed-row");
    if (s.kind !== "preavis") {
      const rule = el("select");
      for (const [v, t] of [["all", "Tous doivent valider"], ["any", "Un seul suffit"]]) { const o = el("option", null, t); o.value = v; rule.append(o); }
      rule.value = s.kind === "visa" ? "any" : s.rule; rule.disabled = s.kind === "visa";
      rule.addEventListener("change", () => { s.rule = rule.value; dirty(); });
      opts.append(field("Règle", rule));
      if (s.kind === "visa") s.blocking = true;
      const bl = el("select");
      for (const [v, t] of [["1", "Bloquant"], ["0", "Consultatif"]]) { const o = el("option", null, t); o.value = v; bl.append(o); }
      bl.value = s.blocking ? "1" : "0"; bl.disabled = s.kind === "visa";
      bl.addEventListener("change", () => { s.blocking = bl.value === "1"; dirty(); });
      opts.append(field("Type d'avis", bl));
    } else opts.append(el("p", "muted", "Facultatif et consultatif, toujours en tête et en parallèle de la première étape bloquante."));
    opts.append(check("Étape active", s.active, (on) => { s.active = on; renderEditor(); dirty(); }));
    card.append(opts);

    if (s.kind !== "preavis") {
      const cond = el("fieldset", "cc-cond-box");
      cond.append(el("legend", null, "Conditions (vide = toujours)"));
      const kinds = s.kinds || KINDS.map((k) => k[0]);
      const row = el("div", "cc-ed-row");
      for (const [k, t] of KINDS) {
        row.append(check(t, kinds.includes(k), (on) => {
          const cur = new Set(s.kinds || KINDS.map((x) => x[0]));
          if (on) cur.add(k); else cur.delete(k);
          s.kinds = cur.size === 3 ? null : [...cur];
          dirty();
        }));
      }
      const md = el("input"); md.type = "number"; md.min = "1"; md.max = "365"; md.step = "1"; md.inputMode = "numeric"; md.placeholder = "toujours"; md.value = s.min_days || "";
      md.addEventListener("input", () => { s.min_days = md.value === "" ? null : Number(md.value); dirty(); });
      row.append(field("À partir de (jours ouvrables)", md));
      cond.append(row);
      card.append(cond);
    }
    if (s.kind === "personnes") {
      card.append(personsPicker(s));
      card.append(check("Remplit la case « avis du chef de service » du formulaire PDF", s.pdf_slot === "chef_service", (on) => {
        for (const x of state.steps) if (x.pdf_slot === "chef_service") x.pdf_slot = null;
        s.pdf_slot = on ? "chef_service" : null;
        renderEditor(); dirty();
      }));
      const del = el("button", "btn btn-outline lt-danger", "Supprimer"); del.type = "button";
      del.addEventListener("click", () => {
        if (!confirm("Supprimer l'étape « " + (s.label || "sans libellé") + " » du circuit ?")) return;
        state.steps.splice(i, 1); renderEditor(); dirty();
      });
      const act = el("div", "btn-row"); act.append(del); card.append(act);
    }
    if (s.kind === "clinique") card.append(el("p", "muted", "Les validateurs de clinique sont désignés par clinique dans « Absences : valideurs »."));
    return card;
  }
  function renderEditor() {
    const box = $("cc-editor");
    box.replaceChildren(...state.steps.map((s, i) => editorCard(s, i)));
  }
  function say(id, txt, kind) { const m = $(id); m.className = "form-msg" + (kind ? " " + kind : ""); m.textContent = txt || ""; }

  function addStep() {
    state.steps.push({ kind: "personnes", label: "Nouvelle étape", rule: "all", blocking: true, active: false, persons: [], kinds: null, min_days: null, pdf_slot: null });
    renderEditor(); dirty();
  }
  async function save() {
    say("cc-ed-msg", "");
    let payload;
    try { payload = serialize(); } catch (e) { return say("cc-ed-msg", e.message, "error"); }
    if (!confirm("Les demandes déjà envoyées gardent leur circuit ; les nouvelles suivront celui-ci.")) return;
    $("cc-save").disabled = true;
    const { data, error } = await sb.rpc("absence_circuit_save", { p_steps: payload, p_circuit: state.sel });
    if (error) { dirty(); return say("cc-ed-msg", error.message, "error"); }
    state.detail = data;
    await refreshOverview();
    loadSteps(data.steps);
    flow(state.overview, data.steps); renderAssign();
    log((data && data.log) || []);
    say("cc-ed-msg", "Circuit enregistré.", "ok");
    if (data && data.warning) { const m = $("cc-ed-msg"); m.append(" "); const w = el("span", null, data.warning); w.style.color = "var(--amber-700)"; m.append(w); }
  }
  function loadSteps(steps) {
    state.steps = fromServer(steps);
    state.orig = snapshot();
    renderEditor(); dirty();
  }
  function cancel() {
    state.steps = JSON.parse(state.orig); say("cc-ed-msg", ""); renderEditor(); dirty();
  }

  // ----- Journal -----
  const stampFmt = new Intl.DateTimeFormat("fr-CH", { timeZone: "Europe/Zurich", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  function stamp(iso) {
    const p = stampFmt.formatToParts(new Date(iso)).reduce((o, x) => (o[x.type] = x.value, o), {});
    return p.day + "." + p.month + "." + p.year + " " + p.hour + ":" + p.minute;
  }
  function log(rows) {
    const box = $("cc-log");
    if (!rows.length) return box.replaceChildren(el("p", "muted", "Aucune modification enregistrée."));
    const ul = el("ul", "cc-log-list");
    for (const r of rows.slice(0, 20)) ul.append(el("li", null, stamp(r.at) + " · " + (r.by_name || "membre inconnu") + " · " + (r.summary || "")));
    box.replaceChildren(ul);
  }

  // ----- Simulateur -----
  function nextMonday() {
    const d = new Date(); d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7));
    return d;
  }
  const iso = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  const fr = (s) => s.split("-").reverse().join(".");

  async function simulate(draft) {
    const sel = $("cc-member");
    const msg = $("cc-msg"); msg.className = "form-msg"; msg.textContent = "";
    $("cc-result").replaceChildren();
    if (!sel.value || !$("cc-from").value || !$("cc-to").value) { msg.className = "form-msg error"; msg.textContent = "Choisissez un membre et deux dates."; return; }
    const from = $("cc-from").value, to = $("cc-to").value, kind = $("cc-kind").value;
    const args = { p_user: sel.value, p_from: from, p_to: to, p_kind: kind };
    if (draft) {
      try { args.p_steps = serialize(); } catch (e) { say("cc-ed-msg", e.message, "error"); return; }
      args.p_circuit = state.sel;
    }
    const { data, error } = await sb.rpc("absence_circuit_simulate", args);
    if (error) {
      msg.className = "form-msg error"; msg.textContent = "Simulation impossible : " + error.message;
      if (draft) say("cc-ed-msg", "Simulation impossible : " + error.message, "error");
      return;
    }
    result(data, from, to, draft);
    $("cc-result").scrollIntoView({ block: "nearest" });
  }
  function form(o) {
    const sel = $("cc-member");
    sel.replaceChildren(...(o.members || []).map((m) => {
      const opt = el("option", null, memberLabel(m));
      opt.value = m.id; return opt;
    }));
    const mon = nextMonday(), fri = new Date(mon); fri.setDate(mon.getDate() + 4);
    $("cc-from").value = iso(mon); $("cc-to").value = iso(fri);
    $("cc-to").min = $("cc-from").value;
    $("cc-from").addEventListener("change", () => { $("cc-to").min = $("cc-from").value; if (!$("cc-to").value || $("cc-to").value < $("cc-from").value) $("cc-to").value = $("cc-from").value; });
    $("cc-form").addEventListener("submit", (ev) => { ev.preventDefault(); simulate(false); });
    $("cc-sim-draft").addEventListener("click", () => simulate(true));
  }

  function result(r, from, to, draft) {
    const box = $("cc-result");
    const head = el("p", null, (draft ? "Circuit en cours de modification (non enregistré) · " : "Circuit enregistré · ") + r.member.name + " (" + (ROLES[r.member.role] || r.member.role) + ") · " + ((r.clinics || []).length ? r.clinics.join(", ") : "aucune clinique à ces dates") + " · " + (KIND_NAME[r.kind] || r.kind) + " · du " + fr(from) + " au " + fr(to));
    const applied = el("p", "cc-applied");
    if (r.circuit) {
      applied.append(el("strong", null, "Circuit appliqué : " + r.circuit.name), " (" + (REASONS[r.circuit.reason] || r.circuit.reason) + (r.circuit.reason === "role" && r.circuit.detail ? " : " + (ROLES[r.circuit.detail] || r.circuit.detail) : r.circuit.detail && r.circuit.reason !== "member" ? " : " + r.circuit.detail : "") + ")");
    }
    const wrap = el("div", "cc-steps");
    r.steps.forEach((s, i) => {
      const n = el("div", "card cc-node" + (s.blocking ? "" : " optional"));
      n.append(el("h3", null, (i + 1) + ". " + s.label));
      n.append(pill(s.blocking ? "bloquant" : "consultatif", s.blocking ? "block" : ""));
      n.append(el("p", null, "Règle : " + s.rule + (s.parallel_with ? " (en parallèle de la première étape bloquante)" : "")));
      n.append(el("p", null, s.people.length ? names(s.people) : "Personne"));
      if (s.pdf_slot === "chef_service") n.append(el("p", null, "Remplit la case « avis du chef de service » du formulaire."));
      if (s.note) n.append(el("p", null, s.note));
      wrap.append(n);
    });
    box.replaceChildren(head, applied, wrap);
    if (draft && r.resolved && r.circuit && r.resolved.id !== r.circuit.id) box.append(el("p", "muted", "Ce membre suit en réalité le circuit « " + r.resolved.name + " » (" + (REASONS[r.resolved.reason] || r.resolved.reason) + ")."));
    if ((r.excluded || []).length) box.append(el("p", "muted", "Étapes non appliquées à cette demande : " + r.excluded.map((x) => x.label + " (" + x.reason + ")").join(", ") + "."));
    if (r.self_excluded) box.append(el("p", "muted", "Ce membre est lui-même désigné validateur d'une de ses cliniques : il est exclu de sa propre validation."));
    box.append(el("p", "muted", r.admin_override));
  }

  // ----- Circuits : sélecteur et gestion -----
  function renderTabs() {
    const box = $("cc-tabs");
    box.replaceChildren(...state.circuits.map((c) => {
      const b = el("button", "cc-tab" + (c.id === state.sel ? " active" : ""), c.name);
      b.type = "button"; b.setAttribute("role", "tab"); b.setAttribute("aria-selected", c.id === state.sel ? "true" : "false");
      b.addEventListener("click", () => selectCircuit(c.id));
      return b;
    }));
    const c = current();
    $("cc-rename").hidden = c.is_default; $("cc-delete").hidden = c.is_default;
    const alt = state.circuits.filter((x) => !x.is_default), i = alt.findIndex((x) => x.id === c.id);
    $("cc-up").hidden = c.is_default; $("cc-down").hidden = c.is_default;
    $("cc-up").disabled = i <= 0; $("cc-down").disabled = i < 0 || i >= alt.length - 1;
    $("cc-flow-title").textContent = "Schéma du circuit : " + c.name;
    $("cc-edit-title").textContent = "Modifier le circuit : " + c.name;
    $("cc-assign-box").hidden = c.is_default;
    const filter = $("cc-who-circuit"), keep = filter.value;
    filter.replaceChildren(...[["", "Tous les circuits"], ...state.circuits.map((x) => [String(x.id), x.name])].map(([v, t]) => { const o = el("option", null, t); o.value = v; return o; }));
    filter.value = [...filter.options].some((o) => o.value === keep) ? keep : "";
  }
  function confirmLeave() { return (snapshot() === state.orig && assignSnapshot() === state.assignOrig) || confirm("Des modifications ne sont pas enregistrées. Les abandonner ?"); }
  async function selectCircuit(id) {
    if (id === state.sel) return;
    if (!confirmLeave()) return;
    state.sel = id;
    say("cc-ed-msg", ""); say("cc-as-msg", ""); say("cc-box-msg", "");
    await loadCircuit();
  }
  async function loadCircuit() {
    const tok = ++state.req;
    const { data, error } = await sb.rpc("absence_circuit_get", { p_circuit: state.sel });
    if (tok !== state.req) return; // réponse d'un clic plus ancien : ignorée
    if (error) return say("cc-ed-msg", "Chargement impossible : " + error.message, "error");
    state.detail = data;
    renderTabs();
    flow(state.overview, data.steps);
    loadSteps(data.steps);
    loadAssign(data.assignments || []);
    log(data.log || []);
  }
  async function refreshOverview() {
    const { data: o } = await sb.rpc("absence_circuit_overview");
    if (o) { state.overview = o; state.circuits = o.circuits || state.circuits; if (!state.circuits.some((c) => c.id === state.sel)) state.sel = (current() || {}).id; warnings(o); table(o); renderTabs(); }
    await loadWho();
  }

  let boxMode = null;
  function openBox(mode) {
    boxMode = mode;
    const c = current();
    $("cc-box").hidden = false;
    $("cc-box-title").textContent = mode === "create" ? "Nouveau circuit" : "Renommer « " + c.name + " »";
    $("cc-box-name").value = mode === "rename" ? c.name : "";
    $("cc-box-copy-wrap").hidden = mode !== "create";
    const copy = $("cc-box-copy");
    copy.replaceChildren(...state.circuits.map((x) => { const o = el("option", null, "Copier : " + x.name); o.value = String(x.id); return o; }));
    copy.value = String(state.sel);
    say("cc-box-msg", "");
    $("cc-box-name").focus();
  }
  function closeBox() { boxMode = null; $("cc-box").hidden = true; say("cc-box-msg", ""); }
  async function submitBox(ev) {
    ev.preventDefault();
    const name = $("cc-box-name").value.trim();
    if (!name) return say("cc-box-msg", "Indiquez un nom (60 caractères au plus).", "error");
    if (boxMode === "create") {
      if (!confirmLeave()) return;
      const { data, error } = await sb.rpc("absence_circuit_create", { p_name: name, p_copy_from: Number($("cc-box-copy").value) || null });
      if (error) return say("cc-box-msg", error.message, "error");
      closeBox(); await refreshOverview(); state.sel = Number(data); await loadCircuit();
      say("cc-ed-msg", "Circuit créé : attribuez-le puis ajustez ses étapes.", "ok");
    } else {
      const { error } = await sb.rpc("absence_circuit_rename", { p_circuit: state.sel, p_name: name });
      if (error) return say("cc-box-msg", error.message, "error");
      // renommage : seul le nom affiché change, les étapes et attributions en cours d'édition sont conservées
      closeBox(); await refreshOverview();
    }
  }
  async function deleteCircuit() {
    const c = current();
    if (c.is_default) return;
    if (!confirm("Supprimer le circuit « " + c.name + " » ? Ses membres suivront le circuit général pour leurs nouvelles demandes ; les demandes en cours gardent leur circuit.")) return;
    const { error } = await sb.rpc("absence_circuit_delete", { p_circuit: c.id });
    if (error) return say("cc-ed-msg", error.message, "error");
    state.orig = snapshot(); state.assignOrig = assignSnapshot();
    state.sel = null; await refreshOverview(); state.sel = (state.circuits.find((x) => x.is_default) || state.circuits[0]).id; await loadCircuit();
  }
  async function moveCircuit(d) {
    const alt = state.circuits.filter((x) => !x.is_default).map((x) => x.id), i = alt.indexOf(state.sel);
    if (i < 0 || i + d < 0 || i + d >= alt.length) return;
    [alt[i], alt[i + d]] = [alt[i + d], alt[i]];
    const { error } = await sb.rpc("absence_circuit_reorder", { p_ids: alt });
    if (error) return say("cc-ed-msg", error.message, "error");
    await refreshOverview();
  }

  // ----- Attributions : « Qui suit ce circuit » -----
  const assignSnapshot = () => JSON.stringify(["member", "role", "clinic"].map((k) => [...state.assign[k]].sort()));
  function loadAssign(list) {
    state.assign = { member: new Set(), role: new Set(), clinic: new Set() };
    for (const a of list) state.assign[a.type].add(a.target);
    state.assignOrig = assignSnapshot();
    renderAssign();
  }
  // cibles déjà prises par un autre circuit : nom de ce circuit
  function takenBy(type, target) {
    for (const c of state.circuits) if (c.id !== state.sel) for (const a of c.assignments || []) if (a.type === type && a.target === target) return c.name;
    return null;
  }
  function pickList(type, title, items) {
    const fs = el("fieldset", "cc-cond-box cc-as-set");
    fs.append(el("legend", null, title));
    const filter = el("input"); filter.type = "search"; filter.placeholder = "Filtrer"; filter.setAttribute("aria-label", "Filtrer : " + title);
    const list = el("div", "cc-person-list"), rows = [];
    const count = el("span", "muted");
    const upd = () => { const n = state.assign[type].size; count.textContent = n + " coché" + (n > 1 ? "s" : ""); $("cc-as-save").disabled = assignSnapshot() === state.assignOrig; $("cc-as-dirty").hidden = assignSnapshot() === state.assignOrig; };
    for (const it of items) {
      const other = takenBy(type, it.id);
      const row = check(it.label + (other ? " · déjà dans « " + other + " »" : ""), state.assign[type].has(it.id), (on) => {
        if (on) state.assign[type].add(it.id); else state.assign[type].delete(it.id);
        upd();
      });
      row.dataset.name = it.label.toLowerCase();
      rows.push(row); list.append(row);
    }
    filter.addEventListener("input", () => { const q = filter.value.trim().toLowerCase(); for (const r of rows) r.hidden = !!q && !r.dataset.name.includes(q); });
    fs.append(filter, count, list);
    upd();
    return fs;
  }
  function renderAssign() {
    const o = state.overview || {};
    const members = [...(o.members || [])].sort((a, b) => a.name.localeCompare(b.name, "fr")).map((m) => ({ id: m.id, label: memberLabel(m) }));
    const roles = ROLE_CODES.map((r) => ({ id: r, label: ROLES[r] || r }));
    const clinics = (o.clinics || []).map((c) => ({ id: c.clinic, label: c.clinic }));
    $("cc-as-lists").replaceChildren(pickList("member", "Membres", members), pickList("role", "Rôles", roles), pickList("clinic", "Cliniques", clinics));
  }
  async function saveAssign() {
    say("cc-as-msg", "");
    const c = current();
    if (c.is_default) return;
    $("cc-as-save").disabled = true;
    const { error } = await sb.rpc("absence_circuit_assign_all", { p_circuit: c.id, p_members: [...state.assign.member], p_roles: [...state.assign.role], p_clinics: [...state.assign.clinic] });
    // dans tous les cas, l'écran est remis d'accord avec la base
    await refreshOverview();
    const { data } = await sb.rpc("absence_circuit_get", { p_circuit: c.id });
    if (data && c.id === state.sel) { state.detail = data; loadAssign(data.assignments || []); log(data.log || []); }
    if (error) return say("cc-as-msg", error.message, "error");
    say("cc-as-msg", "Attributions enregistrées.", "ok");
  }

  // ----- Qui suit quel circuit -----
  async function loadWho() {
    const { data, error } = await sb.rpc("absence_circuit_who");
    if (error) return ($("cc-who-msg").textContent = "Chargement impossible : " + error.message);
    state.who = data || [];
    renderWho();
  }
  function renderWho() {
    const q = $("cc-who-q").value.trim().toLowerCase(), cid = $("cc-who-circuit").value;
    const t = $("cc-who-table");
    const head = el("tr");
    for (const h of ["Membre", "Rôle", "Cliniques", "Circuit", "Raison"]) head.append(el("th", null, h));
    const thead = el("thead"); thead.append(head);
    const body = el("tbody");
    const rows = state.who.filter((w) => (!cid || String(w.circuit_id) === cid) && (!q || (w.name || "").toLowerCase().includes(q) || (w.circuit_name || "").toLowerCase().includes(q)));
    for (const w of rows) {
      const tr = el("tr");
      const reason = el("td", null, REASONS[w.reason] || w.reason);
      if (w.conflict) { const p = pill("conflit", "warn"); p.title = "Plusieurs cliniques mènent à des circuits différents : le mieux placé s'applique"; reason.append(" ", p); }
      tr.append(el("td", null, w.name || ""), el("td", null, ROLES[w.role] || w.role), el("td", null, (w.clinics || []).join(", ")), el("td", null, w.circuit_name || ""), reason);
      body.append(tr);
    }
    t.replaceChildren(thead, body);
    $("cc-who-msg").textContent = rows.length ? rows.length + " membre" + (rows.length > 1 ? "s" : "") : "Aucun membre ne correspond.";
  }

  (async () => {
    if (!sb) return ($("ug-status").textContent = "Service indisponible.");
    const { data } = await sb.auth.getSession();
    if (!data.session) return (location.href = "/fr/the-hive.html");
    $("logout").addEventListener("click", async () => { await sb.auth.signOut(); location.href = "/fr/"; });
    const { data: role } = await sb.rpc("current_role_name");
    if (role !== "admin" && role !== "direction") return ($("ug-status").textContent = "Page réservée à l'administration.");
    const { data: o, error } = await sb.rpc("absence_circuit_overview");
    if (error) return ($("ug-status").textContent = "Chargement impossible : " + error.message);
    state.overview = o; state.circuits = o.circuits || [];
    state.sel = (state.circuits.find((c) => c.is_default) || state.circuits[0] || {}).id;
    $("ug-status").hidden = true;
    $("cc-tool").hidden = false;
    warnings(o); table(o); form(o);
    $("cc-add").addEventListener("click", addStep);
    $("cc-save").addEventListener("click", save);
    $("cc-cancel").addEventListener("click", cancel);
    $("cc-new").addEventListener("click", () => openBox("create"));
    $("cc-rename").addEventListener("click", () => openBox("rename"));
    $("cc-delete").addEventListener("click", deleteCircuit);
    $("cc-up").addEventListener("click", () => moveCircuit(-1));
    $("cc-down").addEventListener("click", () => moveCircuit(1));
    $("cc-box").addEventListener("submit", submitBox);
    $("cc-box-cancel").addEventListener("click", closeBox);
    $("cc-as-save").addEventListener("click", saveAssign);
    $("cc-who-q").addEventListener("input", renderWho);
    $("cc-who-circuit").addEventListener("change", renderWho);
    renderTabs();
    await loadCircuit();
    await loadWho();
  })();
})();
