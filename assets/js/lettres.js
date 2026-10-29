// Lettres types de demande de garantie : recherche dans les lettres importées (table letters).
// Tout se passe dans le navigateur : les lettres sont chargées une fois, puis filtrées localement.
(function () {
  const cfg = window.ONCONIC_CONFIG || {};
  const sb = window.supabase && cfg.supabaseUrl ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey) : null;
  const EXCELJS = "https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js";
  const MAMMOTH = "https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js";
  const LINES = window.LetterParse.LINES;
  const LINE_LABEL = Object.fromEntries(LINES);

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
      if (state.clinic && r.clinic !== state.clinic) continue;
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

  function setupFilters() {
    chips("ug-lines", LINES, "line", "Toutes lignes");
    const clinics = [...new Set(state.rows.map((r) => r.clinic).filter(Boolean))].sort();
    if (clinics.length > 1) chips("ug-clinics", clinics.map((c) => [c, c]), "clinic", "Toutes cliniques");
    else $("ug-clinics").hidden = true;
    chips("ug-routes", [["IV", "IV"], ["SC", "SC"], ["PO", "Oral"]], "route", "Toutes voies");
    const fill = (id, values) => $(id).replaceChildren(...[...new Set(values)].sort().map((v) => { const o = el("option"); o.value = v; return o; }));
    fill("dx-list", state.rows.map((r) => r.diagnosis).filter(Boolean));
    fill("mk-list", state.rows.flatMap((r) => (r.markers || "").split(";").map((m) => m.trim())).filter(Boolean));
    for (const id of ["q", "f-dx", "f-mk"]) $(id).addEventListener("input", search);
    search();
  }

  // ----- Import (admin) -----
  function loadScript(src, global) {
    return new Promise((ok, ko) => {
      if (window[global]) return ok();
      const s = document.createElement("script");
      s.src = src; s.onload = ok; s.onerror = () => ko(new Error("chargement de " + global + " impossible"));
      document.head.append(s);
    });
  }

  function setupImport() {
    $("ug-admin").hidden = false;
    const out = $("ug-import-msg");
    const issues = $("lt-issues");
    let parsed = null;
    const read = async () => {
      parsed = null;
      $("ug-import").disabled = true;
      issues.replaceChildren();
      const index = $("lt-index").files[0], docs = $("lt-docx").files;
      if (!index || !docs.length) return;
      out.className = "form-msg";
      out.textContent = "Lecture des fichiers…";
      try {
        await Promise.all([loadScript(EXCELJS, "ExcelJS"), loadScript(MAMMOTH, "mammoth")]);
        const wb = new window.ExcelJS.Workbook();
        await wb.xlsx.load(await index.arrayBuffer());
        const res = await window.LetterParse.build(wb, docs, window.mammoth);
        issues.replaceChildren(...res.errors.map((e) => el("li", "error", e)), ...res.warnings.map((w) => el("li", null, w)));
        if (res.errors.length) throw new Error(`${res.errors.length} erreur(s) à corriger dans le tableur`);
        if (!res.rows.length) throw new Error("aucune lettre");
        parsed = { rows: res.rows, name: index.name };
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
      if (!parsed) return;
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
      out.textContent = `${data} lettres importées. Rechargement…`;
      setTimeout(() => location.reload(), 1200);
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
    if (role === "admin") setupImport();

    const [{ data: rows, error }, { data: meta }] = await Promise.all([
      sb.from("letters").select("id, position, file, title, clinic, diagnosis, markers, lines, trial, keywords, note, drugs, html").order("position").range(0, 999),
      sb.from("letters_meta").select("source_file, imported_at, row_count").maybeSingle()
    ]);
    if (error || !rows || !rows.length) {
      $("ug-status").textContent = role === "admin"
        ? "Aucune lettre. Importez le tableur d'index et les lettres Word ci-dessous."
        : "Cet outil est réservé aux médecins du CHUV. Contactez l'administrateur si vous pensez y avoir droit.";
      return;
    }
    if (meta) {
      const d = new Date(meta.imported_at);
      $("ug-source").textContent = `Source : ${meta.source_file}, importé le ${d.toLocaleDateString("fr-CH")} (${meta.row_count} lettres).`;
    }
    $("ug-status").hidden = true;
    $("ug-tool").hidden = false;
    prepare(rows);
    setupFilters();
    $("q").focus();
  })();
})();
