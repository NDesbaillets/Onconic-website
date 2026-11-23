// Rendu en lecture d'un circuit de validation des absences (résultat de absence_circuit_simulate ou absence_circuit_mine) :
// colonnes d'étapes simultanées, pré-avis, règle, étapes consultatives, personnes et notes. Aucune donnée n'entre par innerHTML.
// Utilisé par le simulateur de /admin/circuit-absences.html et par « Mon circuit de validation » de l'outil Absences.
(function () {
  const ROLES = { clinician: "médecin assistant", cdc: "CDC", cadre: "médecin cadre", direction: "direction", admin: "admin", assistant: "assistante", nurse: "infirmier·ère", pharmacist: "pharmacien·ne" };
  const KIND_NAME = { vacances: "vacances", congres: "congrès", autre: "autre" };
  const TYPE_TAG = { preavis: "pré-avis", clinique: "clinique", visa: "visa", personnes: "personnes", direction: "direction", groupe: "groupe" };
  const REASONS = { member: "nommé", role: "rôle", clinic: "clinique", default: "défaut", draft: "brouillon du circuit sélectionné" };

  function el(tag, cls, txt) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }
  const pill = (txt, cls) => el("span", "cc-pill" + (cls ? " " + cls : ""), txt);
  // Noms d'une étape ; `more` = personnes non listées (mon circuit : douze noms au plus)
  function names(s) {
    const list = (s.people || []).map((x) => x.name).join(", ");
    const more = Number(s.more) || 0;
    if (!more) return list;
    return list + (list ? " " : "") + "et " + more + (more > 1 ? " autres" : " autre");
  }

  function card(s) {
    const c = el("div", "cc-card sim k-" + s.kind + (s.blocking ? "" : " soft"));
    const top = el("div", "cc-card-top");
    top.append(el("span", "cc-tag", TYPE_TAG[s.kind] || s.kind), el("span", "cc-card-label", s.label));
    c.append(top);
    const pills = el("div", "cc-pills");
    if (s.kind !== "visa") pills.append(pill(s.rule_code === "any" ? "un seul" : "tous"));
    if (!s.blocking) pills.append(pill("consultative", "dash"));
    c.append(pills);
    c.append(el("div", "cc-card-who", (s.people || []).length || s.more ? names(s) : "Personne"));
    if (s.pdf_slot === "chef_service") c.append(el("div", "cc-card-note", "Remplit la case « avis du chef de service »."));
    if (s.note) c.append(el("div", "cc-card-note", s.note));
    return c;
  }

  // « Circuit appliqué : nom (raison) »
  function applied(r) {
    const p = el("p", "cc-applied");
    const c = r && r.circuit;
    if (!c) return p;
    const detail = c.reason === "role" && c.detail ? " : " + (ROLES[c.detail] || c.detail) : c.detail && c.reason !== "member" ? " : " + c.detail : "";
    p.append(el("strong", null, "Circuit appliqué : " + c.name), " (" + (REASONS[c.reason] || c.reason) + detail + ")");
    return p;
  }

  // Pré-avis puis colonnes ; tableau de nœuds à insérer dans un conteneur
  function flow(r) {
    const out = [];
    const pre = (r.steps || []).find((s) => s.kind === "preavis");
    if (pre) {
      const p = el("div", "cc-pre sim" + ((pre.people || []).length ? "" : " off"));
      p.append(el("span", "cc-switch-text", pre.label + " (consultatif)"), el("span", "cc-pre-who", (pre.people || []).length ? names(pre) : pre.note || "Personne"));
      out.push(p);
    }
    let cols = r.columns;
    if (!Array.isArray(cols)) {
      const m = new Map();
      for (const s of (r.steps || []).filter((x) => x.kind !== "preavis")) { const c = s.col != null ? s.col : s.pos; if (!m.has(c)) m.set(c, []); m.get(c).push(s); }
      cols = [...m.entries()].sort((a, b) => a[0] - b[0]).map(([col, steps]) => ({ col, steps, note: null }));
    }
    const row = el("div", "cc-builder sim");
    cols.forEach((c, i) => {
      if (i) row.append(el("div", "cc-gap sim"));
      const ce = el("div", "cc-col");
      ce.append(el("div", "cc-col-head", "Colonne " + (i + 1) + ((c.steps || []).length > 1 ? " · simultanées" : "")));
      const stack = el("div", "cc-stack");
      for (const s of c.steps || []) stack.append(card(s));
      ce.append(stack);
      if (c.note) ce.append(el("div", "cc-card-note", c.note));
      row.append(ce);
    });
    out.push(row);
    return out;
  }

  // Remarques sous le schéma : étapes écartées, validateur exclu de sa propre validation, droit de l'administration
  function notes(r) {
    const out = [];
    if ((r.excluded || []).length) out.push(el("p", "cc-hint", "Étapes non appliquées à cette demande : " + r.excluded.map((x) => x.label + " (" + x.reason + ")").join(", ") + "."));
    if (r.self_excluded) out.push(el("p", "cc-hint", "Ce membre est lui-même désigné validateur d'une de ses cliniques : il est exclu de sa propre validation."));
    if (r.admin_override) out.push(el("p", "cc-hint", r.admin_override));
    return out;
  }

  window.CircuitView = { ROLES, KIND_NAME, REASONS, applied, flow, notes };
})();
