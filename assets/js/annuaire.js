// Annuaire des prestataires : recherche, filtres, favoris, fiches modifiables par tous, import et export Excel (admin).
// Accès : médecins, assistantes, pharmaciens (outil « annuaire »). Aucune donnée de patient dans l'annuaire.
(function () {
  const cfg = window.ONCONIC_CONFIG || {};
  const sb = window.supabase && cfg.supabaseUrl ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey) : null;
  const EXCELJS = "https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js";
  const PAGE = 100;

  const SCOPES = [["interne", "Interne (CHUV)"], ["externe", "Externe"]];
  const CATS = [["imagerie", "Centre d'imagerie"], ["laboratoire", "Laboratoire"], ["cabinet", "Cabinet médical"], ["autre", "Autres"]];
  const SCOPE_LABEL = Object.fromEntries(SCOPES), CAT_LABEL = Object.fromEntries(CATS);
  const SUGGESTED_SUBTYPES = ["CMS", "Soins à domicile", "Radiologie", "IRM", "Scanner", "Médecine nucléaire", "Médecin généraliste", "Pharmacie", "EMS"];

  const $ = (id) => document.getElementById(id);
  const state = {
    rows: [], favs: new Set(), me: null, role: "", admin: false,
    q: "", scopes: new Set(), cats: new Set(), showFilters: false, showFavs: false, shown: PAGE, editing: null
  };

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
  const YEAR_MS = 365 * 864e5;

  // ----- Données -----
  async function load() {
    const out = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from("providers").select("*").order("name").range(from, from + 999);
      if (error) throw error;
      out.push(...data);
      if (data.length < 1000) break;
    }
    for (const r of out) {
      r._hay = norm([r.name, r.subtype, SCOPE_LABEL[r.scope], CAT_LABEL[r.category], r.address, r.email, r.website, r.contact, r.notes].join(" "));
      r._digits = digits([r.phone, r.phone_alt].join(" "));
    }
    out.sort((a, b) => a.name.localeCompare(b.name, "fr"));
    state.rows = out;
    const { data: favs } = await sb.from("provider_favorites").select("provider_id");
    state.favs = new Set((favs || []).map((f) => f.provider_id));
    fillSubtypes();
  }

  function fillSubtypes() {
    const set = new Set(SUGGESTED_SUBTYPES);
    for (const r of state.rows) if (r.subtype) set.add(r.subtype);
    $("an-subtypes").replaceChildren(...[...set].sort((a, b) => a.localeCompare(b, "fr")).map((v) => { const o = el("option"); o.value = v; return o; }));
  }

  // ----- Filtres et recherche -----
  function matches(r) {
    if (state.scopes.size && !state.scopes.has(r.scope)) return false;
    if (state.cats.size && !state.cats.has(r.category)) return false;
    if (!state.q) return true;
    const terms = norm(state.q).split(" ").filter(Boolean);
    const d = digits(state.q);
    return terms.every((t) => r._hay.includes(t)) || (d.length >= 3 && terms.every((t) => /^[\d+]+$/.test(t)) && r._digits.includes(d));
  }
  const activeFilters = () => state.scopes.size + state.cats.size;

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
    const n = activeFilters();
    $("an-fcount").textContent = n ? `(${n})` : "";
    $("an-favcount").textContent = state.favs.size ? `(${state.favs.size})` : "";
    $("ug-count").textContent = `${list.length} prestataire${list.length > 1 ? "s" : ""}` + (list.length !== state.rows.length ? ` sur ${state.rows.length}` : "");
    const box = $("an-list");
    box.replaceChildren();
    if (!list.length) {
      const p = el("p", "muted", state.rows.length ? "Aucun prestataire ne correspond à cette recherche." : "L'annuaire est vide pour l'instant.");
      box.append(p, button("Ajouter un prestataire", "btn btn-outline", () => openForm(null, state.q ? { name: state.q } : null)));
    } else {
      list.slice(0, state.shown).forEach((r) => box.append(card(r)));
      if (list.length > state.shown) box.append(button(`Afficher les ${Math.min(PAGE, list.length - state.shown)} suivants`, "btn btn-outline", () => { state.shown += PAGE; render(); }));
    }
    renderFavs();
  }

  function renderFavs() {
    $("an-favs").hidden = !state.showFavs;
    $("an-fav-btn").setAttribute("aria-expanded", String(state.showFavs));
    if (!state.showFavs) return;
    const box = $("an-fav-list");
    const favs = state.rows.filter((r) => state.favs.has(r.id));
    box.replaceChildren();
    if (!favs.length) { box.append(el("p", "muted", "Aucun favori : touchez l'étoile d'une fiche pour l'ajouter ici.")); return; }
    favs.forEach((r) => box.append(card(r, "fv-")));
  }

  const telHref = (p) => "tel:" + String(p).replace(/[^\d+]/g, "");
  const mapsHref = (a) => "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(a.replace(/\s*\n\s*/g, ", "));
  function link(text, href, ext) {
    const a = el("a", null, text);
    a.href = href;
    if (ext) { a.target = "_blank"; a.rel = "noopener noreferrer"; }
    return a;
  }

  function card(r, prefix) {
    const d = el("details", "ug-card an-card");
    d.id = (prefix || "pr-") + r.id;
    const s = el("summary");
    const head = el("div", "ug-head");
    const top = el("div", "an-top");
    top.append(el("span", "ug-name", r.name));
    head.append(top);
    const meta = el("div", "ug-meta");
    meta.append(badge(SCOPE_LABEL[r.scope].replace(" (CHUV)", ""), r.scope === "interne" ? "an-int" : ""), badge(CAT_LABEL[r.category]));
    if (r.subtype) meta.append(badge(r.subtype, "cg-clinic-badge"));
    if (Date.now() - new Date(r.updated_at).getTime() > YEAR_MS) meta.append(badge("À vérifier", "ug-warn"));
    head.append(meta);
    if (r.phone) { const p = el("p", "an-quick"); p.append(link(r.phone, telHref(r.phone))); head.append(p); }
    const star = el("button", "an-star", state.favs.has(r.id) ? "★" : "☆");
    star.type = "button";
    star.setAttribute("aria-pressed", String(state.favs.has(r.id)));
    star.setAttribute("aria-label", (state.favs.has(r.id) ? "Retirer des favoris : " : "Ajouter aux favoris : ") + r.name);
    star.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); toggleFav(r); });
    s.append(head, star);
    d.append(s);
    d.addEventListener("toggle", () => { if (d.open && !d.dataset.ready) body(d, r); });
    return d;
  }

  function body(d, r) {
    d.dataset.ready = "1";
    const b = el("div", "ug-body an-body");
    const dl = el("dl", "ug-dl");
    const add = (k, v) => { if (v) { const dd = el("dd"); dd.append(v); dl.append(el("dt", null, k), dd); } };
    const nl = (t) => { const f = document.createDocumentFragment(); String(t).split(/\n/).forEach((line, i) => { if (i) f.append(el("br")); f.append(line); }); return f; };
    if (r.address) { const f = document.createDocumentFragment(); f.append(nl(r.address), " "); f.append(link("Plan", mapsHref(r.address), true)); add("Adresse", f); }
    if (r.phone) add("Téléphone", link(r.phone, telHref(r.phone)));
    if (r.phone_alt) add("Autre numéro", document.createTextNode(r.phone_alt));
    if (r.email) add("E-mail", link(r.email, "mailto:" + r.email));
    if (r.website) add("Site web", link(r.website.replace(/^https?:\/\//, ""), r.website, true));
    if (r.contact) add("Contact", document.createTextNode(r.contact));
    if (r.notes) add("Remarques", nl(r.notes));
    b.append(dl);
    const tools = el("div", "btn-row an-tools");
    tools.append(button("Modifier", "btn btn-outline ug-copy", () => openForm(r)));
    if (state.admin || r.created_by === state.me.id) tools.append(button("Supprimer", "btn btn-outline ug-copy lt-danger", () => remove(r)));
    b.append(tools);
    b.append(el("p", "muted an-stamp", "Dernière modification : " + fmtDate(r.updated_at)));
    d.append(b);
  }

  // ----- Favoris -----
  async function toggleFav(r) {
    const on = state.favs.has(r.id);
    const { error } = on
      ? await sb.from("provider_favorites").delete().eq("provider_id", r.id)
      : await sb.from("provider_favorites").insert({ provider_id: r.id });
    if (error) return alert("Impossible de modifier les favoris : " + error.message);
    on ? state.favs.delete(r.id) : state.favs.add(r.id);
    const open = new Set([...document.querySelectorAll(".an-card[open]")].map((x) => x.id));
    render();
    document.querySelectorAll(".an-card").forEach((x) => { if (open.has(x.id)) x.open = true; });
  }

  // ----- Fiche (création et modification) -----
  const FIELDS = ["name", "scope", "category", "subtype", "address", "phone", "phone_alt", "email", "website", "contact", "notes"];

  function openForm(r, prefill) {
    state.editing = r || null;
    const f = $("an-form");
    f.reset();
    $("an-form-title").textContent = r ? "Modifier le prestataire" : "Nouveau prestataire";
    $("an-form-msg").textContent = ""; $("an-form-msg").className = "form-msg";
    const src = r || prefill || {};
    FIELDS.forEach((k) => { f.elements[k].value = src[k] || ""; });
    similar();
    $("an-dialog").showModal();
    f.elements.name.focus();
  }

  // Évite les doublons : propose les fiches au nom proche
  function similar() {
    const box = $("an-similar");
    const v = norm($("an-form").elements.name.value);
    const hits = v.length < 3 ? [] : state.rows.filter((r) => (!state.editing || r.id !== state.editing.id) && (norm(r.name).includes(v) || v.includes(norm(r.name)))).slice(0, 4);
    box.hidden = !hits.length;
    box.replaceChildren();
    if (!hits.length) return;
    box.append(el("p", null, "Cette fiche existe peut-être déjà :"));
    hits.forEach((h) => box.append(el("span", null, `${h.name}${h.address ? " · " + h.address.split("\n")[0] : ""}`)));
  }

  function clean(f) {
    const v = {};
    FIELDS.forEach((k) => { v[k] = f.elements[k].value.trim() || null; });
    return v;
  }

  async function save(e) {
    e.preventDefault();
    const f = $("an-form");
    const msg = $("an-form-msg");
    const err = (t) => { msg.className = "form-msg error"; msg.textContent = t; };
    const v = clean(f);
    if (!v.name || v.name.length < 2) return err("Le nom est obligatoire.");
    if (!v.scope) return err("Choisissez l'origine : interne ou externe.");
    if (!v.category) return err("Choisissez une catégorie.");
    if (v.phone && !/^[\d\s+().\/-]{3,40}$/.test(v.phone)) return err("Téléphone : chiffres, espaces et + ( ) . / - uniquement.");
    if (v.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.email)) return err("Adresse e-mail invalide.");
    if (v.website && !/^https?:\/\/\S+$/.test(v.website)) return err("Site web : adresse complète commençant par https://");
    msg.className = "form-msg"; msg.textContent = "Enregistrement…";
    const q = state.editing ? sb.from("providers").update(v).eq("id", state.editing.id).select("id").single() : sb.from("providers").insert(v).select("id").single();
    const { data, error } = await q;
    if (error) return err(error.code === "23505" ? "Ce prestataire existe déjà (même nom et même adresse)." : "Refusé : " + error.message);
    $("an-dialog").close();
    await refresh(data.id);
  }

  async function remove(r) {
    if (!confirm(`Supprimer « ${r.name} » de l'annuaire pour tous les utilisateurs ?`)) return;
    const { error } = await sb.from("providers").delete().eq("id", r.id);
    if (error) return alert("Suppression refusée : " + error.message);
    await refresh();
  }

  async function refresh(openId) {
    await load();
    render();
    if (openId) {
      const d = document.getElementById("pr-" + openId);
      if (d) { d.open = true; d.scrollIntoView({ behavior: "smooth", block: "center" }); }
    }
  }

  // ----- Excel : export, modèle, import (admin) -----
  function loadScript(src, global) {
    return new Promise((ok, ko) => {
      if (window[global]) return ok();
      const s = document.createElement("script");
      s.src = src; s.onload = ok; s.onerror = () => ko(new Error("chargement de " + global + " impossible"));
      document.head.append(s);
    });
  }
  const COLS = [["Nom", 36, "name"], ["Origine", 12, "scope"], ["Catégorie", 18, "category"], ["Précision", 22, "subtype"], ["Adresse", 40, "address"],
    ["Téléphone rapide", 20, "phone"], ["Autre téléphone", 24, "phone_alt"], ["E-mail", 30, "email"], ["Site web", 30, "website"],
    ["Contact", 26, "contact"], ["Remarques", 44, "notes"]];
  function download(buffer, name) {
    const url = URL.createObjectURL(new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    const a = el("a");
    a.href = url; a.download = name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
  async function sheet(rows) {
    await loadScript(EXCELJS, "ExcelJS");
    const wb = new window.ExcelJS.Workbook();
    const ws = wb.addWorksheet("Prestataires");
    ws.columns = COLS.map(([header, width]) => ({ header, width })).concat(rows ? [{ header: "Dernière modification", width: 22 }] : []);
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: "frozen", ySplit: 1 }];
    for (const r of rows || []) {
      ws.addRow(COLS.map(([, , k]) => (k === "scope" ? SCOPE_LABEL[r.scope].replace(" (CHUV)", "") : k === "category" ? CAT_LABEL[r.category] : r[k] || "")).concat([fmtDate(r.updated_at)]));
    }
    return wb.xlsx.writeBuffer();
  }
  async function exportXlsx() {
    download(await sheet(state.rows), `annuaire-prestataires-${new Date().toISOString().slice(0, 10)}.xlsx`);
  }
  async function templateXlsx() {
    await loadScript(EXCELJS, "ExcelJS");
    const wb = new window.ExcelJS.Workbook();
    const ws = wb.addWorksheet("Prestataires");
    ws.columns = COLS.map(([header, width]) => ({ header, width }));
    ws.getRow(1).font = { bold: true };
    ws.addRow(["Exemple SA", "Externe", "Centre d'imagerie", "IRM", "Rue de l'Exemple 1\n1000 Lausanne", "021 000 00 00", "", "info@exemple.ch", "https://exemple.ch", "Secrétariat", "Rendez-vous du lundi au vendredi"]);
    download(await wb.xlsx.writeBuffer(), "modele-annuaire-prestataires.xlsx");
  }

  const cellText = (c) => {
    let v = c && c.value;
    if (v && typeof v === "object") v = v.richText ? v.richText.map((t) => t.text).join("") : v.text != null ? v.text : v.result != null ? v.result : "";
    return v == null ? "" : String(v).trim();
  };
  const HEADERS = [["name", /^(nom|prestataire|name)/], ["scope", /origine|interne|externe/], ["category", /categorie/], ["subtype", /precision|sous.?type|type precis/],
    ["address", /adresse/], ["phone_alt", /autre.*(tel|num)|urgence|apres/], ["phone", /tel|numero|rapide/], ["email", /mail|courriel/],
    ["website", /site|web|url/], ["contact", /contact/], ["notes", /remarque|note|commentaire/]];

  function parseScope(v) { const n = norm(v); return /^int/.test(n) ? "interne" : /^ext/.test(n) ? "externe" : ""; }
  function parseCat(v) {
    const n = norm(v);
    if (/imagerie|radiolog|irm|scanner/.test(n)) return "imagerie";
    if (/labo/.test(n)) return "laboratoire";
    if (/cabinet/.test(n)) return "cabinet";
    return n ? "autre" : "";
  }

  async function readWorkbook(file) {
    await loadScript(EXCELJS, "ExcelJS");
    const wb = new window.ExcelJS.Workbook();
    await wb.xlsx.load(await file.arrayBuffer());
    const ws = wb.worksheets[0];
    if (!ws) throw new Error("classeur vide");
    const map = {};
    ws.getRow(1).eachCell((c, i) => {
      const h = norm(cellText(c));
      const hit = HEADERS.find(([k, re]) => re.test(h) && !(k in map));
      if (hit) map[hit[0]] = i;
    });
    if (!map.name) throw new Error("colonne « Nom » introuvable");
    const rows = [], issues = [];
    ws.eachRow({ includeEmpty: false }, (row, n) => {
      if (n === 1) return;
      const r = {};
      for (const k of FIELDS) r[k] = map[k] ? cellText(row.getCell(map[k])) : "";
      if (!Object.values(r).some(Boolean)) return;
      const raw = { scope: r.scope, category: r.category };
      r.scope = parseScope(r.scope); r.category = parseCat(r.category);
      const bad = [];
      if (!r.name || r.name.length < 2) bad.push("nom manquant");
      if (!r.scope) bad.push(`origine « ${raw.scope || "vide"} » (interne ou externe attendu)`);
      if (!r.category) bad.push("catégorie manquante");
      if (r.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r.email)) bad.push("e-mail invalide");
      if (r.website && !/^https?:\/\//.test(r.website)) r.website = /^[\w.-]+\.[a-z]{2,}/i.test(r.website) ? "https://" + r.website : bad.push("site web invalide") && r.website;
      if (r.phone && !/^[\d\s+().\/-]{3,40}$/.test(r.phone)) bad.push("téléphone invalide");
      if (bad.length) issues.push(`Ligne ${n} (${r.name || "sans nom"}) : ${bad.join(", ")}`); else rows.push(r);
    });
    return { rows, issues };
  }

  const keyOf = (r) => norm(r.name) + "|" + norm(String(r.address || "").replace(/\s+/g, " "));

  function setupAdmin() {
    state.admin = true;
    $("an-admin").hidden = false;
    $("an-export").addEventListener("click", exportXlsx);
    $("an-template").addEventListener("click", templateXlsx);
    const msg = $("an-import-msg"), box = $("an-import-preview");
    $("an-file").addEventListener("change", async (e) => {
      const file = e.target.files[0];
      box.replaceChildren(); msg.className = "form-msg"; msg.textContent = "";
      if (!file) return;
      msg.textContent = "Lecture du fichier…";
      try {
        const { rows, issues } = await readWorkbook(file);
        const existing = new Set(state.rows.map(keyOf));
        const fresh = rows.filter((r) => !existing.has(keyOf(r))).length;
        msg.textContent = `${rows.length} ligne${rows.length > 1 ? "s" : ""} valide${rows.length > 1 ? "s" : ""} : ${fresh} nouvelle${fresh > 1 ? "s" : ""}, ${rows.length - fresh} à mettre à jour.` + (issues.length ? ` ${issues.length} ligne${issues.length > 1 ? "s" : ""} à corriger.` : "");
        msg.className = "form-msg " + (issues.length ? "error" : "ok");
        if (issues.length) { const ul = el("ul", "lt-issues"); issues.slice(0, 30).forEach((t) => ul.append(el("li", null, t))); if (issues.length > 30) ul.append(el("li", null, `… et ${issues.length - 30} autres`)); box.append(ul); }
        if (rows.length) box.append(button(`Importer ${rows.length} ligne${rows.length > 1 ? "s" : ""}`, "btn", async (ev) => {
          ev.target.disabled = true; msg.className = "form-msg"; let ins = 0, upd = 0;
          try {
            for (let i = 0; i < rows.length; i += 200) {
              msg.textContent = `Import… ${Math.min(i + 200, rows.length)} sur ${rows.length}`;
              const { data, error } = await sb.rpc("providers_import", { p_rows: rows.slice(i, i + 200) });
              if (error) throw error;
              ins += data.inserted; upd += data.updated;
            }
            msg.className = "form-msg ok"; msg.textContent = `Import terminé : ${ins} ajoutée${ins > 1 ? "s" : ""}, ${upd} mise${upd > 1 ? "s" : ""} à jour.`;
            box.replaceChildren(); $("an-file").value = "";
            await refresh();
          } catch (x) { msg.className = "form-msg error"; msg.textContent = "Import refusé : " + x.message; ev.target.disabled = false; }
        }));
      } catch (x) { msg.className = "form-msg error"; msg.textContent = "Lecture impossible : " + x.message; }
    });
  }

  // ----- Démarrage -----
  (async () => {
    if (!sb) return ($("ug-status").textContent = "Service indisponible.");
    const { data } = await sb.auth.getSession();
    if (!data.session) return (location.href = "/fr/the-hive.html");
    $("logout").addEventListener("click", async () => { await sb.auth.signOut(); location.href = "/fr/"; });
    const { data: profile } = await sb.from("profiles").select("role").eq("id", data.session.user.id).single();
    state.role = profile ? profile.role : "member";
    state.me = { id: data.session.user.id };
    const { data: canUse } = await sb.rpc("has_tool", { p_tool: "annuaire" });
    if (state.role !== "admin" && canUse !== true) {
      $("ug-status").textContent = "Cet outil ne fait pas partie de vos accès. Contactez l'administrateur si besoin.";
      return;
    }
    try { await load(); } catch (e) { $("ug-status").textContent = "Chargement impossible : " + e.message; return; }
    $("ug-status").hidden = true;
    $("an-tool").hidden = false;
    chips($("an-f-scope"), SCOPES, state.scopes);
    chips($("an-f-cat"), CATS, state.cats);
    $("q").addEventListener("input", (e) => { state.q = e.target.value; state.shown = PAGE; render(); });
    $("an-filter-btn").addEventListener("click", (e) => {
      state.showFilters = !state.showFilters;
      $("an-filters").hidden = !state.showFilters;
      e.currentTarget.setAttribute("aria-expanded", String(state.showFilters));
    });
    $("an-f-clear").addEventListener("click", () => {
      state.scopes.clear(); state.cats.clear(); state.shown = PAGE;
      chips($("an-f-scope"), SCOPES, state.scopes); chips($("an-f-cat"), CATS, state.cats); render();
    });
    $("an-fav-btn").addEventListener("click", () => { state.showFavs = !state.showFavs; renderFavs(); });
    $("an-new").addEventListener("click", () => openForm(null, state.q ? { name: state.q } : null));
    $("an-form").addEventListener("submit", save);
    $("an-form").elements.name.addEventListener("input", similar);
    $("an-cancel").addEventListener("click", () => $("an-dialog").close());
    if (state.role === "admin" || state.role === "pharmacist" || state.role === "direction") setupAdmin();
    render();
    const id = +new URLSearchParams(location.search).get("p");
    if (id) { const d = document.getElementById("pr-" + id); if (d) { d.open = true; d.scrollIntoView({ block: "center" }); } }
  })();
})();
