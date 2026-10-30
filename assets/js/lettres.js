// Lettres types de demande de garantie : recherche dans les lettres importées (table letters).
// Tout se passe dans le navigateur : les lettres sont chargées une fois, puis filtrées localement.
(function () {
  const cfg = window.ONCONIC_CONFIG || {};
  const sb = window.supabase && cfg.supabaseUrl ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey) : null;
  const EXCELJS = "https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js";
  const MAMMOTH = "https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js";
  const LINES = window.LetterParse.LINES;
  const LINE_LABEL = Object.fromEntries(LINES);

  // Cliniques du CHUV, par bloc ; une clinique présente en base mais absente d'ici apparaît sous « Autres »
  const BLOCS = [
    ["Bloc 1", ["Sénologie", "Gynécologie", "Urologie"]],
    ["Bloc 2", ["Thoracique", "Neuro-oncologie", "Mélanome"]],
    ["Bloc 3", ["Lower GI", "Upper GI", "ORL", "Sarcomes", "Radiologie interventionnelle"]]
  ];

  const $ = (id) => document.getElementById(id);
  const state = { rows: [], clinic: "", route: "", line: "" };

  const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9+<>≥≤%]+/g, " ").trim();
  // Synonymes usuels : la recherche « NSCLC » trouve « CBNPC », etc.
  const SYN = [["cbnpc", "nsclc", "cpnpc"], ["cppc", "sclc"], ["her2", "erbb2"], ["epidermoide", "squameux", "squamous"]];
  const expand = (s) => {
    let t = norm(s);
    for (const g of SYN) if (g.some((w) => t.includes(w))) t += " " + g.join(" ");
    return t;
  };

  function el(tag, cls, txt) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }
  const badge = (txt, cls) => el("span", "ug-badge " + (cls || ""), txt);

  function prepare(rows) {
    rows.forEach((r) => {
      const drugs = r.drugs.map((d) => [d.substance, d.brand, d.company, d.code].join(" ")).join(" ");
      r._title = norm(r.title);
      r._hay = expand([r.title, r.file, r.diagnosis, r.markers, r.trial, r.keywords, drugs].join(" "));
      r._dx = expand([r.diagnosis, r.title].join(" "));
      // Marqueurs positifs seulement : « EGFR/ALK négatif » ne répond pas à la recherche « EGFR »
      r._mk = (r.markers || "").split(";").map((m) => expand(m));
      r._routes = [...new Set(r.drugs.map((d) => d.route))];
      r._offLabel = r.drugs.some((d) => d.offLabel);
    });
    state.rows = rows;
  }

  function markerHit(r, tokens) {
    const wantNeg = tokens.some((t) => t.startsWith("neg"));
    return tokens.every((t) => r._mk.some((m) => m.includes(t) && (wantNeg || !/negati/.test(m)))
      || (!wantNeg && r._title.includes(t)));
  }

  function search() {
    const tokens = norm($("q").value).split(" ").filter(Boolean);
    const dx = norm($("f-dx").value).split(" ").filter(Boolean);
    const mk = norm($("f-mk").value).split(" ").filter(Boolean);
    const hits = [];
    for (const r of state.rows) {
      if (state.clinic && norm(r.clinic) !== state.clinic) continue;
      if (state.route && !r._routes.includes(state.route)) continue;
      if (state.line && !r.lines.includes(state.line)) continue;
      if (!tokens.every((t) => r._hay.includes(t))) continue;
      if (!dx.every((t) => r._dx.includes(t))) continue;
      if (mk.length && !markerHit(r, mk)) continue;
      let score = 0;
      for (const t of tokens) score += r._title.split(" ").includes(t) ? 3 : r._title.includes(t) ? 2 : 1;
      hits.push([score, r]);
    }
    hits.sort((a, b) => b[0] - a[0] || a[1].position - b[1].position);
    render(hits.map((h) => h[1]), tokens.length + dx.length + mk.length > 0 || !!(state.clinic || state.route || state.line));
  }

  function card(r) {
    const d = el("details", "ug-card lt-card");
    const s = el("summary");
    const head = el("div", "ug-head");
    head.append(el("span", "ug-name", r.title));
    const meta = el("div", "ug-meta");
    r.lines.forEach((l) => meta.append(badge(LINE_LABEL[l] || l)));
    if (r.diagnosis) meta.append(badge(r.diagnosis));
    if (r.markers) r.markers.split(";").map((m) => m.trim()).filter(Boolean).forEach((m) => meta.append(badge(m, "lt-marker")));
    if (r._offLabel) meta.append(badge("Art. 71a OAMal", "ug-warn"));
    head.append(meta);
    const drugs = el("p", "lt-drugs");
    r.drugs.forEach((x, i) => {
      if (i) drugs.append(" · ");
      drugs.append(el("strong", null, x.substance), ` ${x.brand}${x.code ? " — " + x.code : ""}`);
    });
    head.append(drugs);
    if (r.trial) head.append(el("p", "lt-trial", "Étude : " + r.trial));
    s.append(head);
    d.append(s);
    d.addEventListener("toggle", () => { if (d.open && !d.dataset.ready) body(d, r); });
    return d;
  }

  function body(d, r) {
    d.dataset.ready = "1";
    const b = el("div", "ug-body");
    if (r.note) b.append(el("p", "ug-note ug-attn", r.note));
    const actions = el("div", "btn-row lt-actions");
    const copyBtn = el("button", "btn btn-navy ug-copy", "Copier la lettre");
    copyBtn.type = "button";
    copyBtn.addEventListener("click", () => copy(r, copyBtn));
    const dl = el("button", "btn btn-outline ug-copy", "Télécharger le Word");
    dl.type = "button";
    dl.addEventListener("click", () => download(r, dl));
    actions.append(copyBtn, dl);
    if (state.admin) {
      const edit = el("button", "btn btn-outline ug-copy", "Modifier");
      edit.type = "button";
      edit.addEventListener("click", () => { if (!b.querySelector(".lt-editor")) b.insertBefore(editor(r, { existing: r }), actions.nextSibling); });
      const del = el("button", "btn btn-outline ug-copy lt-danger", "Supprimer");
      del.type = "button";
      del.addEventListener("click", () => remove(r));
      actions.append(edit, del);
    }
    const letter = el("article", "lt-letter");
    // HTML déjà nettoyé à l'import ; nettoyé encore ici par sécurité
    letter.innerHTML = window.LetterParse.sanitize(r.html);
    b.append(actions, letter);
    d.append(b);
  }

  async function copy(r, btn) {
    const html = window.LetterParse.sanitize(r.html).replace(/<table>/g, '<table border="1" cellpadding="4" cellspacing="0">');
    const plain = new DOMParser().parseFromString(r.html, "text/html").body.innerText;
    try {
      if (window.ClipboardItem) {
        await navigator.clipboard.write([new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([plain], { type: "text/plain" })
        })]);
      } else await navigator.clipboard.writeText(plain);
      btn.textContent = "Copiée";
    } catch { btn.textContent = "Copie impossible"; }
    setTimeout(() => (btn.textContent = "Copier la lettre"), 1500);
  }

  async function download(r, btn) {
    btn.disabled = true;
    const { data, error } = await sb.from("letters").select("docx").eq("id", r.id).single();
    btn.disabled = false;
    if (error || !data || !data.docx) { btn.textContent = "Indisponible"; return; }
    const bin = atob(data.docx);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }));
    const a = el("a");
    a.href = url; a.download = r.file;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function render(list, filtered) {
    const out = $("ug-results");
    out.replaceChildren(...list.map(card));
    $("ug-count").textContent = filtered
      ? `${list.length} lettre${list.length > 1 ? "s" : ""} sur ${state.rows.length}`
      : `${state.rows.length} lettres`;
    if (list.length === 1) out.firstChild.open = true;
  }

  function chips(id, values, key, all) {
    const box = $(id);
    const make = (value, label) => {
      const b = el("button", "ug-chip", label);
      b.type = "button";
      b.setAttribute("aria-pressed", String(state[key] === value));
      b.addEventListener("click", () => {
        state[key] = state[key] === value ? "" : value;
        [...box.children].forEach((c, i) => c.setAttribute("aria-pressed", String(state[key] === (i ? values[i - 1][0] : ""))));
        search();
      });
      return b;
    };
    box.replaceChildren(make("", all), ...values.map(([v, l]) => make(v, l)));
  }

  // Sélecteur de clinique : filtre (avec « Toutes » et le nombre de lettres) ou champ du formulaire admin
  function fillClinics(sel, filter, current) {
    const count = (c) => state.rows.filter((r) => norm(r.clinic) === norm(c)).length;
    const known = new Set(BLOCS.flatMap(([, l]) => l).map(norm));
    const others = [...new Set(state.rows.map((r) => r.clinic).filter((c) => c && !known.has(norm(c))))].sort();
    const opt = (c) => {
      const o = el("option", null, filter ? `${c} (${count(c)})` : c);
      o.value = filter ? norm(c) : c;
      if (filter && !count(c)) o.disabled = true;
      return o;
    };
    const groups = BLOCS.concat(others.length ? [["Autres", others]] : []).map(([bloc, list]) => {
      const g = el("optgroup");
      g.label = bloc;
      g.append(...list.map(opt));
      return g;
    });
    const first = el("option", null, filter ? `Toutes les cliniques (${state.rows.length})` : "Choisir…");
    first.value = "";
    sel.replaceChildren(first, ...groups);
    sel.value = filter ? state.clinic : ([...sel.options].find((o) => norm(o.value) === norm(current)) || first).value;
  }

  function setupFilters() {
    chips("ug-lines", LINES, "line", "Toutes lignes");
    const clinics = [...new Set(state.rows.map((r) => r.clinic).filter(Boolean))].sort();
    fillClinics($("f-clinic"), true);
    chips("ug-routes", [["IV", "IV"], ["SC", "SC"], ["PO", "Oral"]], "route", "Toutes voies");
    const fill = (id, values) => $(id).replaceChildren(...[...new Set(values)].sort().map((v) => { const o = el("option"); o.value = v; return o; }));
    fill("dx-list", state.rows.map((r) => r.diagnosis).filter(Boolean));
    if (!state.lastClinic && clinics.length) {
      const count = (c) => state.rows.filter((r) => r.clinic === c).length;
      state.lastClinic = clinics.reduce((a, b) => (count(b) > count(a) ? b : a));
    }
    fill("mk-list", state.rows.flatMap((r) => (r.markers || "").split(";").map((m) => m.trim())).filter(Boolean));
    search();
  }

  // ----- Administration -----
  function loadScript(src, global) {
    return new Promise((ok, ko) => {
      if (window[global]) return ok();
      const s = document.createElement("script");
      s.src = src; s.onload = ok; s.onerror = () => ko(new Error("chargement de " + global + " impossible"));
      document.head.append(s);
    });
  }

  async function loadRows() {
    const [{ data: rows, error }, { data: meta }] = await Promise.all([
      sb.from("letters").select("id, position, file, title, clinic, diagnosis, markers, lines, trial, keywords, note, drugs, html").order("position").range(0, 999),
      sb.from("letters_meta").select("source_file, imported_at, row_count").maybeSingle()
    ]);
    if (meta) {
      const d = new Date(meta.imported_at);
      $("ug-source").textContent = `Source : ${meta.source_file}, mis à jour le ${d.toLocaleDateString("fr-CH")} (${meta.row_count} lettres).`;
    }
    return error ? null : rows || [];
  }

  async function refresh() {
    const rows = await loadRows();
    if (!rows) return;
    prepare(rows);
    $("ug-status").hidden = rows.length > 0;
    $("ug-tool").hidden = rows.length === 0;
    setupFilters();
  }

  const splitList = (v) => String(v || "").split(";").map((x) => x.trim()).filter(Boolean);

  // Formulaire d'une lettre : nouvelle (row issu du Word) ou existante (opts.existing)
  function editor(row, opts = {}) {
    const ex = opts.existing;
    const f = el("form", "lt-editor");
    f.noValidate = true;
    const field = (name, label, value, list) => {
      const l = el("label", null, label);
      const i = el("input");
      i.name = name; i.value = value || ""; i.autocomplete = "off";
      if (list) i.setAttribute("list", list);
      l.append(i);
      return l;
    };
    const head = el("div", "lt-editor-head");
    head.append(el("strong", null, row.file));
    head.append(el("span", "ug-badge " + (ex && !opts.fromDrop ? "" : ex ? "ug-warn" : "lt-new"),
      ex && !opts.fromDrop ? "Modification" : ex ? "Remplace la lettre existante" : "Nouvelle lettre"));
    f.append(head);
    if (row.drugs && opts.fromDrop) {
      const d = el("p", "lt-drugs");
      d.append(el("span", "muted", "Lu dans la lettre : "));
      row.drugs.forEach((x, i) => { if (i) d.append(" · "); d.append(el("strong", null, x.substance), ` ${x.brand}${x.code ? " — " + x.code : ""}`); });
      if (!row.drugs.length) d.append("aucun médicament reconnu");
      f.append(d);
    }
    (row.warnings || []).forEach((w) => f.append(el("p", "ug-note ug-attn", "Attention : " + w)));
    const src = ex || row;
    const grid = el("div", "lt-editor-grid");
    grid.append(
      field("title", "Titre", src.title),
      (() => {
        const l = el("label", null, "Clinique");
        const sel = el("select");
        sel.name = "clinic";
        fillClinics(sel, false, src.clinic || state.lastClinic || "");
        l.append(sel);
        return l;
      })(),
      field("diagnosis", "Diagnostic", src.diagnosis, "dx-list"),
      field("markers", "Drivers / marqueurs (séparés par « ; »)", src.markers, "mk-list"),
      field("trial", "Étude(s) de référence", src.trial),
      field("keywords", "Mots-clés (séparés par « ; »)", src.keywords),
      field("note", "Remarque interne", src.note)
    );
    f.append(grid);
    const lines = el("fieldset", "lt-editor-lines");
    lines.append(el("legend", null, "Lignes thérapeutiques"));
    for (const [id, label] of LINES) {
      const l = el("label", "lt-check");
      const c = el("input");
      c.type = "checkbox"; c.name = "lines"; c.value = id; c.checked = (src.lines || []).includes(id);
      l.append(c, " " + label);
      lines.append(l);
    }
    f.append(lines);
    const msg = el("p", "form-msg");
    msg.setAttribute("role", "status");
    const bar = el("div", "btn-row");
    const save = el("button", "btn", "Enregistrer");
    save.type = "submit";
    const cancel = el("button", "btn btn-outline", "Annuler");
    cancel.type = "button";
    cancel.addEventListener("click", () => f.remove());
    bar.append(save, cancel);
    f.append(bar, msg);
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(f);
      const payload = {
        title: (fd.get("title") || "").trim(), clinic: (fd.get("clinic") || "").trim() || null,
        diagnosis: (fd.get("diagnosis") || "").trim() || null, markers: splitList(fd.get("markers")).join(" ; ") || null,
        trial: splitList(fd.get("trial")).join(" ; ") || null, keywords: splitList(fd.get("keywords")).join(" ; ") || null,
        note: (fd.get("note") || "").trim() || null, lines: fd.getAll("lines")
      };
      if (!payload.title) { msg.className = "form-msg error"; msg.textContent = "Le titre est obligatoire."; return; }
      if (!payload.clinic) { msg.className = "form-msg error"; msg.textContent = "Choisissez une clinique."; return; }
      if (!payload.lines.length) { msg.className = "form-msg error"; msg.textContent = "Cochez au moins une ligne thérapeutique."; return; }
      if (ex) payload.id = ex.id;
      if (opts.fromDrop) Object.assign(payload, { file: row.file, html: row.html, drugs: row.drugs, docx: row.docx });
      save.disabled = true;
      msg.className = "form-msg"; msg.textContent = "Enregistrement…";
      const { error } = await sb.rpc("letters_upsert", { p_row: payload });
      save.disabled = false;
      if (error) { msg.className = "form-msg error"; msg.textContent = "Refusé : " + error.message; return; }
      state.lastClinic = payload.clinic;
      f.remove();
      $("lt-drop-msg").className = "form-msg ok";
      $("lt-drop-msg").textContent = `« ${payload.title} » enregistrée.`;
      await refresh();
    });
    return f;
  }

  async function remove(r) {
    if (!confirm(`Supprimer définitivement la lettre « ${r.title} » ?`)) return;
    const { error } = await sb.rpc("letters_delete", { p_id: r.id });
    if (error) return alert("Suppression refusée : " + error.message);
    await refresh();
  }

  async function dropped(files) {
    const docs = [...files].filter((f) => /\.docx$/i.test(f.name));
    const msg = $("lt-drop-msg");
    if (!docs.length) { msg.className = "form-msg error"; msg.textContent = "Déposez des fichiers Word (.docx)."; return; }
    msg.className = "form-msg"; msg.textContent = "Lecture…";
    try {
      await loadScript(MAMMOTH, "mammoth");
      for (const file of docs) {
        const row = await window.LetterParse.fromDocx(file, window.mammoth);
        const existing = state.rows.find((r) => r.file === row.file);
        $("lt-editors").prepend(editor(row, { existing, fromDrop: true }));
      }
      msg.textContent = `${docs.length} lettre${docs.length > 1 ? "s" : ""} à vérifier puis enregistrer.`;
    } catch (err) { msg.className = "form-msg error"; msg.textContent = "Lecture impossible : " + err.message; }
  }

  async function exportIndex() {
    await loadScript(EXCELJS, "ExcelJS");
    const wb = new window.ExcelJS.Workbook();
    const ws = wb.addWorksheet("Lettres");
    ws.columns = [["Fichier", 52], ["Titre", 44], ["Clinique", 14], ["Diagnostic", 28], ["Drivers / marqueurs", 32],
      ["Lignes", 36], ["Étude de référence", 24], ["Mots-clés", 36], ["Remarque", 50]].map(([header, width]) => ({ header, width }));
    ws.getRow(1).font = { bold: true };
    for (const r of state.rows) ws.addRow([r.file, r.title, r.clinic, r.diagnosis, r.markers,
      r.lines.map((l) => LINE_LABEL[l]).join(" ; "), r.trial, r.keywords, r.note]);
    const url = URL.createObjectURL(new Blob([await wb.xlsx.writeBuffer()], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    const a = el("a");
    a.href = url; a.download = `index-lettres-${new Date().toISOString().slice(0, 10)}.xlsx`;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function setupAdmin() {
    state.admin = true;
    $("ug-admin").hidden = false;
    const zone = $("lt-drop"), input = $("lt-drop-input");
    zone.addEventListener("click", () => input.click());
    zone.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } });
    input.addEventListener("change", () => { dropped(input.files); input.value = ""; });
    zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("over"); });
    zone.addEventListener("dragleave", () => zone.classList.remove("over"));
    zone.addEventListener("drop", (e) => { e.preventDefault(); zone.classList.remove("over"); dropped(e.dataTransfer.files); });
    $("lt-export").addEventListener("click", exportIndex);

    // Import complet
    const out = $("ug-import-msg");
    const issues = $("lt-issues");
    let parsed = null;
    const read = async () => {
      parsed = null;
      $("ug-import").disabled = true;
      issues.replaceChildren();
      const index = $("lt-index").files[0], docs = $("lt-docx").files;
      if (!docs.length) return;
      out.className = "form-msg";
      out.textContent = "Lecture des fichiers…";
      try {
        await Promise.all([loadScript(EXCELJS, "ExcelJS"), loadScript(MAMMOTH, "mammoth")]);
        let res;
        if (index) {
          const wb = new window.ExcelJS.Workbook();
          await wb.xlsx.load(await index.arrayBuffer());
          res = await window.LetterParse.build(wb, docs, window.mammoth);
        } else {
          res = { rows: [], errors: [], warnings: [] };
          for (const f of [...docs].filter((x) => /\.docx$/i.test(x.name))) {
            const r = await window.LetterParse.fromDocx(f, window.mammoth);
            r.warnings.forEach((w) => res.warnings.push(`${r.file} : ${w}`));
            delete r.warnings;
            res.rows.push(Object.assign(r, { position: res.rows.length + 1, clinic: state.lastClinic || null, keywords: null, note: null }));
          }
        }
        issues.replaceChildren(...res.errors.map((e) => el("li", "error", e)), ...res.warnings.map((w) => el("li", null, w)));
        if (res.errors.length) throw new Error(`${res.errors.length} erreur(s) à corriger dans le tableur`);
        if (!res.rows.length) throw new Error("aucune lettre");
        parsed = { rows: res.rows, name: index ? index.name : "détection automatique" };
        out.textContent = `${res.rows.length} lettres prêtes à importer.` + (res.warnings.length ? ` ${res.warnings.length} remarque(s) ci-dessous.` : "");
        $("ug-import").disabled = false;
      } catch (err) {
        out.className = "form-msg error";
        out.textContent = "Import impossible : " + err.message;
      }
    };
    $("lt-index").addEventListener("change", read);
    $("lt-docx").addEventListener("change", read);
    $("ug-import").addEventListener("click", async () => {
      if (!parsed || !confirm(`Remplacer toutes les lettres par ces ${parsed.rows.length} lettres ?`)) return;
      $("ug-import").disabled = true;
      out.className = "form-msg";
      out.textContent = "Import en cours…";
      const { data, error } = await sb.rpc("letters_replace", { p_rows: parsed.rows, p_source: parsed.name });
      if (error) {
        out.className = "form-msg error";
        out.textContent = "Import refusé : " + error.message;
        $("ug-import").disabled = false;
        return;
      }
      out.className = "form-msg ok";
      out.textContent = `${data} lettres importées.`;
      await refresh();
    });
  }

  // ----- Démarrage -----
  (async () => {
    if (!sb) return ($("ug-status").textContent = "Service indisponible.");
    const { data } = await sb.auth.getSession();
    if (!data.session) return (location.href = "/fr/ruche.html");
    $("logout").addEventListener("click", async () => { await sb.auth.signOut(); location.href = "/fr/"; });

    const { data: profile } = await sb.from("profiles").select("role").eq("id", data.session.user.id).single();
    const role = profile ? profile.role : "member";
    for (const id of ["q", "f-dx", "f-mk"]) $(id).addEventListener("input", search);
    $("f-clinic").addEventListener("change", (e) => { state.clinic = e.target.value; search(); });
    if (role === "admin") setupAdmin();

    const rows = await loadRows();
    if (!rows || !rows.length) {
      $("ug-status").textContent = role === "admin"
        ? "Aucune lettre. Déposez vos lettres Word ci-dessous."
        : "Cet outil est réservé aux médecins du CHUV. Contactez l'administrateur si vous pensez y avoir droit.";
      return;
    }
    $("ug-status").hidden = true;
    $("ug-tool").hidden = false;
    prepare(rows);
    setupFilters();
    $("q").focus();
  })();
})();
