// Annuaire des médecins : contacts internes (CHUV) et externes, recherche libre (nom, prénom, service, e-mail, numéro).
// Accès : médecins, assistantes, pharmaciens à adresse CHUV, et admins (outil « contacts »). Import et export Excel : admin et pharmacien. Numéros stockés en entier ; raccourcis à 5 chiffres affichés pour le CHUV.
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
  const state = { rows: [], ents: [], entOf: new Map(), me: null, role: "", admin: false, q: "", scopes: new Set(), shown: PAGE, editing: null };

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
  const isPerson = (r) => !!(r.first_name || r.last_name);

  // Regroupement : un numéro par ligne en base, une fiche par entité à l'écran
  const TITLE_BY_DETAIL = new Set(["CCO", "UTI", "UTOH"]);   // la fonction fait le titre (une fiche par fonction)
  const MERGE_ALL = new Set(["Personnel administratif"]);    // tous les numéros sous une seule fiche
  function entityKey(r) {
    const s = norm(r.service);
    if (MERGE_ALL.has(r.service)) return "all|" + s;
    if (isPerson(r)) return ["p", norm(r.last_name), norm(r.first_name), s, norm(r.detail)].join("|");
    if (TITLE_BY_DETAIL.has(r.service)) return ["d", s, norm(r.detail)].join("|");
    return "s|" + s;
  }
  function entityTitle(r) {
    if (MERGE_ALL.has(r.service)) return r.service;
    if (TITLE_BY_DETAIL.has(r.service)) return isPerson(r) ? personName(r) + (r.detail ? ` (${r.detail})` : "") : r.detail || r.service;
    return isPerson(r) ? personName(r) : r.service;
  }
  // Étiquette affichée à côté d'un numéro (pour « Personnel administratif », la personne et sa fonction en font partie)
  function lineLabel(r) {
    const who = MERGE_ALL.has(r.service) && isPerson(r) ? personName(r) + (r.detail ? ` (${r.detail})` : "") : "";
    return [who, r.label].filter(Boolean).join(", ");
  }

  // Numéro complet cliquable, 5 derniers chiffres en gras pour les numéros CHUV
  function phoneLink(phone) {
    const a = el("a", "an-phone");
    a.href = telHref(phone);
    const sh = shortOf(phone);
    if (sh) { a.append((phone.startsWith("+412131") ? "+41 21 31 " : "+41 79 55 "), el("strong", null, spaced5(sh))); }
    else a.textContent = prettyFull(phone);
    return a;
  }
  function numberLine(r, tools) {
    const p = el("p", "an-num");
    if (r.phone) p.append(phoneLink(r.phone));
    const lab = lineLabel(r);
    if (lab) p.append(r.phone ? " " : "", el("span", "muted an-label", lab));
    if (!r.phone) p.append(el("span", "muted", (lab ? " : " : "") + "numéro à renseigner"));
    if (tools) p.append(" ", ...tools);
    return p;
  }

  // ----- Données -----
  async function load() {
    const out = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from("contacts").select("*").order("id").range(from, from + 999);
      if (error) throw error;
      out.push(...data);
      if (data.length < 1000) break;
    }
    const groups = new Map();
    for (const r of out) {
      const sh = shortOf(r.phone);
      r._hay = norm([r.first_name, r.last_name, r.service, r.detail, r.label, r.email, r.notes, SCOPE_LABEL[r.scope]].join(" "));
      r._digits = digits(r.phone) + " " + (sh || "");
      const k = entityKey(r);
      if (!groups.has(k)) groups.set(k, { key: k, rows: [], title: entityTitle(r) });
      groups.get(k).rows.push(r);
    }
    const ents = [...groups.values()];
    for (const e of ents) {
      e.hay = e.title ? norm(e.title) + " " + e.rows.map((r) => r._hay).join(" ") : "";
      e.digits = e.rows.map((r) => r._digits).join(" ");
      e.scopes = new Set(e.rows.map((r) => r.scope));
      e.id = e.rows[0].id;
    }
    ents.sort((a, b) => a.title.localeCompare(b.title, "fr"));
    state.rows = out;
    state.ents = ents;
    state.entOf = new Map(out.map((r) => [r.id, groups.get(entityKey(r))]));
    const set = new Set(out.map((r) => r.service));
    $("an-services").replaceChildren(...[...set].sort((a, b) => a.localeCompare(b, "fr")).map((v) => { const o = el("option"); o.value = v; return o; }));
  }

  // ----- Filtres et recherche -----
  function matches(e) {
    if (state.scopes.size && ![...e.scopes].some((x) => state.scopes.has(x))) return false;
    if (!state.q) return true;
    const terms = norm(state.q).split(" ").filter(Boolean);
    const d = digits(state.q);
    return terms.every((t) => e.hay.includes(t)) || (d.length >= 3 && terms.every((t) => /^[\d+]+$/.test(t)) && e.digits.includes(d));
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
    const list = state.ents.filter(matches);
    $("ug-count").textContent = `${list.length} contact${list.length > 1 ? "s" : ""}` + (list.length !== state.ents.length ? ` sur ${state.ents.length}` : "");
    const box = $("an-list");
    box.replaceChildren();
    if (!list.length) {
      box.append(el("p", "muted", state.rows.length ? "Aucun contact ne correspond à cette recherche." : "L'annuaire est vide pour l'instant."),
        button("Ajouter un contact", "btn btn-outline", () => openForm(null)));
    } else {
      list.slice(0, state.shown).forEach((e) => box.append(card(e)));
      if (list.length > state.shown) box.append(button(`Afficher les ${Math.min(PAGE, list.length - state.shown)} suivants`, "btn btn-outline", () => { state.shown += PAGE; render(); }));
    }
  }

  function card(e) {
    const r0 = e.rows[0];
    const d = el("details", "ug-card an-card");
    d.id = "ct-" + e.id;
    const s = el("summary");
    const head = el("div", "ug-head");
    const top = el("div", "an-top");
    top.append(el("span", "ug-name", e.title));
    head.append(top);
    const meta = el("div", "ug-meta");
    meta.append(badge(SCOPE_LABEL[r0.scope].replace(" (CHUV)", ""), r0.scope === "interne" ? "an-int" : ""));
    const titledByDetail = TITLE_BY_DETAIL.has(r0.service);
    if ((isPerson(r0) || titledByDetail) && !MERGE_ALL.has(r0.service)) meta.append(badge(r0.service, "cg-clinic-badge"));
    if (isPerson(r0) && !titledByDetail && !MERGE_ALL.has(r0.service) && r0.detail) meta.append(badge(r0.detail, "cg-clinic-badge"));
    head.append(meta);
    const nums = e.rows.filter((r) => r.phone);
    if (nums.length) { const box = el("div", "an-nums"); nums.forEach((r) => box.append(numberLine(r))); head.append(box); }
    s.append(head);
    d.append(s);
    d.addEventListener("toggle", () => { if (d.open && !d.dataset.ready) body(d, e); });
    return d;
  }

  function body(d, e) {
    d.dataset.ready = "1";
    const r0 = e.rows[0];
    const b = el("div", "ug-body an-body");
    const dl = el("dl", "ug-dl");
    const add = (k, v) => { if (v) { const dd = el("dd"); dd.append(v); dl.append(el("dt", null, k), dd); } };
    const text = (t) => document.createTextNode(t);
    const link = (t, href) => { const a = el("a", null, t); a.href = href; return a; };
    if (isPerson(r0) && !MERGE_ALL.has(r0.service) && !TITLE_BY_DETAIL.has(r0.service)) { add("Service", text(r0.service)); add("Fonction", r0.detail ? text(r0.detail) : null); }
    const mail = e.rows.find((r) => r.email);
    if (mail) add("E-mail", link(mail.email, "mailto:" + mail.email));
    const notes = [...new Set(e.rows.map((r) => r.notes).filter(Boolean))];
    if (notes.length) add("Remarques", text(notes.join(" ")));
    b.append(dl);
    const list = el("div", "an-lines");
    for (const r of e.rows) {
      const tools = [button("Modifier", "an-mini", () => openForm(r))];
      if (state.admin || r.created_by === state.me.id) tools.push(button("Supprimer", "an-mini lt-danger", () => remove(r)));
      list.append(numberLine(r, tools));
    }
    b.append(el("p", "an-sub", e.rows.length > 1 ? "Numéros" : "Numéro"), list);
    const tools = el("div", "btn-row an-tools");
    tools.append(button("Ajouter un numéro", "btn btn-outline ug-copy", () => openForm(null, { first_name: r0.first_name, last_name: r0.last_name, service: r0.service, detail: r0.detail, scope: r0.scope })));
    b.append(tools);
    b.append(el("p", "muted an-stamp", "Dernière modification : " + fmtDate(Math.max(...e.rows.map((r) => new Date(r.updated_at))))));
    d.append(b);
  }

  // ----- Fiche (création et modification) -----
  const FIELDS = ["first_name", "last_name", "service", "detail", "label", "scope", "phone", "email", "notes"];

  function openForm(r, prefill) {
    state.editing = r || null;
    const f = $("an-form");
    f.reset();
    $("an-form-title").textContent = r ? "Modifier le contact" : "Nouveau contact";
    $("an-form-msg").textContent = ""; $("an-form-msg").className = "form-msg";
    const src = r || prefill || {};
    FIELDS.forEach((k) => { f.elements[k].value = src[k] || ""; });
    if (r && r.phone) { const sh = shortOf(r.phone); if (sh) f.elements.phone.value = sh; }
    similar();
    $("an-dialog").showModal();
    f.elements[r || prefill ? "label" : "first_name"].focus();
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
    if (!confirm(`Supprimer ce numéro (${personName(r) || r.service}${lineLabel(r) ? ", " + lineLabel(r) : ""}) de l'annuaire pour tous les utilisateurs ?`)) return;
    const { error } = await sb.from("contacts").delete().eq("id", r.id);
    if (error) return alert("Suppression refusée : " + error.message);
    await refresh();
  }

  async function refresh(openId) {
    await load();
    render();
    if (openId) {
      const ent = state.entOf.get(openId);
      const d = ent && document.getElementById("ct-" + ent.id);
      if (d) { d.open = true; d.scrollIntoView({ behavior: "smooth", block: "center" }); }
    }
  }

  // ----- Excel : export, modèle, import (admin) -----
  const EXCELJS = "https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js";
  function loadScript(src, global) {
    return new Promise((ok, ko) => {
      if (window[global]) return ok();
      const s = document.createElement("script");
      s.src = src; s.onload = ok; s.onerror = () => ko(new Error("chargement de " + global + " impossible"));
      document.head.append(s);
    });
  }
  const COLS = [["Prénom", 16, "first_name"], ["Nom", 20, "last_name"], ["Service", 36, "service"], ["Précision", 30, "detail"], ["Étiquette", 22, "label"],
    ["Origine", 12, "scope"], ["Téléphone", 18, "phone"], ["E-mail", 30, "email"], ["Remarques", 44, "notes"]];
  function download(buffer, name) {
    const url = URL.createObjectURL(new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    const a = el("a");
    a.href = url; a.download = name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
  async function newSheet(extra) {
    await loadScript(EXCELJS, "ExcelJS");
    const wb = new window.ExcelJS.Workbook();
    const ws = wb.addWorksheet("Contacts");
    ws.columns = COLS.map(([header, width]) => ({ header, width })).concat(extra || []);
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: "frozen", ySplit: 1 }];
    return { wb, ws };
  }
  async function exportXlsx() {
    const { wb, ws } = await newSheet([{ header: "Raccourci CHUV", width: 16 }, { header: "Dernière modification", width: 22 }]);
    for (const r of state.rows) {
      ws.addRow(COLS.map(([, , k]) => (k === "scope" ? SCOPE_LABEL[r.scope].replace(" (CHUV)", "") : r[k] || "")).concat([shortOf(r.phone) || "", fmtDate(r.updated_at)]));
    }
    ws.getColumn(7).numFmt = "@";
    download(await wb.xlsx.writeBuffer(), `annuaire-medecins-${new Date().toISOString().slice(0, 10)}.xlsx`);
  }
  async function templateXlsx() {
    const { wb, ws } = await newSheet();
    ws.addRow(["Anne", "Exemple", "Oncologie", "Cheffe de clinique", "Mobile", "Interne", "62234", "anne.exemple@chuv.ch", "Joignable le matin"]);
    ws.addRow(["", "", "Cardiologie", "", "Garde nuit/WE", "Interne", "+41 21 314 44 24", "", ""]);
    download(await wb.xlsx.writeBuffer(), "modele-annuaire-medecins.xlsx");
  }

  const cellText = (c) => {
    let v = c && c.value;
    if (v && typeof v === "object") v = v.richText ? v.richText.map((t) => t.text).join("") : v.text != null ? v.text : v.result != null ? v.result : "";
    return v == null ? "" : String(v).trim();
  };
  const HEADERS = [["first_name", /^prenom/], ["last_name", /^nom$|^nom de famille/], ["service", /service|departement/], ["detail", /precision|fonction/], ["label", /etiquette|libelle/],
    ["scope", /origine|interne|externe/], ["phone", /tel|numero/], ["email", /mail|courriel/], ["notes", /remarque|note|commentaire/]];
  const parseScope = (v) => { const n = norm(v); return /^int/.test(n) ? "interne" : /^ext/.test(n) ? "externe" : ""; };

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
    if (!map.service) throw new Error("colonne « Service » introuvable");
    const rows = [], issues = [];
    ws.eachRow({ includeEmpty: false }, (row, n) => {
      if (n === 1) return;
      const r = {};
      for (const k of FIELDS) r[k] = map[k] ? cellText(row.getCell(map[k])) : "";
      if (!Object.values(r).some(Boolean)) return;
      const rawScope = r.scope;
      r.scope = parseScope(r.scope);
      const bad = [];
      if (!r.service || r.service.length < 2) bad.push("service manquant");
      if (!r.scope) bad.push(`origine « ${rawScope || "vide"} » (interne ou externe attendu)`);
      if (r.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r.email)) bad.push("e-mail invalide");
      const ph = normPhone(r.phone);
      if (ph.error) bad.push("téléphone invalide"); else r.phone = ph.value || "";
      if (bad.length) issues.push(`Ligne ${n} (${[r.first_name, r.last_name].filter(Boolean).join(" ") || r.service || "vide"}) : ${bad.join(", ")}`); else rows.push(r);
    });
    return { rows, issues };
  }

  const keyOf = (r) => [norm(r.last_name), norm(r.first_name), norm(r.service), norm(r.detail), r.phone || ""].join("|");

  function setupAdmin() {
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
              const { data, error } = await sb.rpc("contacts_import", { p_rows: rows.slice(i, i + 200) });
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
    if (state.role === "admin" || state.role === "pharmacist") setupAdmin();
    render();
    const id = +new URLSearchParams(location.search).get("c");
    if (id) { const ent = state.entOf.get(id); const d = ent && document.getElementById("ct-" + ent.id); if (d) { d.open = true; d.scrollIntoView({ block: "center" }); } }
  })();
})();
