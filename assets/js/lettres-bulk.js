// Lettres d'assurance : changer en bloc le nom commercial ou la firme d'une substance (outil admin).
// Le remplacement vise la ligne de la substance dans le tableau « Médicament demandé » (colonne nom commercial + firme), en option
// aussi le corps de la lettre. Il s'applique au texte affiché, aux médicaments indexés et au fichier Word d'origine.
(function (root) {
  const JSZIP = "https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js";
  const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  const XMLNS = "http://www.w3.org/XML/1998/namespace";
  const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
  const isDrugTable = (t) => /code d.indication/.test(norm(t.textContent));

  // ----- Remplacement dans une suite de nœuds de texte (un paragraphe) -----
  // Gère un texte coupé en plusieurs morceaux (changement de mise en forme au milieu du nom) ; garde la mise en forme du premier morceau.
  // nodes : [{ get(), set(v) }]. Renvoie le nombre de remplacements. La casse est ignorée à la recherche.
  function replaceInNodes(nodes, find, repl) {
    if (!find) return 0;
    const texts = nodes.map((n) => n.get());
    const full = texts.join("");
    let hay = full.toLowerCase(), needle = find.toLowerCase();
    if (hay.length !== full.length || needle.length !== find.length) { hay = full; needle = find; }
    const lens = texts.map((t) => t.length);
    const starts = [];
    let p = 0;
    for (const l of lens) { starts.push(p); p += l; }
    const hits = [];
    for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) hits.push(i);
    const nodeAt = (pos) => { for (let i = 0; i < lens.length; i++) if (pos < starts[i] + lens[i]) return i; return lens.length - 1; };
    for (let h = hits.length - 1; h >= 0; h--) {
      const s = hits[h], e = s + needle.length;
      const i0 = nodeAt(s), i1 = nodeAt(e - 1);
      if (i0 === i1) texts[i0] = texts[i0].slice(0, s - starts[i0]) + repl + texts[i0].slice(e - starts[i0]);
      else {
        texts[i0] = texts[i0].slice(0, s - starts[i0]) + repl;
        for (let k = i0 + 1; k < i1; k++) texts[k] = "";
        texts[i1] = texts[i1].slice(e - starts[i1]);
      }
    }
    nodes.forEach((n, i) => { if (hits.length && texts[i] !== n.get()) n.set(texts[i]); });
    return hits.length;
  }

  // ----- HTML (texte affiché) -----
  const BLOCK = "p, td, th, li, h1, h2, h3, h4, h5, h6";
  const leafBlocks = (scope) => [...scope.querySelectorAll(BLOCK)].filter((b) => !b.querySelector(BLOCK));
  function htmlNodes(el) {
    const out = [];
    const w = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    while (w.nextNode()) { const n = w.currentNode; out.push({ get: () => n.nodeValue, set: (v) => { n.nodeValue = v; } }); }
    return out;
  }
  const firstLine = (cell) => [...cell.querySelectorAll("p")].map((p) => p.textContent.trim()).find(Boolean) || cell.textContent.trim();
  const cellLines = (cell) => { const ps = [...cell.querySelectorAll("p")].map((p) => p.textContent.trim()).filter(Boolean); return (ps.length ? ps : [cell.textContent.trim()]).join(" / "); };

  // spec : { substance (normalisée), changes: [{find, repl}], body: bool }
  function patchHtml(html, spec) {
    const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
    const table = [...doc.querySelectorAll("table")].find(isDrugTable);
    const out = { html, tableCount: 0, bodyCount: 0, rows: [] };
    if (table) {
      for (const tr of table.querySelectorAll("tr")) {
        const cells = [...tr.children];
        if (cells.length < 2 || !norm(firstLine(cells[0])).includes(spec.substance)) continue;
        const before = cellLines(cells[1]);
        const blocks = leafBlocks(cells[1]);
        for (const b of blocks.length ? blocks : [cells[1]]) for (const c of spec.changes) out.tableCount += replaceInNodes(htmlNodes(b), c.find, c.repl);
        out.rows.push({ before, after: cellLines(cells[1]) });
      }
    }
    if (spec.body) {
      for (const b of leafBlocks(doc.body)) {
        if (table && table.contains(b)) continue;
        for (const c of spec.changes) out.bodyCount += replaceInNodes(htmlNodes(b), c.find, c.repl);
      }
    }
    out.html = doc.body.innerHTML;
    return out;
  }

  // ----- Word (.docx) -----
  function loadScript(src, global) {
    return new Promise((ok, ko) => {
      if (root[global]) return ok();
      const s = document.createElement("script");
      s.src = src; s.onload = ok; s.onerror = () => ko(new Error("chargement de " + global + " impossible"));
      document.head.append(s);
    });
  }
  const kids = (el, name) => [...el.children].filter((c) => c.localName === name && c.namespaceURI === W);
  const paras = (el) => [...el.getElementsByTagNameNS(W, "p")];
  const runs = (p) => [...p.getElementsByTagNameNS(W, "t")].map((t) => ({
    get: () => t.textContent,
    set: (v) => { t.textContent = v; t.setAttributeNS(XMLNS, "xml:space", "preserve"); }
  }));
  const pText = (p) => [...p.getElementsByTagNameNS(W, "t")].map((t) => t.textContent).join("").trim();

  // Renvoie { changed, tableCount, bodyCount, base64 } ; base64 seulement si le Word a changé
  async function patchDocx(base64, spec) {
    await loadScript(JSZIP, "JSZip");
    const zip = await root.JSZip.loadAsync(base64, { base64: true });
    const file = zip.file("word/document.xml");
    if (!file) return { changed: false, tableCount: 0, bodyCount: 0, error: "document.xml introuvable" };
    const doc = new DOMParser().parseFromString(await file.async("string"), "application/xml");
    if (doc.getElementsByTagName("parsererror").length) return { changed: false, tableCount: 0, bodyCount: 0, error: "XML illisible" };
    const table = [...doc.getElementsByTagNameNS(W, "tbl")].find(isDrugTable);
    const res = { changed: false, tableCount: 0, bodyCount: 0 };
    if (table) {
      for (const tr of kids(table, "tr")) {
        const cells = kids(tr, "tc");
        if (cells.length < 2) continue;
        const first = paras(cells[0]).map(pText).find(Boolean) || "";
        if (!norm(first).includes(spec.substance)) continue;
        for (const p of paras(cells[1])) for (const c of spec.changes) res.tableCount += replaceInNodes(runs(p), c.find, c.repl);
      }
    }
    if (spec.body) {
      for (const p of paras(doc)) {
        if (table && table.contains(p)) continue;
        for (const c of spec.changes) res.bodyCount += replaceInNodes(runs(p), c.find, c.repl);
      }
    }
    if (!res.tableCount && !res.bodyCount) return res;
    let xml = new XMLSerializer().serializeToString(doc);
    if (!/^<\?xml/.test(xml)) xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' + xml;
    zip.file("word/document.xml", xml);
    res.base64 = await zip.generateAsync({ type: "base64", compression: "DEFLATE", compressionOptions: { level: 6 } });
    res.changed = true;
    return res;
  }

  // ----- Interface -----
  function el(tag, cls, txt) { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  const button = (label, cls, fn) => { const b = el("button", cls, label); b.type = "button"; b.addEventListener("click", fn); return b; };
  const fmt = (d) => new Date(d).toLocaleDateString("fr-CH");

  function init(ctx) {
    const { sb, getRows, refresh, sanitize } = ctx;
    const box = document.getElementById("lt-subst-body");
    if (!box) return;
    let affected = [], preview = null;

    box.append(el("p", "muted", "Remplace le nom commercial et/ou la firme d'une substance dans toutes les lettres qui la contiennent : tableau « Médicament demandé », médicaments indexés et fichier Word. Vous vérifiez l'aperçu avant d'appliquer."));
    const q = el("input"); q.setAttribute("list", "lt-subst-list"); q.placeholder = "ex. pemetrexed"; q.autocomplete = "off"; q.setAttribute("aria-label", "Substance");
    const list = el("datalist"); list.id = "lt-subst-list";
    const lab = (t, input) => { const l = el("label", null, t); l.append(input); return l; };
    const info = el("p", "muted", "");
    const selOld = (t) => { const s = el("select"); s.setAttribute("aria-label", t); return s; };
    const oldBrand = selOld("Ancien nom commercial"), oldCompany = selOld("Ancienne firme");
    const newBrand = el("input"); newBrand.setAttribute("aria-label", "Nouveau nom commercial"); newBrand.placeholder = "Nouveau nom commercial";
    const newCompany = el("input"); newCompany.setAttribute("aria-label", "Nouvelle firme"); newCompany.placeholder = "Nouvelle firme";
    const grid = el("div", "lt-bulk-grid");
    grid.append(lab("Ancien nom commercial", oldBrand), lab("Nouveau nom commercial", newBrand), lab("Ancienne firme", oldCompany), lab("Nouvelle firme", newCompany));
    const bodyOpt = el("input"); bodyOpt.type = "checkbox";
    const bodyLab = el("label", "lt-check", null); bodyLab.append(bodyOpt, " Remplacer aussi dans le texte de la lettre (hors tableau)");
    const msg = el("p", "form-msg"); msg.setAttribute("role", "status"); msg.setAttribute("aria-live", "polite");
    const out = el("div", "lt-bulk-out");
    const log = el("div", "lt-bulk-log");
    box.append(lab("Substance", q), list, info, grid, bodyLab, button("Aperçu", "btn btn-outline", showPreview), msg, out, log);

    const subst = () => norm(q.value);
    function substances() {
      const m = new Map();
      for (const r of getRows()) for (const d of r.drugs) { const k = norm(d.substance); if (k && !m.has(k)) m.set(k, d.substance); }
      return [...m.values()].sort((a, b) => a.localeCompare(b));
    }
    function refreshList() { list.replaceChildren(...substances().map((s) => { const o = el("option"); o.value = s; return o; })); }
    const matches = (d, s) => norm(d.substance).includes(s);

    function onSubstance() {
      preview = null; out.replaceChildren(); msg.textContent = "";
      const s = subst();
      affected = s.length >= 3 ? getRows().filter((r) => r.drugs.some((d) => matches(d, s))) : [];
      const brands = new Map(), companies = new Map();
      for (const r of affected) for (const d of r.drugs.filter((x) => matches(x, s))) {
        if (d.brand) brands.set(d.brand, (brands.get(d.brand) || 0) + 1);
        if (d.company) companies.set(d.company, (companies.get(d.company) || 0) + 1);
      }
      const fill = (sel, map) => {
        sel.replaceChildren(new Option("— inchangé —", ""));
        [...map].sort((a, b) => b[1] - a[1]).forEach(([v, n]) => sel.append(new Option(`${v} (${n})`, v)));
      };
      fill(oldBrand, brands); fill(oldCompany, companies);
      info.textContent = s.length < 3 ? "" : affected.length ? `${affected.length} lettre${affected.length > 1 ? "s" : ""} contiennent cette substance.` : "Aucune lettre ne contient cette substance.";
    }
    q.addEventListener("input", onSubstance);

    function spec() {
      const changes = [];
      if (oldBrand.value && newBrand.value.trim()) changes.push({ find: oldBrand.value, repl: newBrand.value.trim(), field: "brand" });
      if (oldCompany.value && newCompany.value.trim()) changes.push({ find: oldCompany.value, repl: newCompany.value.trim(), field: "company" });
      return { substance: subst(), changes, body: bodyOpt.checked };
    }
    const fail = (t) => { msg.className = "form-msg error"; msg.textContent = t; return false; };

    function showPreview() {
      out.replaceChildren(); msg.className = "form-msg"; msg.textContent = "";
      const sp = spec();
      if (sp.substance.length < 3 || !affected.length) return fail("Choisissez d'abord une substance présente dans les lettres.");
      if ((oldBrand.value && !newBrand.value.trim()) || (oldCompany.value && !newCompany.value.trim())) return fail("Indiquez le nouveau texte à côté de chaque ancien texte choisi.");
      if (!sp.changes.length) return fail("Choisissez un ancien nom commercial ou une ancienne firme, et le nouveau texte.");
      preview = affected.map((r) => Object.assign({ r }, patchHtml(r.html, sp)));
      const ul = el("ul", "lt-bulk-list");
      preview.forEach((p, i) => {
        const n = p.tableCount + p.bodyCount;
        const li = el("li");
        const c = el("input"); c.type = "checkbox"; c.checked = n > 0; c.disabled = n === 0; c.dataset.i = String(i);
        c.setAttribute("aria-label", "Modifier " + p.r.title);
        const l = el("label", "lt-check", null); l.append(c, " ", el("strong", null, p.r.title));
        li.append(l);
        if (n === 0) li.append(el("p", "muted", "Texte à remplacer introuvable dans cette lettre : aucun changement."));
        p.rows.forEach((x) => li.append(el("p", "lt-bulk-diff", `Tableau : ${x.before}  →  ${x.after}`)));
        if (p.bodyCount) li.append(el("p", "lt-bulk-diff", `Texte de la lettre : ${p.bodyCount} remplacement${p.bodyCount > 1 ? "s" : ""}`));
        ul.append(li);
      });
      const total = preview.filter((p) => p.tableCount + p.bodyCount > 0).length;
      out.append(el("p", null, `${total} lettre${total > 1 ? "s" : ""} sur ${preview.length} seraient modifiées. Décochez celles à laisser telles quelles.`), ul,
        button("Appliquer aux lettres cochées", "btn", apply));
    }

    async function apply() {
      const sp = spec();
      const chosen = [...out.querySelectorAll("input[type=checkbox]:checked")].map((c) => preview[+c.dataset.i]);
      if (!chosen.length) return fail("Aucune lettre cochée.");
      if (!confirm(`Modifier ${chosen.length} lettre${chosen.length > 1 ? "s" : ""} (texte, médicaments indexés et fichier Word) ? Pour revenir en arrière, refaites le remplacement dans l'autre sens.`)) return;
      msg.className = "form-msg"; out.querySelectorAll("button").forEach((b) => (b.disabled = true));
      let done = 0, occ = 0; const wordMiss = [], errors = [];
      for (const [i, p] of chosen.entries()) {
        msg.textContent = `Modification ${i + 1} sur ${chosen.length}…`;
        try {
          const drugs = p.r.drugs.map((d) => {
            if (!matches(d, sp.substance)) return d;
            const nd = Object.assign({}, d);
            for (const c of sp.changes) if (norm(nd[c.field]) === norm(c.find)) nd[c.field] = c.repl;
            return nd;
          });
          let docx = null;
          const { data } = await sb.from("letters").select("docx").eq("id", p.r.id).single();
          if (data && data.docx) {
            const w = await patchDocx(data.docx, sp).catch(() => ({ changed: false }));
            if (w.changed) docx = w.base64; else wordMiss.push(p.r.title);
          } else wordMiss.push(p.r.title);
          const { error } = await sb.rpc("letters_patch", { p_id: p.r.id, p_html: sanitize(p.html), p_drugs: drugs, p_docx: docx });
          if (error) throw error;
          done++; occ += p.tableCount + p.bodyCount;
        } catch (e) { errors.push(`${p.r.title} : ${e.message || e}`); }
      }
      const by = (f) => sp.changes.find((c) => c.field === f);
      if (done) await sb.rpc("letters_log_change", { p_substance: q.value.trim(), p_old_brand: by("brand") ? by("brand").find : null, p_new_brand: by("brand") ? by("brand").repl : null,
        p_old_company: by("company") ? by("company").find : null, p_new_company: by("company") ? by("company").repl : null, p_in_body: sp.body, p_letters: done, p_occurrences: occ });
      await refresh();
      onSubstance(); refreshList(); showLog(); // remet l'écran à zéro ; le résultat s'affiche ensuite
      const ok = !errors.length;
      msg.className = "form-msg " + (ok ? "ok" : "error");
      msg.textContent = `${done} lettre${done > 1 ? "s" : ""} modifiée${done > 1 ? "s" : ""} (${occ} remplacement${occ > 1 ? "s" : ""}).`
        + (wordMiss.length ? ` Fichier Word non modifié pour : ${wordMiss.join(" ; ")} (à vérifier ou à réimporter).` : " Fichiers Word mis à jour.")
        + (errors.length ? " Erreurs : " + errors.join(" ; ") : "");
    }

    async function showLog() {
      const { data } = await sb.from("letters_changes").select("changed_at, substance, old_brand, new_brand, old_company, new_company, in_body, letters, occurrences").order("changed_at", { ascending: false }).limit(5);
      if (!data || !data.length) { log.replaceChildren(); return; }
      const ul = el("ul", "lt-bulk-list");
      for (const c of data) {
        const parts = [c.old_brand ? `nom commercial « ${c.old_brand} » → « ${c.new_brand} »` : "", c.old_company ? `firme « ${c.old_company} » → « ${c.new_company} »` : ""].filter(Boolean).join(" ; ");
        ul.append(el("li", "muted", `${fmt(c.changed_at)} · ${c.substance} · ${parts} · ${c.letters} lettre${c.letters > 1 ? "s" : ""}${c.in_body ? " (texte inclus)" : ""}`));
      }
      log.replaceChildren(el("h3", "lt-bulk-h", "Derniers changements"), ul);
    }
    refreshList(); showLog();
    return { refreshList };
  }

  root.LettersBulk = { init, patchHtml, patchDocx, replaceInNodes, norm };
})(window);
