// Annuaire des médecins : contacts internes (CHUV) et externes, recherche libre (nom, prénom, service, e-mail, numéro).
// Accès : médecins et pharmaciens (outil « contacts »). Numéros stockés en entier ; raccourcis à 5 chiffres affichés pour le CHUV.
// Aucune donnée de patient dans l'annuaire.
(function () {
  const cfg = window.ONCONIC_CONFIG || {};
  const sb = window.supabase && cfg.supabaseUrl ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey) : null;
  const PAGE = 100;
  const SCOPES = [["interne", "Interne (CHUV)"], ["externe", "Externe"]];
  const SCOPE_LABEL = Object.fromEntries(SCOPES);
  // Raccourcis CHUV : 4xxxx = +412131xxxxx, 6xxxx = +417955xxxxx
  const PREFIX = { 4: "+412131", 6: "+417955" };

  const $ = (id) => document.getElementById(id);
  const state = { rows: [], me: null, role: "", admin: false, q: "", scopes: new Set(), shown: PAGE, editing: null };

  const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9@.+]+/g, " ").trim();
  const digits = (s) => String(s || "").replace(/\D/g, "");
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
  const fmtDate = (ts) => new Date(ts).toLocaleDateString("fr-CH");

  // ----- Numéros -----
  // Raccourci à 5 chiffres d'un numéro CHUV complet, sinon null
  function shortOf(phone) {
    const p = String(phone || "").replace(/\s/g, "");
    return (p.startsWith("+412131") || p.startsWith("+417955")) && p.length === 12 ? p.slice(7) : null;
  }
  const spaced5 = (c) => c.slice(0, 2) + " " + c.slice(2);
  function prettyFull(phone) {
    const m = /^\+41(\d{2})(\d{3})(\d{2})(\d{2})$/.exec(String(phone || ""));
    return m ? `+41 ${m[1]} ${m[2]} ${m[3]} ${m[4]}` : String(phone || "");
  }
  // Saisie -> numéro complet : 5 chiffres CHUV, 0xx xxx xx xx suisse, ou numéro international tel quel
  function normPhone(v) {
    const t = String(v || "").trim();
    if (!t) return { value: null };
    const compact = t.replace(/[\s.\-()\/]/g, "");
    if (/^\d{5}$/.test(compact)) {
      return PREFIX[compact[0]] ? { value: PREFIX[compact[0]] + compact } : { error: "Numéro à 5 chiffres : il doit commencer par 4 (ligne fixe CHUV) ou 6 (DECT/mobile CHUV)." };
    }
    if (/^0\d{9}$/.test(compact)) return { value: "+41" + compact.slice(1) };
    if (/^00\d{8,}$/.test(compact)) return { value: "+" + compact.slice(2) };
    if (/^\+\d{8,15}$/.test(compact)) return { value: compact };
    return { error: "Téléphone : 5 chiffres du CHUV, ou numéro complet (021 314 44 36, +41 21 314 44 36)." };
  }
  const telHref = (p) => "tel:" + String(p).replace(/[^\d+]/g, "");

  const personName = (r) => [r.first_name, r.last_name].filter(Boolean).join(" ");
  const title = (r) => personName(r) || r.service;

  // ----- Données -----
  async function load() {
    const out = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from("contacts").select("*").order("id").range(from, from + 999);
      if (error) throw error;
      out.push(...data);
      if (data.length < 1000) break;
    }
    for (const r of out) {
      const sh = shortOf(r.phone);
      r._hay = norm([r.first_name, r.last_name, r.service, r.detail, r.email, r.notes, SCOPE_LABEL[r.scope]].join(" "));
      r._digits = digits(r.phone) + " " + (sh || "");
    }
    out.sort((a, b) => a.service.localeCompare(b.service, "fr") || (a.last_name || "").localeCompare(b.last_name || "", "fr") || a.id - b.id);
    state.rows = out;
    const set = new Set(out.map((r) => r.service));
    $("an-services").replaceChildren(...[...set].sort((a, b) => a.localeCompare(b, "fr")).map((v) => { const o = el("option"); o.value = v; return o; }));
  }

  // ----- Filtres et recherche -----
  function matches(r) {
    if (state.scopes.size && !state.scopes.has(r.scope)) return false;
    if (!state.q) return true;
    const terms = norm(state.q).split(" ").filter(Boolean);
    const d = digits(state.q);
    return terms.every((t) => r._hay.includes(t)) || (d.length >= 3 && terms.every((t) => /^[\d+]+$/.test(t)) && r._digits.includes(d));
  }

  function chips(box, list, set) {
    box.replaceChildren(...list.map(([k, label]) => {
      const b = button(label, "ug-chip", () => { set.has(k) ? set.delete(k) : set.add(k); state.shown = PAGE; render(); chips(box, list, set); });
      b.setAttribute("aria-pressed", String(set.has(k)));
      return b;
    }));
  }

  // ----- Affichage -----
  function render() {
    const list = state.rows.filter(matches);
    $("ug-count").textContent = `${list.length} contact${list.length > 1 ? "s" : ""}` + (list.length !== state.rows.length ? ` sur ${state.rows.length}` : "");
    const box = $("an-list");
    box.replaceChildren();
    if (!list.length) {
      box.append(el("p", "muted", state.rows.length ? "Aucun contact ne correspond à cette recherche." : "L'annuaire est vide pour l'instant."),
        button("Ajouter un contact", "btn btn-outline", () => openForm(null)));
    } else {
      list.slice(0, state.shown).forEach((r) => box.append(card(r)));
      if (list.length > state.shown) box.append(button(`Afficher les ${Math.min(PAGE, list.length - state.shown)} suivants`, "btn btn-outline", () => { state.shown += PAGE; render(); }));
    }
  }

  function card(r) {
    const d = el("details", "ug-card an-card");
    d.id = "ct-" + r.id;
    const s = el("summary");
    const head = el("div", "ug-head");
    const top = el("div", "an-top");
    top.append(el("span", "ug-name", title(r)));
    head.append(top);
    const meta = el("div", "ug-meta");
    meta.append(badge(SCOPE_LABEL[r.scope].replace(" (CHUV)", ""), r.scope === "interne" ? "an-int" : ""));
    if (personName(r)) meta.append(badge(r.service, "cg-clinic-badge"));
    if (r.detail) meta.append(badge(r.detail, "cg-clinic-badge"));
    head.append(meta);
    if (r.phone) {
      const sh = shortOf(r.phone);
      const p = el("p", "an-quick");
      const a = el("a", null, sh ? spaced5(sh) : prettyFull(r.phone));
      a.href = telHref(r.phone);
      p.append(a);
      if (sh) p.append(" ", el("span", "muted", prettyFull(r.phone)));
      head.append(p);
    }
    s.append(head);
    d.append(s);
    d.addEventListener("toggle", () => { if (d.open && !d.dataset.ready) body(d, r); });
    return d;
  }

  function body(d, r) {
    d.dataset.ready = "1";
    const b = el("div", "ug-body an-body");
    const dl = el("dl", "ug-dl");
    const add = (k, v) => { if (v) { const dd = el("dd"); dd.append(v); dl.append(el("dt", null, k), dd); } };
    const text = (t) => document.createTextNode(t);
    const link = (t, href) => { const a = el("a", null, t); a.href = href; return a; };
    if (personName(r)) add("Service", text(r.service));
    add("Fonction", r.detail ? text(r.detail) : null);
    if (r.phone) {
      const sh = shortOf(r.phone);
      add("Téléphone", link(sh ? `${spaced5(sh)} (${prettyFull(r.phone)})` : prettyFull(r.phone), telHref(r.phone)));
    }
    if (r.email) add("E-mail", link(r.email, "mailto:" + r.email));
    if (r.notes) add("Remarques", text(r.notes));
    b.append(dl);
    const tools = el("div", "btn-row an-tools");
    tools.append(button("Modifier", "btn btn-outline ug-copy", () => openForm(r)));
    if (state.admin || r.created_by === state.me.id) tools.append(button("Supprimer", "btn btn-outline ug-copy lt-danger", () => remove(r)));
    b.append(tools);
    b.append(el("p", "muted an-stamp", "Dernière modification : " + fmtDate(r.updated_at)));
    d.append(b);
  }

  // ----- Fiche (création et modification) -----
  const FIELDS = ["first_name", "last_name", "service", "detail", "scope", "phone", "email", "notes"];

  function openForm(r) {
    state.editing = r || null;
    const f = $("an-form");
    f.reset();
    $("an-form-title").textContent = r ? "Modifier le contact" : "Nouveau contact";
    $("an-form-msg").textContent = ""; $("an-form-msg").className = "form-msg";
    FIELDS.forEach((k) => { f.elements[k].value = (r && r[k]) || ""; });
    if (r && r.phone) { const sh = shortOf(r.phone); if (sh) f.elements.phone.value = sh; }
    similar();
    $("an-dialog").showModal();
    f.elements[r ? "service" : "first_name"].focus();
  }

  // Évite les doublons : propose les contacts de même nom
  function similar() {
    const box = $("an-similar");
    const f = $("an-form").elements;
    const v = norm([f.first_name.value, f.last_name.value].join(" "));
    const hits = v.length < 4 ? [] : state.rows.filter((r) => (!state.editing || r.id !== state.editing.id) && personName(r) && norm(personName(r)) === v).slice(0, 4);
    box.hidden = !hits.length;
    box.replaceChildren();
    if (!hits.length) return;
    box.append(el("p", null, "Ce contact existe peut-être déjà :"));
    hits.forEach((h) => box.append(el("span", null, `${personName(h)} · ${h.service}`)));
  }

  async function save(e) {
    e.preventDefault();
    const f = $("an-form");
    const msg = $("an-form-msg");
    const err = (t) => { msg.className = "form-msg error"; msg.textContent = t; };
    const v = {};
    FIELDS.forEach((k) => { v[k] = f.elements[k].value.trim() || null; });
    if (!v.service || v.service.length < 2) return err("Le service est obligatoire.");
    if (!v.scope) return err("Choisissez l'origine : interne ou externe.");
    const ph = normPhone(v.phone);
    if (ph.error) return err(ph.error);
    v.phone = ph.value;
    if (v.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.email)) return err("Adresse e-mail invalide.");
    msg.className = "form-msg"; msg.textContent = "Enregistrement…";
    const q = state.editing ? sb.from("contacts").update(v).eq("id", state.editing.id).select("id").single() : sb.from("contacts").insert(v).select("id").single();
    const { data, error } = await q;
    if (error) return err(error.code === "23505" ? "Ce contact existe déjà (même nom, service, précision et numéro)." : "Refusé : " + error.message);
    $("an-dialog").close();
    await refresh(data.id);
  }

  async function remove(r) {
    if (!confirm(`Supprimer « ${title(r)}${r.detail ? " (" + r.detail + ")" : ""} » de l'annuaire pour tous les utilisateurs ?`)) return;
    const { error } = await sb.from("contacts").delete().eq("id", r.id);
    if (error) return alert("Suppression refusée : " + error.message);
    await refresh();
  }

  async function refresh(openId) {
    await load();
    render();
    if (openId) {
      const d = document.getElementById("ct-" + openId);
      if (d) { d.open = true; d.scrollIntoView({ behavior: "smooth", block: "center" }); }
    }
  }

  // ----- Démarrage -----
  (async () => {
    if (!sb) return ($("ug-status").textContent = "Service indisponible.");
    const { data } = await sb.auth.getSession();
    if (!data.session) return (location.href = "/fr/the-hive.html");
    $("logout").addEventListener("click", async () => { await sb.auth.signOut(); location.href = "/fr/"; });
    const { data: profile } = await sb.from("profiles").select("role").eq("id", data.session.user.id).single();
    state.role = profile ? profile.role : "member";
    state.admin = state.role === "admin";
    state.me = { id: data.session.user.id };
    const { data: canUse } = await sb.rpc("has_tool", { p_tool: "contacts" });
    if (state.role !== "admin" && canUse !== true) {
      $("ug-status").textContent = "Cet outil ne fait pas partie de vos accès. Contactez l'administrateur si besoin.";
      return;
    }
    try { await load(); } catch (e) { $("ug-status").textContent = "Chargement impossible : " + e.message; return; }
    $("ug-status").hidden = true;
    $("an-tool").hidden = false;
    chips($("an-f-scope"), SCOPES, state.scopes);
    $("q").addEventListener("input", (e) => { state.q = e.target.value; state.shown = PAGE; render(); });
    $("an-new").addEventListener("click", () => openForm(null));
    $("an-form").addEventListener("submit", save);
    $("an-form").elements.first_name.addEventListener("input", similar);
    $("an-form").elements.last_name.addEventListener("input", similar);
    $("an-cancel").addEventListener("click", () => $("an-dialog").close());
    render();
    const id = +new URLSearchParams(location.search).get("c");
    if (id) { const d = document.getElementById("ct-" + id); if (d) { d.open = true; d.scrollIntoView({ block: "center" }); } }
  })();
})();
