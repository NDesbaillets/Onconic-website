// Circuit de validation des absences : vue en lecture seule et simulateur. Réservé à l'administration (contrôlé aussi en base).
(function () {
  const cfg = window.ONCONIC_CONFIG || {};
  const sb = window.supabase && cfg.supabaseUrl ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey) : null;
  const $ = (id) => document.getElementById(id);
  const ROLES = { clinician: "médecin assistant", cdc: "CDC", cadre: "médecin cadre", direction: "direction", admin: "admin", assistant: "assistante", nurse: "infirmier·ère", pharmacist: "pharmacien·ne" };

  function el(tag, cls, txt) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }
  const pill = (txt, cls) => el("span", "cc-pill" + (cls ? " " + cls : ""), txt);
  const names = (list) => (list || []).map((x) => x.name).join(", ");

  function node(title, pillTxt, blocking, rule, who, optional) {
    const n = el("div", "cc-node" + (optional ? " optional" : ""));
    n.append(el("h3", null, title));
    if (pillTxt) n.append(pill(pillTxt, blocking ? "block" : ""));
    if (rule) n.append(el("p", null, rule));
    if (who) n.append(el("p", null, who));
    return n;
  }

  function flow(o) {
    const dirActive = (o.direction || []).filter((d) => d.has_tool);
    const dirNames = dirActive.length ? names(dirActive) : "Aucun membre direction";
    const visaWho = o.visa_fallback_admins ? "Repli : administrateurs (" + names(o.admins) + ")" : "Direction : " + dirNames;
    const col2 = el("div", "cc-col");
    col2.append(
      node("Pré-avis de la direction", "consultatif", false, "Facultatif, non bloquant, en parallèle de la 1re ligne. Pas de pré-avis si la clinique n'a aucun validateur (la direction vise directement)", o.visa_fallback_admins ? "Aucun pré-avis demandé" : "Direction : " + dirNames, true),
      node("1re ligne : validateurs de clinique", "bloquant", true, "Tous doivent valider ; un refus suffit", "Désignés par clinique (voir le tableau)"));
    const c1 = el("div", "cc-col"); c1.append(node("Envoi de la demande", null, false, null, null));
    const c3 = el("div", "cc-col"); c3.append(node("2e ligne : visa de la direction", "bloquant", true, "Un seul visa suffit", visaWho));
    const c4 = el("div", "cc-col"); c4.append(node("Validée : formulaire PDF", null, false, "Signé par le visa", null));
    const arrow = () => el("span", "cc-arrow", "→");
    $("cc-flow").replaceChildren(c1, arrow(), col2, arrow(), c3, arrow(), c4);
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
    const rows = [el("thead")]; rows[0].append(head);
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
    t.replaceChildren(rows[0], body);
  }

  function nextMonday() {
    const d = new Date(); d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7));
    return d;
  }
  const iso = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  const fr = (s) => s.split("-").reverse().join(".");

  function form(o) {
    const sel = $("cc-member");
    sel.replaceChildren(...(o.members || []).map((m) => {
      const opt = el("option", null, m.name + " · " + (ROLES[m.role] || m.role) + (m.clinics && m.clinics.length ? " · " + m.clinics.join(", ") : ""));
      opt.value = m.id; return opt;
    }));
    const mon = nextMonday(), fri = new Date(mon); fri.setDate(mon.getDate() + 4);
    $("cc-from").value = iso(mon); $("cc-to").value = iso(fri);
    $("cc-to").min = $("cc-from").value;
    $("cc-from").addEventListener("change", () => { $("cc-to").min = $("cc-from").value; if (!$("cc-to").value || $("cc-to").value < $("cc-from").value) $("cc-to").value = $("cc-from").value; });
    $("cc-form").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const msg = $("cc-msg"); msg.className = "form-msg"; msg.textContent = "";
      $("cc-result").replaceChildren();
      if (!sel.value || !$("cc-from").value || !$("cc-to").value) { msg.className = "form-msg error"; msg.textContent = "Choisissez un membre et deux dates."; return; }
      const from = $("cc-from").value, to = $("cc-to").value;
      const { data, error } = await sb.rpc("absence_circuit_simulate", { p_user: sel.value, p_from: from, p_to: to });
      if (error) { msg.className = "form-msg error"; msg.textContent = "Simulation impossible : " + error.message; return; }
      result(data, from, to);
    });
  }

  function result(r, from, to) {
    const box = $("cc-result");
    const head = el("p", null, r.member.name + " (" + (ROLES[r.member.role] || r.member.role) + ") · " + ((r.clinics || []).length ? r.clinics.join(", ") : "aucune clinique à ces dates") + " · du " + fr(from) + " au " + fr(to));
    const wrap = el("div", "cc-steps");
    r.steps.forEach((s, i) => {
      const n = el("div", "card cc-node" + (s.blocking ? "" : " optional"));
      n.append(el("h3", null, (i + 1) + ". " + s.label));
      n.append(pill(s.blocking ? "bloquant" : "consultatif", s.blocking ? "block" : ""));
      n.append(el("p", null, "Règle : " + s.rule + (s.parallel_with ? " (en parallèle de la 1re ligne)" : "")));
      n.append(el("p", null, s.people.length ? names(s.people) : "Personne"));
      if (s.note) n.append(el("p", null, s.note));
      wrap.append(n);
    });
    box.replaceChildren(head, wrap);
    if (r.self_excluded) box.append(el("p", "muted", "Ce membre est lui-même désigné validateur d'une de ses cliniques : il est exclu de sa propre validation."));
    box.append(el("p", "muted", r.admin_override));
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
    $("ug-status").hidden = true;
    $("cc-tool").hidden = false;
    flow(o); warnings(o); table(o); form(o);
  })();
})();
