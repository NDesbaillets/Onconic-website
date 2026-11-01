// Lettres médicales d'attitude (accès « médecin plus »).
// La saisie reste dans le navigateur ; seule la génération passe par l'Edge Function medical-letter (Claude Haiku).
// Rien n'est stocké : pas de localStorage, pas d'enregistrement des cas. Seuls les modèles de traitement sont en base.
(function () {
  const cfg = window.ONCONIC_CONFIG || {};
  const sb = window.supabase && cfg.supabaseUrl ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey) : null;
  const MAMMOTH = "https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js";
  const DOCX = "https://cdn.jsdelivr.net/npm/docx@9.5.1/dist/index.iife.js";
  const FN = (cfg.supabaseUrl || "") + "/functions/v1/medical-letter";
  const CLINICS = ["Sénologie", "Gynécologie", "Urologie", "Thoracique", "Neuro-oncologie", "Mélanome",
    "Lower GI", "Upper GI", "ORL", "Sarcomes", "Radiologie interventionnelle"];
  const FIELDS = ["clinic", "sex", "age", "ecog", "histo", "markers", "tnm", "stage", "comorbid", "circumstances", "current",
    "family", "habits", "social", "attitude", "trial", "details"];

  const $ = (id) => document.getElementById(id);
  const state = { templates: [], brands: {}, trials: [], stageAuto: "", admin: false, match: null, denovo: false, example: null, last: null, cache: new Map() };

  function el(tag, cls, txt) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }
  const button = (label, cls, fn) => { const b = el("button", cls, label); b.type = "button"; b.addEventListener("click", fn); return b; };
  function loadScript(src, global) {
    return new Promise((ok, ko) => {
      if (window[global]) return ok();
      const s = document.createElement("script");
      s.src = src; s.onload = ok; s.onerror = () => ko(new Error("chargement de " + global + " impossible"));
      document.head.append(s);
    });
  }

  // ----- Données identifiantes : mêmes règles que l'Edge Function -----
  const MONTHS = "janvier|février|fevrier|mars|avril|mai|juin|juillet|août|aout|septembre|octobre|novembre|décembre|decembre";
  const PII = [
    ["une date complète (écrire le mois et l'année seulement)", new RegExp(String.raw`\b\d{1,2}\s*[./-]\s*\d{1,2}\s*[./-]\s*\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}(?:er)?\s+(?:${MONTHS})\s+\d{4}\b`, "i")],
    ["une date de naissance", /\bn[ée]e?\s+(?:le|en)\b|\bdate\s+de\s+naissance\b|\bDDN\b/i],
    ["un numéro AVS", /\b756[.\s]?\d{4}[.\s]?\d{4}[.\s]?\d{2}\b/],
    ["un identifiant numérique (IPP, NIP…)", /\b\d{6,}\b/],
    ["une adresse e-mail", /[\w.+-]+@[\w-]+\.[\w.]+/],
    ["un numéro de téléphone", /(?:\+41|0041|\b0)\s?\d{2}\s?\d{3}\s?\d{2}\s?\d{2}\b/],
    ["un nom de personne", /\b(?:M\.|Mme|Mlle|Monsieur|Madame|Dr|Dre|Docteur|Doctoresse|Pr|Prof\.?)\s+[A-ZÀ-Ý][a-zà-ÿ'-]+/]
  ];
  const piiOf = (v) => PII.filter(([, re]) => re.test(v)).map(([k]) => k);

  function checkPii() {
    const msgs = [];
    for (const id of FIELDS) {
      const f = $(id);
      const hits = f.value ? piiOf(f.value) : [];
      f.classList.toggle("ml-bad", hits.length > 0);
      f.setAttribute("aria-invalid", String(hits.length > 0));
      if (hits.length) msgs.push(`${labelOf(f)} : ${hits.join(", ")}`);
    }
    $("ml-pii").textContent = msgs.length ? "Retirez avant l'envoi : " + msgs.join(" ; ") : "";
    return !msgs.length;
  }
  const labelOf = (f) => (f.closest("label") ? f.closest("label").firstChild.textContent.trim() : f.id);

  // ----- Correspondance attitude ↔ lettres types -----
  const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean)
    .map((w) => (w.length > 5 ? w.replace(/e$/, "") : w)).join(" ");
  const has = (hay, needle) => needle && (" " + hay + " ").includes(" " + needle + " ");

  function prepare(rows) {
    for (const t of rows) {
      t._drugs = (t.drugs || []).map(norm).filter(Boolean);
      t._trial = norm(t.trial);
      t._clinic = norm(t.clinic);
    }
    state.templates = rows;
  }

  function scoreAll() {
    let att = norm($("attitude").value);
    // Noms commerciaux → DCI (dictionnaire des lettres d'assurance, si accessible)
    for (const [brand, dci] of Object.entries(state.brands)) if (has(att, brand)) att += " " + dci;
    const clinic = norm($("clinic").value);
    return state.templates.filter((t) => t.status === "validated").map((t) => {
      const hit = t._drugs.filter((d) => has(att, d)).length;
      const cov = t._drugs.length ? hit / t._drugs.length : 0;
      const trial = t._trial && has(att, t._trial) ? 1 : 0;
      return { t, hit, cov, trial, same: t._clinic && t._clinic === clinic ? 1 : 0 };
    }).filter((m) => m.trial || (m.hit && m.cov >= 0.5))
      .sort((a, b) => b.trial - a.trial || b.cov - a.cov || b.hit - a.hit || b.same - a.same);
  }

  function renderMatch() {
    const box = $("ml-match");
    const att = $("attitude").value.trim();
    box.replaceChildren();
    state.match = null;
    if (!att) { setDenovo(false); return; }
    const list = scoreAll().slice(0, 5);
    if (list.length) {
      box.append(el("p", "ml-match-title", list.length > 1 ? "Lettres types correspondantes : choisissez celle à suivre" : "Lettre type correspondante"));
      const strong = list[0].trial || list[0].cov >= 0.75;
      list.forEach((m, i) => {
        const lab = el("label", "cg-check ml-choice");
        const r = el("input"); r.type = "radio"; r.name = "ml-tpl"; r.value = m.t.id;
        r.checked = i === 0 && strong;
        r.addEventListener("change", () => { state.match = m.t; setDenovo(false); showTrialLinks("ml-kt", ktTexts()); });
        lab.append(r, el("span", null, m.t.title + (m.t.trial ? ` · ${m.t.trial}` : "") + (m.t.clinic ? ` · ${m.t.clinic}` : "")));
        box.append(lab);
      });
      if (list[0] && strong) state.match = list[0].t;
    }
    const none = el("label", "cg-check ml-choice");
    const r = el("input"); r.type = "radio"; r.name = "ml-tpl"; r.value = "";
    r.checked = !state.match;
    r.addEventListener("change", () => { state.match = null; setDenovo(true); showTrialLinks("ml-kt", ktTexts()); });
    if (!list.length) box.append(el("p", "ml-nomatch", "Aucune lettre type ne correspond à ce traitement. Voulez-vous générer une lettre de novo ?"));
    none.append(r, el("span", null, list.length ? "Aucune de ces lettres : générer une lettre de novo" : "Oui, générer une lettre de novo (indiquez l'étude de référence ci-dessous)"));
    box.append(none);
    setDenovo(!state.match);
    showTrialLinks("ml-kt", ktTexts());
  }

  function setDenovo(on) {
    state.denovo = on;
    $("ml-denovo").hidden = !on;
  }

  // Exemple de style pour une lettre de novo : la lettre validée la plus proche (même clinique, puis la plus récente)
  function closestExample() {
    const clinic = norm($("clinic").value);
    const val = state.templates.filter((t) => t.status === "validated");
    return val.find((t) => t._clinic === clinic) || val[0] || null;
  }

  // ----- Listes de saisie rapide par clinique -----
  function renderChips() {
    const v = (window.OncoVocab || {})[$("clinic").value] || { histo: [], markers: [] };
    const make = (box, target, list) => {
      $(box).replaceChildren(...list.map((txt) => button(txt, "ug-chip ml-chip", () => insert(target, txt))));
      $(box).hidden = !list.length;
    };
    make("chips-histo", "histo", v.histo);
    make("chips-markers", "markers", v.markers);
  }
  // Ajoute le terme en fin de champ et sélectionne « … » pour que la valeur soit tapée directement
  function insert(id, txt) {
    const f = $(id);
    const base = f.value.trim();
    f.value = base ? base.replace(/[;,.]?$/, "") + ", " + txt : txt;
    f.focus();
    const i = f.value.lastIndexOf("…");
    if (i >= 0 && i >= f.value.length - txt.length) f.setSelectionRange(i, i + 1);
    else f.setSelectionRange(f.value.length, f.value.length);
    f.dispatchEvent(new Event("input"));
  }

  // ----- Stade calculé depuis le TNM (le médecin garde la main : une saisie manuelle n'est jamais écrasée) -----
  function updateStage() {
    const note = $("ml-stage-note");
    const S = window.TnmStage;
    let sys = $("stage-sys").value;
    if (sys === "auto") sys = S.guess($("clinic").value, $("histo").value);
    const stageField = $("stage");
    const tnm = $("tnm").value.trim();
    note.className = "ml-wide ml-stage-note";
    if (sys === "none") { note.textContent = ""; return; }
    if (!sys) {
      note.textContent = tnm && $("clinic").value ? "Pas de calcul automatique pour cette tumeur : saisissez le stade (FIGO, OMS, etc.) ou choisissez un système." : "";
      return;
    }
    if (!tnm) { note.textContent = "Stade calculé automatiquement à partir du TNM (" + S.SYSTEMS[sys].label + ")."; return; }
    const r = S.stage(sys, tnm);
    if (!r || !r.stage) {
      note.textContent = r ? r.note : "TNM non reconnu (ex. cT2a cN1 cM0).";
      if (stageField.value === state.stageAuto) { stageField.value = ""; state.stageAuto = ""; }
      return;
    }
    const manual = stageField.value && stageField.value !== state.stageAuto;
    if (!manual) { stageField.value = r.stage; state.stageAuto = r.stage; }
    note.classList.add("ok");
    note.textContent = `Stade calculé : ${r.stage} (${r.label})${r.note ? ". " + r.note : ""}` +
      (manual && stageField.value !== r.stage ? ` Votre saisie (${stageField.value}) diffère : vérifiez.` : " À vérifier.");
  }

  // ----- Lien vers la fiche Key trials de l'étude citée -----
  function trialLinks(texts) {
    const hay = norm(texts.filter(Boolean).join(" "));
    return state.trials.filter((k) => k._n && has(hay, k._n));
  }
  function showTrialLinks(boxId, texts) {
    const box = $(boxId);
    const list = trialLinks(texts);
    box.replaceChildren();
    if (!list.length) { box.hidden = true; return; }
    box.append("Fiche Key trials : ");
    list.forEach((k, i) => {
      const a = el("a", null, k.acronym);
      a.href = "/app/trials.html?t=" + encodeURIComponent(k.slug); a.target = "_blank"; a.rel = "noopener";
      if (i) box.append(" · ");
      box.append(a);
    });
    box.hidden = false;
  }
  const ktTexts = () => [$("attitude").value, $("trial").value, state.match && state.match.trial];

  async function loadTrials() {
    // Fiches lisibles par l'utilisateur (publiées ; toutes pour l'admin) ; silencieux si la table est inaccessible
    const { data } = await sb.from("key_trials").select("slug, acronym, status");
    state.trials = (data || []).map((k) => Object.assign(k, { _n: norm(k.acronym) }));
  }

  // ----- Génération -----
  function payload() {
    const fields = {};
    for (const id of FIELDS) { const v = $(id).value.trim(); if (v) fields[id] = v; }
    if (!state.denovo) { delete fields.trial; delete fields.details; }
    const ex = state.denovo ? closestExample() : null;
    return { action: "generate", fields, template_id: state.denovo ? null : state.match && state.match.id, example_id: ex && ex.id };
  }

  async function generate(e) {
    e.preventDefault();
    const msg = $("ml-msg");
    msg.className = "form-msg";
    if (!checkPii()) { msg.className = "form-msg error"; msg.textContent = "Saisie bloquée : données identifiantes détectées."; return; }
    if (!$("ml-ack").checked) { msg.className = "form-msg error"; msg.textContent = "Confirmez qu'il s'agit d'un cas fictif (case à cocher) avant de générer."; return; }
    const open = FIELDS.filter((id) => $(id).value.includes("…")).map((id) => labelOf($(id)));
    if (open.length) { msg.className = "form-msg error"; msg.textContent = "Valeurs à compléter (…) : " + open.join(", ") + "."; return; }
    if (!$("clinic").value || !$("histo").value.trim() || !$("attitude").value.trim()) {
      msg.className = "form-msg error"; msg.textContent = "Clinique, diagnostic histopathologique et attitude sont nécessaires."; return;
    }
    if (!state.match && !state.denovo) { msg.className = "form-msg error"; msg.textContent = "Choisissez une lettre type ou la génération de novo."; return; }
    if (state.denovo && !$("trial").value.trim()) { msg.className = "form-msg error"; msg.textContent = "Indiquez l'étude de référence pour une lettre de novo."; return; }
    const body = payload();
    const key = JSON.stringify(body);
    // Même saisie, même lettre : pas de nouvel appel (cache en mémoire, effacé au rechargement)
    if (state.cache.has(key)) return show(state.cache.get(key), body);
    const btn = $("ml-generate");
    btn.disabled = true; msg.textContent = "Rédaction en cours…";
    try {
      const { data: s } = await sb.auth.getSession();
      const res = await fetch(FN, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + s.session.access_token, apikey: cfg.supabaseAnonKey },
        body: key
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(ERR[out.error] || "Génération impossible (" + res.status + ").");
      state.cache.set(key, out);
      show(out, body);
      msg.textContent = "";
    } catch (x) {
      msg.className = "form-msg error"; msg.textContent = x.message;
    } finally { btn.disabled = false; }
  }
  const ERR = {
    pii: "Données identifiantes détectées par le serveur : corrigez la saisie.",
    daily_limit: "Limite quotidienne atteinte. Réessayez demain.",
    busy: "Service momentanément saturé. Réessayez dans une minute.",
    forbidden: "Accès réservé.", missing_fields: "Diagnostic et attitude sont nécessaires.",
    template_not_found: "Lettre type introuvable.", refusal: "Le modèle a refusé la demande."
  };

  // Les marqueurs §T / §E délimitent les paragraphes traitement et effets secondaires (réutilisables comme modèle)
  function show(out, body) {
    const raw = out.text || "";
    const idx = ["§T", "§E", "§S"].map((m) => raw.indexOf(m));
    const part = (i) => {
      if (idx[i] < 0) return "";
      const next = idx.filter((x) => x > idx[i]);
      return raw.slice(idx[i] + 2, next.length ? Math.min(...next) : undefined).trim();
    };
    state.last = { body, paras: [part(0), part(1), part(2)].filter(Boolean) };
    $("ml-text").value = raw.replace(/§[TES]\s*/g, "");
    showTrialLinks("ml-kt-out", ktTexts());
    const flags = [];
    if (state.denovo) flags.push("Lettre de novo : vérifiez le schéma, les doses et les effets secondaires.");
    if (out.redacted) flags.push("Des éléments ressemblant à des données identifiantes ont été masqués […].");
    if (out.truncated) flags.push("Texte tronqué : relancez ou complétez.");
    if (/\[(?:à compléter|dose à vérifier)\]/.test(raw)) flags.push("Des éléments sont marqués [à compléter] ou [dose à vérifier].");
    $("ml-flag").textContent = flags.join(" ");
    $("ml-flag").hidden = !flags.length;
    $("ml-out").hidden = false;
    $("ml-save").hidden = !state.denovo;
    if (state.denovo) prefillSave();
    $("ml-out").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // ----- Téléchargement Word -----
  async function downloadDocx() {
    await loadScript(DOCX, "docx");
    const { Document, Packer, Paragraph, TextRun } = window.docx;
    const lines = $("ml-text").value.split(/\n+/).map((l) => l.trim()).filter(Boolean);
    const paras = lines.map((l) => {
      if (/^(ANAMNÈSE|ATTITUDE)$/.test(l)) return new Paragraph({ spacing: { before: 240, after: 120 }, children: [new TextRun({ text: l, bold: true })] });
      const m = l.match(/^(Anamnèse oncologique familiale|Habitus|Situation sociale)\s*:\s*(.*)$/);
      if (m) return new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text: m[1] + " : ", bold: true }), new TextRun(m[2])] });
      return new Paragraph({ spacing: { after: 120 }, children: [new TextRun(l)] });
    });
    paras.unshift(new Paragraph({ spacing: { after: 240 }, children: [new TextRun({ text: "Version de test : cas fictif, document sans valeur clinique.", italics: true, color: "B3261E" })] }));
    const doc = new Document({
      styles: { default: { document: { run: { font: "Arial", size: 20 } } } },
      sections: [{ children: paras }]
    });
    const blob = await Packer.toBlob(doc);
    const a = el("a");
    a.href = URL.createObjectURL(blob);
    a.download = "lettre-attitude.docx";
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // ----- Enregistrer une lettre de novo comme modèle (brouillon) -----
  const DRUG_RE = /\b[a-zé]+(?:mab|nib|lisib|platine?|taxel|rubicine|tecan|trexed|citabine|mustine|fosfamide|poside|limus|ciclib|parib|degib|rafenib|metinib|deruxtecan|vedotine?|tansine?)\b/gi;
  function prefillSave() {
    const att = $("attitude").value;
    $("sv-title").value = att.split(/[\n,;]/)[0].trim().slice(0, 120);
    $("sv-drugs").value = [...new Set((att.match(DRUG_RE) || []).map((d) => d.toLowerCase()))].join(", ");
    $("sv-treatment").value = ($("details").value || att).split("\n")[0].trim().slice(0, 200);
    $("sv-trial").value = $("trial").value.trim();
    $("sv-msg").textContent = "";
    $("sv-yes").disabled = false;
  }

  function templateBody() {
    // Paragraphes traitement et effets secondaires, tels qu'éventuellement corrigés par le médecin
    const txt = $("ml-text").value;
    const att = txt.split(/\n\s*ATTITUDE\s*\n/)[1] || "";
    const paras = att.split(/\n\s*\n|\n/).map((p) => p.trim()).filter(Boolean);
    const keep = paras.length > 2 ? paras.slice(2) : state.last.paras;
    return keep.join("\n\n");
  }

  async function saveTemplate() {
    const out = $("sv-msg");
    const body = templateBody();
    const fields = [$("sv-title").value, $("sv-drugs").value, $("sv-treatment").value, $("sv-trial").value, body];
    if (fields.some((v) => piiOf(v).length)) { out.className = "form-msg error"; out.textContent = "Le modèle contient des données identifiantes : corrigez la lettre."; return; }
    if (body.length < 20 || !$("sv-title").value.trim()) { out.className = "form-msg error"; out.textContent = "Intitulé et paragraphes de traitement nécessaires."; return; }
    const { error } = await sb.from("medletter_templates").insert({
      title: $("sv-title").value.trim(), clinic: $("clinic").value || null, treatment: $("sv-treatment").value.trim() || null,
      drugs: $("sv-drugs").value.split(",").map((d) => d.trim().toLowerCase()).filter(Boolean),
      trial: $("sv-trial").value.trim() || null, body, origin: "generated", status: "draft"
    });
    if (error) { out.className = "form-msg error"; out.textContent = "Enregistrement refusé : " + error.message; return; }
    out.className = "form-msg ok"; out.textContent = "Modèle enregistré en brouillon ; il sera disponible après validation.";
    $("sv-yes").disabled = true;
    await loadTemplates();
  }

  // ----- Chargement -----
  async function loadTemplates() {
    const { data, error } = await sb.from("medletter_templates")
      .select("id, title, clinic, treatment, drugs, trial, status, origin, created_by, created_at, source_file")
      .order("title");
    if (error) throw error;
    prepare(data || []);
    if (state.admin) renderAdmin();
    renderMatch();
  }

  async function loadBrands() {
    // Facultatif : table des lettres d'assurance (médecins CHUV) ; silencieux si inaccessible
    const { data } = await sb.from("letters").select("drugs");
    for (const r of data || []) for (const d of r.drugs || []) {
      const b = norm(d.brand), s = norm(d.substance);
      if (b && s && b !== s) state.brands[b] = s;
    }
  }

  // ----- Administration -----
  async function renderAdmin() {
    const drafts = state.templates.filter((t) => t.status === "draft");
    const box = $("ml-drafts");
    box.replaceChildren(drafts.length ? listOf(drafts, true) : el("p", "muted", "Aucun brouillon."));
    const val = state.templates.filter((t) => t.status === "validated");
    $("ml-index").replaceChildren(val.length ? listOf(val, false) : el("p", "muted", "Aucune lettre type pour l'instant."));
  }

  function listOf(rows, drafts) {
    const ul = el("ul", "ml-list");
    for (const t of rows) {
      const li = el("li");
      const head = el("div", "ml-li-head");
      head.append(el("strong", null, t.title), el("span", "muted", [t.clinic, (t.drugs || []).join(", "), t.trial, t.origin === "generated" ? "proposé depuis une lettre de novo" : t.source_file].filter(Boolean).join(" · ")));
      const row = el("div", "btn-row");
      row.append(button("Voir / modifier", "btn btn-outline ug-copy", () => editTemplate(t, li)));
      if (drafts) row.append(button("Valider", "btn ug-copy", () => patch(t.id, { status: "validated", validated_by: state.uid, validated_at: new Date().toISOString() })));
      row.append(button("Supprimer", "btn btn-outline ug-copy lt-danger", async () => {
        if (!confirm(`Supprimer « ${t.title} » ?`)) return;
        const { error } = await sb.from("medletter_templates").delete().eq("id", t.id);
        if (error) return alert(error.message);
        await loadTemplates();
      }));
      li.append(head, row);
      ul.append(li);
    }
    return ul;
  }

  async function patch(id, values) {
    const { error } = await sb.from("medletter_templates").update(values).eq("id", id);
    if (error) return alert("Enregistrement refusé : " + error.message);
    await loadTemplates();
  }

  async function editTemplate(t, li) {
    const old = li.querySelector(".ml-editor");
    if (old) return old.remove();
    const { data } = await sb.from("medletter_templates").select("body").eq("id", t.id).single();
    li.append(editor(Object.assign({}, t, { body: data ? data.body : "" }), async (v) => { await patch(t.id, v); }));
  }

  function editor(t, onSave) {
    const f = el("div", "ml-editor ml-grid");
    const field = (label, value, area) => {
      const l = el("label", area ? "ml-wide" : null, label);
      const i = el(area ? "textarea" : "input");
      i.value = value || "";
      if (area) i.rows = 10;
      l.append(i); f.append(l); return i;
    };
    const title = field("Intitulé", t.title);
    const clinic = el("select");
    clinic.append(el("option", null, ""), ...CLINICS.map((c) => el("option", null, c)));
    clinic.value = t.clinic || "";
    const cl = el("label", null, "Clinique"); cl.append(clinic); f.append(cl);
    const treat = field("Schéma", t.treatment);
    const drugs = field("Médicaments (DCI, virgules)", (t.drugs || []).join(", "));
    const trial = field("Étude de référence", t.trial);
    const body = field("Texte de la lettre type", t.body, true);
    const msg = el("p", "form-msg ml-wide");
    const row = el("div", "btn-row ml-wide");
    row.append(button("Enregistrer", "btn ug-copy", async () => {
      if (piiOf(body.value).length) { msg.className = "form-msg error ml-wide"; msg.textContent = "Le texte contient des données identifiantes : " + piiOf(body.value).join(", "); return; }
      await onSave({ title: title.value.trim(), clinic: clinic.value || null, treatment: treat.value.trim() || null,
        drugs: drugs.value.split(",").map((d) => d.trim().toLowerCase()).filter(Boolean), trial: trial.value.trim() || null, body: body.value.trim() });
    }));
    f.append(row, msg);
    return f;
  }

  // Import Word : texte brut (mammoth), puis index proposé par Haiku, vérifié par l'admin avant enregistrement
  async function importFiles(files) {
    const msg = $("ml-drop-msg");
    msg.className = "form-msg"; msg.textContent = "Lecture…";
    await loadScript(MAMMOTH, "mammoth");
    const { data: s } = await sb.auth.getSession();
    for (const file of files) {
      if (!/\.docx$/i.test(file.name)) continue;
      const { value } = await window.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
      const text = value.replace(/\n{3,}/g, "\n\n").trim();
      let meta = { title: file.name.replace(/\.docx$/i, ""), clinic: "", treatment: "", drugs: [], trial: "" };
      try {
        const res = await fetch(FN, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + s.session.access_token, apikey: cfg.supabaseAnonKey },
          body: JSON.stringify({ action: "index", text })
        });
        const out = await res.json();
        if (res.ok && out.meta) meta = Object.assign(meta, out.meta);
      } catch (x) { /* index manuel */ }
      const box = el("div", "ml-import");
      box.append(el("p", "ml-import-file", file.name + (piiOf(text).length ? " : attention, " + piiOf(text).join(", ") + " détecté(s), à retirer avant enregistrement" : "")));
      box.append(editor(Object.assign(meta, { body: text }), async (v) => {
        const { error } = await sb.from("medletter_templates").insert(Object.assign(v, { source_file: file.name, origin: "import", status: "validated", validated_by: state.uid, validated_at: new Date().toISOString() }));
        if (error) return alert("Enregistrement refusé : " + error.message);
        box.remove();
        await loadTemplates();
      }));
      $("ml-imports").append(box);
    }
    msg.textContent = "Vérifiez l'index proposé pour chaque lettre, puis enregistrez.";
  }

  async function renderMembers() {
    const { data, error } = await sb.rpc("medletters_members");
    const box = $("ml-members");
    if (error) return box.replaceChildren(el("p", "form-msg error", error.message));
    const ul = el("ul", "ml-list ml-members");
    for (const m of data || []) {
      const lab = el("label", "cg-check");
      const c = el("input"); c.type = "checkbox"; c.checked = m.med_plus;
      c.addEventListener("change", async () => {
        const { error: e } = await sb.rpc("medletters_set_access", { p_user: m.id, p_on: c.checked });
        if (e) { c.checked = !c.checked; alert(e.message); }
      });
      lab.append(c, el("span", null, m.name + (m.institution ? ` · ${m.institution}` : "")));
      const li = el("li"); li.append(lab); ul.append(li);
    }
    box.replaceChildren(ul);
    const { data: use } = await sb.from("medletter_usage").select("calls, input_tokens, cached_tokens, output_tokens")
      .gte("day", new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10));
    if (use && use.length) {
      const sum = (k) => use.reduce((a, r) => a + r[k], 0);
      $("ml-usage").textContent = `30 derniers jours : ${sum("calls")} appels, ${sum("input_tokens")} tokens d'entrée, ${sum("cached_tokens")} lus en cache, ${sum("output_tokens")} de sortie.`;
    }
  }

  function setupDrop() {
    const drop = $("ml-drop"), input = $("ml-drop-input");
    drop.addEventListener("click", () => input.click());
    drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } });
    drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); importFiles([...e.dataTransfer.files]); });
    input.addEventListener("change", () => { importFiles([...input.files]); input.value = ""; });
  }

  // ----- Démarrage -----
  (async () => {
    if (!sb) return ($("ug-status").textContent = "Service indisponible.");
    const { data } = await sb.auth.getSession();
    if (!data.session) return (location.href = "/fr/the-hive.html");
    $("logout").addEventListener("click", async () => { await sb.auth.signOut(); location.href = "/fr/"; });
    state.uid = data.session.user.id;
    const [{ data: plus }, { data: role }] = await Promise.all([sb.rpc("is_med_plus"), sb.rpc("current_role_name")]);
    if (plus !== true) return ($("ug-status").textContent = "Accès réservé.");
    state.admin = role === "admin";
    const sel = $("clinic");
    sel.append(el("option", null, ""), ...CLINICS.map((c) => el("option", null, c)));
    try { await Promise.all([loadTemplates(), loadBrands(), loadTrials()]); } catch (e) { return ($("ug-status").textContent = "Chargement impossible : " + e.message); }
    $("ug-status").hidden = true;
    $("ml-tool").hidden = false;
    let t;
    $("attitude").addEventListener("input", () => { clearTimeout(t); t = setTimeout(renderMatch, 250); });
    sel.addEventListener("change", () => { renderMatch(); renderChips(); updateStage(); });
    for (const id of ["tnm", "histo", "stage-sys"]) $(id).addEventListener(id === "stage-sys" ? "change" : "input", updateStage);
    $("stage").addEventListener("input", () => { if (!$("stage").value) state.stageAuto = ""; updateStage(); });
    $("trial").addEventListener("input", () => showTrialLinks("ml-kt", ktTexts()));
    renderChips();
    for (const id of FIELDS) $(id).addEventListener("input", () => { if ($("ml-pii").textContent || $(id).classList.contains("ml-bad")) checkPii(); });
    for (const id of FIELDS) $(id).addEventListener("blur", checkPii);
    $("ml-form").addEventListener("submit", generate);
    $("ml-reset").addEventListener("click", () => {
      if (!confirm("Effacer la saisie et la lettre ?")) return;
      $("ml-form").reset(); $("ml-text").value = ""; $("ml-out").hidden = true; state.cache.clear(); state.stageAuto = "";
      checkPii(); renderMatch(); renderChips(); updateStage();
    });
    $("ml-docx").addEventListener("click", () => downloadDocx().catch((e) => alert(e.message)));
    $("ml-copy").addEventListener("click", async (e) => {
      try { await navigator.clipboard.writeText($("ml-text").value); e.target.textContent = "Copié"; } catch (x) { e.target.textContent = "Copie impossible"; }
      setTimeout(() => (e.target.textContent = "Copier le texte"), 1500);
    });
    $("sv-yes").addEventListener("click", saveTemplate);
    $("sv-no").addEventListener("click", () => ($("ml-save").hidden = true));
    if (state.admin) { $("ml-admin").hidden = false; setupDrop(); renderMembers(); }
  })();
})();
