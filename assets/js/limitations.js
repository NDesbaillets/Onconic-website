// Limitations LS : recherche des limitations en vigueur et des codes d'indication, textes d'ordonnance per os validés.
// La LS est chargée une fois (oncologie et traitements associés), puis tout se passe dans le navigateur.
(function () {
  const cfg = window.ONCONIC_CONFIG || {};
  const sb = window.supabase && cfg.supabaseUrl ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey) : null;
  const EXCELJS = "https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js";
  const $ = (id) => document.getElementById(id);

  // Types de cancer par clinique ; l'expression repère le cancer dans le texte de la limitation
  const CANCERS = {
    "Thoracique": [["CBNPC", /non[- ]a petites cellules|cbnpc|cpnpc|nsclc/], ["CPPC", /(?<!non[- ])a petites cellules|cppc|sclc/],
      ["Mésothéliome", /mesotheliome/], ["Thymome / carcinome thymique", /thym/]],
    "Sénologie": [["Cancer du sein", /sein|mammaire/]],
    "Gynécologie": [["Ovaire, trompe, péritoine", /ovair|trompe|peritoine/], ["Endomètre", /endometr|uterus|uterin/],
      ["Col de l'utérus", /col de l.uterus|col uterin|cervical/], ["Vulve", /vulv/]],
    "Urologie": [["Prostate", /prostat/], ["Rein", /renal|cellules renales|rein/], ["Urothélial / vessie", /urothel|vessie/],
      ["Tumeur germinale", /germinal|testicul/]],
    "Neuro-oncologie": [["Gliome", /gliom|glioblastome|astrocytome|oligodendro/], ["Métastases cérébrales", /cerebral|snc|systeme nerveux central/]],
    "Mélanome": [["Mélanome", /melanome/], ["Carcinome de Merkel", /merkel/], ["Carcinome épidermoïde cutané", /epidermoide cutane|cutane.{0,40}epidermoide/],
      ["Carcinome basocellulaire", /basocellulaire/]],
    "Lower GI": [["Colorectal", /colorectal|colon|rectum|rectal/], ["Canal anal", /canal anal|\banal\b/]],
    "Upper GI": [["Estomac / jonction œsogastrique", /gastri|estomac|jonction/], ["Œsophage", /oesophag/], ["Pancréas", /pancrea/],
      ["Voies biliaires", /biliaire|cholangio/], ["Carcinome hépatocellulaire", /hepatocellulaire|chc\b/], ["GIST", /stromal|gist/],
      ["Tumeur neuroendocrine", /neuroendocrine/]],
    "ORL": [["Carcinome épidermoïde tête et cou", /tete et (du )?cou|orl|oropharyn|hypopharyn|larynx|cavite buccale/], ["Nasopharynx", /nasopharyn/],
      ["Thyroïde", /thyroid/], ["Glandes salivaires", /salivaire/]],
    "Sarcomes": [["Sarcome des tissus mous", /sarcome|liposarcome|leiomyosarcome/], ["GIST", /stromal|gist/], ["Ostéosarcome", /osteosarcome/],
      ["Tumeur desmoïde", /desmoide/]],
    "Radiologie interventionnelle": [["Carcinome hépatocellulaire", /hepatocellulaire|chc\b/]]
  };
  const CLINICS = Object.keys(CANCERS);
  const GUARANTEE = /garantie|accord prealable|autorisation prealable|consultation prealable du medecin[- ]conseil/;

  const state = { products: [], limits: [], rx: [], changes: [], meta: null, admin: false, uid: null, pick: {}, rxPick: {}, cart: [] };

  const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
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
  async function copy(btn, text, label) {
    try { await navigator.clipboard.writeText(text); btn.textContent = "Copié"; } catch (x) { btn.textContent = "Copie impossible"; }
    setTimeout(() => (btn.textContent = label), 1500);
  }
  const fmtDate = (s) => (s ? String(s).replace(/^(\d{4})-(\d{2})-(\d{2}).*$/, "$3.$2.$1") : "");

  // ----- Chargement -----
  async function all(table, cols) {
    const out = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from(table).select(cols).range(from, from + 999);
      if (error) throw error;
      out.push(...data);
      if (data.length < 1000) return out;
    }
  }
  async function load() {
    const [products, limits, rx, changes, meta] = await Promise.all([
      all("sl_products", "specialty, galenic, substance, atc, limited, peros"),
      all("sl_limitations", "specialty, substance, atc, galenics, lim_code, ind_code, valid_from, valid_to, body"),
      all("sl_rx", "id, substance, product_line, sig, dose_levels, dose_note, source, status, position, updated_at, validated_at"),
      all("sl_changes", "kind, specialty, substance, lim_code, ind_code"),
      sb.from("sl_meta").select("source_file, imported_at, product_count, limitation_count").maybeSingle()
    ]);
    for (const p of products) { p._s = norm(p.substance); p._b = norm(p.specialty); }
    for (const l of limits) { l._s = norm(l.substance); l._body = norm(l.body); }
    for (const r of rx) r._k = stem(norm(r.substance));
    state.products = products; state.limits = limits; state.changes = changes; state.meta = meta.data;
    state.rx = rx.sort((a, b) => a.position - b.position || a.product_line.localeCompare(b.product_line));
  }

  function renderMeta() {
    const m = state.meta;
    $("ls-source").textContent = m
      ? `Liste des spécialités : ${m.source_file}, importée le ${new Date(m.imported_at).toLocaleDateString("fr-CH")} (${m.product_count} produits, ${m.limitation_count} limitations, oncologie et traitements associés).`
      : "Liste des spécialités pas encore importée.";
    const box = $("ls-changes");
    if (!state.changes.length) { box.hidden = true; return; }
    const n = (k) => state.changes.filter((c) => c.kind === k).length;
    box.querySelector("summary").textContent = `Changements de la dernière mise à jour des limitations : ${n("new")} nouvelle(s), ${n("changed")} modifiée(s), ${n("removed")} supprimée(s)`;
    const LBL = { new: "Nouvelle", changed: "Modifiée", removed: "Supprimée" };
    $("ls-changes-list").replaceChildren(...state.changes.slice().sort((a, b) => a.kind.localeCompare(b.kind) || a.specialty.localeCompare(b.specialty)).map((c) => {
      const li = el("li");
      li.append(el("span", "ug-badge ls-ch-" + c.kind, LBL[c.kind]), ` ${c.specialty} (${c.substance || ""}) · ${c.ind_code || c.lim_code}`);
      return li;
    }));
    box.hidden = false;
  }

  function fillDatalist() {
    const names = new Set();
    for (const p of state.products) { names.add(p.specialty); names.add(shortSubstance(p.substance)); }
    $("ls-list").replaceChildren(...[...names].filter(Boolean).sort((a, b) => a.localeCompare(b)).map((v) => { const o = el("option"); o.value = v; return o; }));
  }
  // « Osimertinibum (mésilate) » → « osimertinibum »
  const shortSubstance = (s) => String(s || "").split(/[,(]/)[0].trim();

  // ----- Recherche -----
  function terms() {
    return $("ls-q").value.split(/[,;+\n]|\bet\b/).map((t) => norm(t)).filter((t) => t.length >= 3);
  }

  // Racine commune français/latin : « capécitabine » ↔ « Capecitabinum », « témozolomide » ↔ « Temozolomidum »
  const stem = (t) => (t.length > 5 ? t.replace(/e$/, "") : t);

  function search(term) {
    const st = stem(term);
    const hits = state.products.filter((p) => p._s.includes(st) || p._b.includes(term));
    // Regroupement par substance (première DCI), toutes spécialités confondues (originaux et génériques)
    const groups = new Map();
    for (const p of hits) {
      const k = norm(shortSubstance(p.substance));
      if (!groups.has(k)) groups.set(k, { key: k, substance: shortSubstance(p.substance), products: [] });
      groups.get(k).products.push(p);
    }
    return [...groups.values()];
  }

  function limitsOf(group) {
    const specs = new Set(group.products.map((p) => p.specialty));
    const seen = new Map();
    for (const l of state.limits) {
      if (!specs.has(l.specialty)) continue;
      const k = (l.ind_code || l.lim_code) + "|" + l._body;
      if (!seen.has(k)) seen.set(k, Object.assign({}, l, { specialties: [l.specialty] }));
      else if (!seen.get(k).specialties.includes(l.specialty)) seen.get(k).specialties.push(l.specialty);
    }
    return [...seen.values()].sort((a, b) => String(a.ind_code || a.lim_code).localeCompare(String(b.ind_code || b.lim_code)));
  }

  function render() {
    const box = $("ls-results");
    const ts = terms();
    if (!ts.length) { box.replaceChildren(); return; }
    const cancer = cancerRegex();
    const out = [];
    for (const t of ts) {
      const groups = search(t);
      if (!groups.length) { out.push(notFound(t)); continue; }
      for (const g of groups) out.push(card(g, cancer));
    }
    box.replaceChildren(...out);
  }

  function cancerRegex() {
    const list = CANCERS[$("ls-clinic").value] || [];
    const c = list.find(([n]) => n === $("ls-cancer").value);
    return c ? { name: c[0], re: c[1] } : null;
  }

  function notFound(t) {
    const c = el("article", "card ls-card");
    c.append(el("h3", null, t));
    const p = el("p", "ls-none");
    p.append("Introuvable dans la LS (oncologie et traitements associés). S'il s'agit d'un médicament hors liste ou d'une indication hors limitation, une demande de garantie de prise en charge (art. 71a-d OAMal) est nécessaire : ");
    const a = el("a", null, "Lettres d'assurance");
    a.href = "/app/lettres.html?q=" + encodeURIComponent(t);
    p.append(a, ".");
    c.append(p);
    return c;
  }

  function card(g, cancer) {
    const c = el("article", "card ls-card");
    const h = el("h3", null, g.substance);
    c.append(h);
    const specs = [...new Set(g.products.map((p) => p.specialty))];
    const forms = [...new Set(g.products.map((p) => p.galenic).filter(Boolean))];
    c.append(el("p", "muted ls-specs", `${specs.join(", ")} · ${forms.slice(0, 6).join(" ; ")}${forms.length > 6 ? " …" : ""}`));
    const limits = limitsOf(g);
    const limited = g.products.some((p) => p.limited) || limits.length > 0;

    if (!limited) {
      c.append(el("p", "ls-free", "Aucune limitation en cours : prise en charge dans le cadre de l'autorisation Swissmedic."));
    } else if (!limits.length) {
      c.append(el("p", "ls-none", "Limitation signalée dans les données de base, mais texte introuvable dans l'onglet Limitations : vérifiez sur la LS en ligne."));
    } else {
      const match = cancer ? limits.filter((l) => cancer.re.test(l._body)) : limits;
      const rest = cancer ? limits.filter((l) => !match.includes(l)) : [];
      if (cancer && !match.length) {
        c.append(el("p", "ls-none", `Aucune limitation de ce médicament ne mentionne « ${cancer.name} » : indication probablement hors limitation (garantie de prise en charge nécessaire). Limitations en vigueur ci-dessous.`));
      }
      const shown = match.length ? match : limits;
      const hidden = match.length ? rest : [];
      if (!state.pick[g.key] || !limits.some((l) => key(l) === state.pick[g.key])) state.pick[g.key] = shown.length === 1 ? key(shown[0]) : null;
      const list = el("div", "ls-lims");
      shown.forEach((l) => list.append(limitBox(g, l)));
      c.append(list);
      if (hidden.length) {
        const d = el("details", "ls-more");
        d.append(el("summary", null, `Autres limitations de ce médicament (${hidden.length})`));
        hidden.forEach((l) => d.append(limitBox(g, l)));
        c.append(d);
      }
    }
    const peros = g.products.some((p) => p.peros);
    if (peros) c.append(rxBlock(g, limits));
    return c;
  }

  const key = (l) => l.specialty + "|" + l.lim_code;

  function limitBox(g, l) {
    const box = el("div", "ls-lim");
    const head = el("div", "ls-lim-head");
    const radio = el("input");
    radio.type = "radio"; radio.name = "pick-" + g.key; radio.checked = state.pick[g.key] === key(l);
    radio.setAttribute("aria-label", "Utiliser ce code pour l'ordonnance");
    radio.addEventListener("change", () => { state.pick[g.key] = key(l); render(); });
    const code = el("strong", "ls-code", l.ind_code || "sans code d'indication");
    head.append(radio, code);
    if (l.ind_code) head.append(button("Copier le code", "btn btn-outline ug-copy ls-copy", (e) => copy(e.target, l.ind_code, "Copier le code")));
    head.append(el("span", "ug-badge", "Limitation " + l.lim_code));
    if (GUARANTEE.test(l._body)) head.append(el("span", "ug-badge ls-guar", "Garantie préalable de l'assureur"));
    if (l.valid_to) head.append(el("span", "ug-badge ls-until", "Limité au " + fmtDate(l.valid_to)));
    box.append(head);
    const meta = [l.specialties.length > 1 ? "Spécialités : " + l.specialties.join(", ") : "Spécialité : " + l.specialty,
      l.galenics ? "Formes : " + l.galenics : "", l.valid_from ? "Valable dès le " + fmtDate(l.valid_from) : ""].filter(Boolean).join(" · ");
    box.append(el("p", "muted ls-lim-meta", meta));
    const body = el("p", "ls-body", l.body || "");
    box.append(body);
    return box;
  }

  // ----- Ordonnance per os (textes validés uniquement côté médecins) -----
  function rxBlock(g, limits) {
    const wrap = el("div", "ls-rx");
    const tpls = state.rx.filter((r) => r.status === "validated" && g.key.includes(r._k));
    wrap.append(el("h4", null, "Ordonnance (per os)"));
    if (!tpls.length) {
      wrap.append(el("p", "muted", "Aucun texte d'ordonnance validé pour cette substance."));
      return wrap;
    }
    let t = tpls.find((x) => x.id === state.rxPick[g.key]) || tpls[0];
    if (tpls.length > 1) {
      const sel = el("select", "ls-rx-sel");
      tpls.forEach((x) => { const o = el("option", null, x.product_line); o.value = x.id; sel.append(o); });
      sel.value = t.id;
      sel.addEventListener("change", () => { state.rxPick[g.key] = Number(sel.value); render(); });
      const lab = el("label", "ls-rx-label", "Présentation"); lab.append(sel); wrap.append(lab);
    }
    const lim = limits.find((l) => key(l) === state.pick[g.key]);
    const lines = [t.product_line, t.sig];
    if (lim) lines.push(lim.ind_code ? `Code d'indication : ${lim.ind_code}` : `Limitation : ${lim.lim_code}`);
    else if (limits.length) lines.push("Code d'indication : [choisir la limitation ci-dessus]");
    const text = lines.join("\n");
    const pre = el("pre", "ls-rx-text", text);
    wrap.append(pre);
    const row = el("div", "btn-row");
    row.append(button("Copier l'ordonnance", "btn ug-copy", (e) => copy(e.target, text, "Copier l'ordonnance")));
    const missingCode = !lim && limits.length > 0;
    const inCart = state.cart.some((c) => c.id === t.id && c.text === text);
    const add = button(inCart ? "Dans le panier" : "Ajouter au panier", "btn btn-outline ug-copy", () => {
      addToCart({ id: t.id, label: t.product_line, text });
      add.textContent = "Dans le panier"; add.disabled = true;
    });
    add.disabled = missingCode || inCart;
    if (missingCode) add.title = "Choisissez d'abord la limitation";
    row.append(add);
    wrap.append(row);
    if (missingCode) wrap.append(el("p", "muted ls-note", "Choisissez la limitation pour ajouter l'ordonnance au panier."));
    const levels = Array.isArray(t.dose_levels) ? t.dose_levels : [];
    if (levels.length) {
      const tbl = el("table", "ls-levels");
      const thead = el("thead"); const hr = el("tr");
      hr.append(el("th", null, "Palier"), el("th", null, "Dose"));
      thead.append(hr); tbl.append(thead);
      const tb = el("tbody");
      levels.forEach(([a, b]) => { const tr = el("tr"); tr.append(el("td", null, a), el("td", null, b)); tb.append(tr); });
      tbl.append(tb);
      const tw = el("div", "ls-levels-wrap"); tw.append(el("p", "ls-levels-title", "Paliers de dose"), tbl);
      wrap.append(tw);
    }
    if (t.dose_note) wrap.append(el("p", "ls-note", t.dose_note));
    wrap.append(el("p", "muted ls-src", [t.source, t.validated_at ? "validé le " + new Date(t.validated_at).toLocaleDateString("fr-CH") : ""].filter(Boolean).join(" · ")));
    return wrap;
  }

  // ----- Panier d'ordonnance : plusieurs textes per os copiés en un bloc (conservé pendant la session de l'onglet) -----
  const CART_KEY = "onconic-ls-cart";
  function loadCart() {
    try { state.cart = JSON.parse(sessionStorage.getItem(CART_KEY) || "[]"); } catch (x) { state.cart = []; }
  }
  function saveCart() {
    try { sessionStorage.setItem(CART_KEY, JSON.stringify(state.cart)); } catch (x) { /* navigation privée */ }
  }
  function addToCart(item) {
    // Une seule ligne par présentation : un nouvel ajout remplace la précédente (autre code d'indication)
    state.cart = state.cart.filter((c) => c.id !== item.id).concat(item);
    saveCart(); renderCart();
  }
  const cartText = () => state.cart.map((c) => c.text).join("\n\n");
  function renderCart() {
    const box = $("ls-cart"), fl = $("ls-cart-float");
    box.hidden = !state.cart.length;
    fl.hidden = !state.cart.length;
    fl.textContent = `Panier (${state.cart.length})`;
    $("ls-cart-list").replaceChildren(...state.cart.map((c, i) => {
      const li = el("li");
      li.append(el("pre", "ls-rx-text", c.text));
      const row = el("div", "btn-row");
      if (i > 0) row.append(button("Monter", "btn btn-outline ug-copy", () => { const [x] = state.cart.splice(i, 1); state.cart.splice(i - 1, 0, x); saveCart(); renderCart(); }));
      row.append(button("Retirer", "btn btn-outline ug-copy", () => { state.cart.splice(i, 1); saveCart(); renderCart(); render(); }));
      li.append(row);
      return li;
    }));
  }
  function setupCart() {
    loadCart(); renderCart();
    $("ls-cart-copy").addEventListener("click", (e) => copy(e.target, cartText(), "Copier tout"));
    $("ls-cart-clear").addEventListener("click", () => {
      if (!confirm("Vider le panier d'ordonnance ?")) return;
      state.cart = []; saveCart(); renderCart(); render();
    });
  }

  // ----- Filtres -----
  function fillClinics() {
    const sel = $("ls-clinic");
    sel.append(el("option", null, ""), ...CLINICS.map((c) => el("option", null, c)));
    sel.addEventListener("change", () => { fillCancers(); render(); });
    $("ls-cancer").addEventListener("change", render);
  }
  function fillCancers() {
    const sel = $("ls-cancer");
    const list = CANCERS[$("ls-clinic").value] || [];
    sel.replaceChildren(el("option", null, "Tous"), ...list.map(([n]) => el("option", null, n)));
    sel.options[0].value = "";
    sel.disabled = !list.length;
  }

  // ----- Administration : import de la LS -----
  function setupImport() {
    let file = null;
    $("ls-file").addEventListener("change", (e) => { file = e.target.files[0] || null; $("ls-import").disabled = !file; $("ls-import-msg").textContent = ""; });
    $("ls-import").addEventListener("click", async () => {
      const msg = $("ls-import-msg");
      const btn = $("ls-import");
      btn.disabled = true; msg.className = "form-msg"; msg.textContent = "Lecture du fichier…";
      try {
        await loadScript(EXCELJS, "ExcelJS");
        const wb = new window.ExcelJS.Workbook();
        await wb.xlsx.load(await file.arrayBuffer());
        const res = window.SLParse.parseWorkbook(wb);
        if (!res.products.length) throw new Error("aucun produit oncologique trouvé (codes ATC L01, L02…)");
        msg.textContent = `${res.products.length} produits et ${res.limits.length} limitations lus. Enregistrement…`;
        const { data, error } = await sb.rpc("sl_replace", { p_products: res.products, p_limits: res.limits, p_source: file.name });
        if (error) throw error;
        msg.className = "form-msg ok";
        msg.textContent = `Import terminé : ${data.products} produits, ${data.limitations} limitations` + (data.first_import ? "." : `, ${data.changes} changements par rapport à la liste précédente.`);
        await load(); renderMeta(); fillDatalist(); renderRxAdmin(); render();
      } catch (e) {
        msg.className = "form-msg error"; msg.textContent = "Import impossible : " + (e.message || e);
      } finally { btn.disabled = false; }
    });
  }

  // ----- Administration : textes d'ordonnance -----
  function renderRxAdmin() {
    const box = $("ls-rx-admin");
    const ul = el("ul", "ls-rx-list");
    for (const r of state.rx) {
      const li = el("li");
      const head = el("div", "ls-rx-head");
      head.append(el("span", "ug-badge " + (r.status === "validated" ? "ls-ok" : "ls-draft"), r.status === "validated" ? "Validé" : "Brouillon"),
        el("strong", null, r.product_line));
      const row = el("div", "btn-row");
      row.append(button("Voir / modifier", "btn btn-outline ug-copy", () => openEditor(r)));
      if (r.status !== "validated") row.append(button("Valider", "btn ug-copy", () => save(r.id, { status: "validated", validated_by: state.uid, validated_at: new Date().toISOString() })));
      li.append(head, el("p", "ls-rx-sig", r.sig), row);
      ul.append(li);
    }
    const n = state.rx.filter((r) => r.status !== "validated").length;
    box.replaceChildren(el("p", "muted", `${state.rx.length} textes, dont ${n} à valider.`), ul);
    // Substances per os présentes dans la LS sans aucun texte
    const subs = new Set(state.products.filter((p) => p.peros && /^L0[12]/.test(p.atc)).map((p) => norm(shortSubstance(p.substance))));
    const missing = [...subs].filter((s) => !state.rx.some((r) => s.includes(r._k))).sort();
    $("ls-rx-missing").textContent = missing.length ? missing.join(", ") : state.products.length ? "Aucune." : "Importez d'abord la LS.";
  }

  function openEditor(r) {
    const box = $("ls-rx-editor");
    const f = el("div", "ls-editor");
    const field = (label, value, area, rows) => {
      const l = el("label", null, label);
      const i = el(area ? "textarea" : "input");
      i.value = value || ""; if (area) i.rows = rows || 3;
      l.append(i); f.append(l); return i;
    };
    f.append(el("h3", null, r ? "Modifier le texte d'ordonnance" : "Nouveau texte d'ordonnance"));
    const sub = field("Clé de substance (DCI sans accent, ex. osimertinib)", r && r.substance);
    const line = field("Ligne produit (ex. osimertinib, comprimé 80 mg)", r && r.product_line);
    const sig = field("Posologie (ex. S. 80 mg = 1 cp à prendre une fois par jour)", r && r.sig, true, 2);
    const lev = field("Paliers de dose, un par ligne : palier | dose", r ? (r.dose_levels || []).map((x) => x.join(" | ")).join("\n") : "Dose initiale | \n1re réduction | ", true, 5);
    const note = field("Remarque", r && r.dose_note, true, 2);
    const src = field("Source", r ? r.source : "RCP Swissmedic (Compendium)");
    const msg = el("p", "form-msg");
    const preview = el("pre", "ls-rx-text");
    const upd = () => (preview.textContent = [line.value, sig.value, "Code d'indication : XXXXX.XX"].join("\n"));
    [line, sig].forEach((i) => i.addEventListener("input", upd)); upd();
    f.append(el("p", "ls-levels-title", "Aperçu"), preview);
    const values = () => ({
      substance: norm(sub.value), product_line: line.value.trim(), sig: sig.value.trim(),
      dose_levels: lev.value.split("\n").map((x) => x.split("|").map((y) => y.trim())).filter((x) => x[0] && x[1]).map((x) => [x[0], x.slice(1).join(" | ")]),
      dose_note: note.value.trim() || null, source: src.value.trim() || null, updated_by: state.uid, updated_at: new Date().toISOString()
    });
    const row = el("div", "btn-row");
    const check = (v) => { if (!v.substance || !v.product_line || !v.sig) { msg.className = "form-msg error"; msg.textContent = "Clé, ligne produit et posologie sont nécessaires."; return false; } return true; };
    row.append(button(r && r.status === "validated" ? "Enregistrer (reste validé)" : "Enregistrer en brouillon", "btn btn-outline", async () => {
      const v = values(); if (!check(v)) return;
      await save(r && r.id, v, msg);
    }));
    row.append(button("Enregistrer et valider", "btn", async () => {
      const v = values(); if (!check(v)) return;
      await save(r && r.id, Object.assign(v, { status: "validated", validated_by: state.uid, validated_at: new Date().toISOString() }), msg);
    }));
    if (r && r.status === "validated") row.append(button("Repasser en brouillon", "btn btn-outline", () => save(r.id, { status: "draft", validated_at: null, validated_by: null }, msg)));
    if (r) row.append(button("Supprimer", "btn btn-outline lt-danger", async () => {
      if (!confirm("Supprimer ce texte d'ordonnance ?")) return;
      const { error } = await sb.from("sl_rx").delete().eq("id", r.id);
      if (error) { msg.className = "form-msg error"; msg.textContent = error.message; return; }
      box.replaceChildren(); await reloadRx();
    }));
    row.append(button("Fermer", "btn btn-outline", () => box.replaceChildren()));
    f.append(row, msg);
    box.replaceChildren(f);
    f.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function save(id, values, msg) {
    const q = id ? sb.from("sl_rx").update(values).eq("id", id) : sb.from("sl_rx").insert(values);
    const { error } = await q;
    if (error) {
      if (msg) { msg.className = "form-msg error"; msg.textContent = "Enregistrement refusé : " + error.message; } else alert(error.message);
      return;
    }
    if (msg) { msg.className = "form-msg ok"; msg.textContent = "Enregistré."; }
    await reloadRx();
  }
  async function reloadRx() {
    const rx = await all("sl_rx", "id, substance, product_line, sig, dose_levels, dose_note, source, status, position, updated_at, validated_at");
    for (const r of rx) r._k = stem(norm(r.substance));
    state.rx = rx.sort((a, b) => a.position - b.position || a.product_line.localeCompare(b.product_line));
    renderRxAdmin(); render();
  }

  // ----- Démarrage -----
  (async () => {
    if (!sb) return ($("ug-status").textContent = "Service indisponible.");
    const { data } = await sb.auth.getSession();
    if (!data.session) return (location.href = "/fr/the-hive.html");
    $("logout").addEventListener("click", async () => { await sb.auth.signOut(); location.href = "/fr/"; });
    state.uid = data.session.user.id;
    const { data: role } = await sb.rpc("current_role_name");
    const { data: canUse } = await sb.rpc("has_tool", { p_tool: "limitations" });
    if (role !== "admin" && canUse !== true) return ($("ug-status").textContent = "Cet outil ne fait pas partie de vos accès. Contactez l'administrateur si besoin.");
    state.admin = role === "admin" || role === "pharmacist"; // administration de la LS et des textes d'ordonnance
    try { await load(); } catch (e) { return ($("ug-status").textContent = "Chargement impossible : " + e.message); }
    $("ug-status").hidden = true;
    $("ls-tool").hidden = false;
    fillClinics(); fillCancers(); renderMeta(); fillDatalist(); setupCart();
    let t;
    $("ls-q").addEventListener("input", () => { clearTimeout(t); t = setTimeout(render, 200); });
    const q = new URLSearchParams(location.search).get("q");
    if (q) { $("ls-q").value = q; render(); }
    if (state.admin) {
      $("ls-admin").hidden = false;
      setupImport(); renderRxAdmin();
      $("ls-rx-new").addEventListener("click", () => openEditor(null));
    }
  })();
})();
