// Initiation de traitement : calendrier, agenda, limitations LS et ordonnances à partir des protocoles importés.
// Tout est calculé dans le navigateur, sans IA ; rien n'est enregistré.
(function () {
  const cfg = window.ONCONIC_CONFIG || {};
  const sb = window.supabase && cfg.supabaseUrl ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey) : null;
  const EXCELJS = "https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js";
  const { RX, MASCC, RENEW } = window.InitRx;

  const BLOCS = [
    ["Bloc 1", [["senologie", "Sénologie"], ["gynecologie", "Gynécologie"], ["urologie", "Urologie"]]],
    ["Bloc 2", [["thoracique", "Thoracique"], ["neuro", "Neuro-oncologie"], ["melanome", "Mélanome"]]],
    ["Bloc 3", [["lower-gi", "Lower GI"], ["upper-gi", "Upper GI"], ["orl", "ORL"], ["sarcomes", "Sarcomes"], ["ri", "Radiologie interventionnelle"]]]
  ];

  const $ = (id) => document.getElementById(id);
  const form = () => $("it-form");
  const state = { protocols: [], sl: new Map(), choice: {} };

  const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  // Petit constructeur DOM : jamais d'innerHTML avec des données externes
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k in el && typeof v !== "string") el[k] = v;
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid);
    return el;
  }

  // ----- Dates (UTC pour éviter les décalages d'heure d'été) -----
  const parseDate = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); };
  const addDays = (d, n) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; };
  const addMonths = (d, n) => { const x = new Date(d); x.setUTCMonth(x.getUTCMonth() + n); return x; };
  const fmt = (d) => d.toLocaleDateString("fr-CH", { timeZone: "UTC", day: "2-digit", month: "2-digit", year: "numeric" });
  const wday = (d) => d.toLocaleDateString("fr-CH", { timeZone: "UTC", weekday: "short" }).replace(".", "");
  const weekend = (d) => d.getUTCDay() === 0 || d.getUTCDay() === 6;
  function nextMonday() {
    const t = new Date();
    const d = new Date(Date.UTC(t.getFullYear(), t.getMonth(), t.getDate()));
    return addDays(d, ((8 - d.getUTCDay()) % 7) || 7);
  }
  const parseCH = (s) => { const [d, m, y] = s.split(".").map(Number); return new Date(Date.UTC(y, m - 1, d)); };
  const iso = (d) => d.toISOString().slice(0, 10);

  function daysText(days) {
    const s = [...days].sort((a, b) => a - b);
    const contiguous = s.length > 2 && s.every((v, i) => !i || v === s[i - 1] + 1);
    return contiguous ? `J${s[0]}-${s[s.length - 1]}` : s.map((d) => "J" + d).join(", ");
  }

  // ----- Lecture du formulaire -----
  function current() {
    const f = form();
    const p = state.protocols.find((x) => x.code === f.protocol.value);
    if (!p) return null;
    const variants = {};
    for (const v of p.variants || []) {
      const el = f.querySelector(`input[name="v-${v.id}"]:checked`);
      variants[v.id] = el ? el.value : v.default;
    }
    const on = (drug) => !drug.variant || variants[drug.variant.split(":")[0]] === drug.variant.split(":")[1];
    const variantOk = (item) => !item.variant || variants[item.variant.split(":")[0]] === item.variant.split(":")[1];
    const drugs = p.drugs.filter(on);
    return {
      p, variants, drugs, variantOk,
      start: f.start.value ? parseDate(f.start.value) : null,
      cycles: +f.cycles.value || null,
      cyclen: +f.cyclen.value || null,
      maint: +f.maint.value ? Math.max(1, Math.min(60, +f.maint.value)) : null,
      histo: f.histo.value.trim(), t: f.t.value.trim(), n: f.n.value.trim(), m: f.m.value.trim(),
      stage: f.stage.value.trim(), setting: (f.querySelector('input[name="setting"]:checked') || {}).value || "",
      trial: f.trial.value.trim(), fn: f.fn.value, fnrisk: f.fnrisk.checked, gcsf: f.gcsf.value,
      emeto: f.emeto.value,
      rx: Object.fromEntries([...f.querySelectorAll('#f-rx input[type="checkbox"]')].map((c) => [c.value, c.checked]))
    };
  }

  // ----- Calendrier des cycles -----
  function schedule(c) {
    const ids = new Set(c.drugs.map((d) => d.id));
    const out = [];
    let d1 = c.start, n = 0;
    const end = (months) => addMonths(c.start, months);
    for (const ph of c.p.phases) {
      const len = (ph.cycle_days_options && c.cyclen) || ph.cycle_days;
      const cy = ph.cycles || {};
      let count = cy.fixed || (cy.min ? (c.cycles || cy.default) : cy.open ? (c.maint || cy.default) : 0);
      for (let i = 0; cy.until_months ? d1 < end(cy.until_months) : i < count; i++) {
        const items = ph.items.filter((it) => ids.has(it.drug)
          && (!it.every || i % it.every === 0)
          && (!it.cycles || it.cycles.includes(i + 1)));
        out.push({ n: ++n, phase: ph.name, i: i + 1, d1, len, items });
        d1 = addDays(d1, len);
        if (out.length > 200) break;
      }
    }
    return out;
  }

  // Règle : contrôle hebdomadaire au 1er cycle, puis à J8 des cycles suivants
  function agenda(cycles, drugsById) {
    const rows = [];
    for (const cy of cycles) {
      const map = new Map();
      for (const it of cy.items) for (const d of it.days) {
        if (!map.has(d)) map.set(d, { treat: [], control: false });
        map.get(d).treat.push(drugsById[it.drug].name);
      }
      const controls = cy.n === 1 ? Array.from({ length: Math.floor((cy.len - 1) / 7) }, (_, k) => 8 + 7 * k) : (cy.len >= 8 ? [8] : []);
      for (const d of controls) {
        if (!map.has(d)) map.set(d, { treat: [], control: false });
        map.get(d).control = true;
      }
      for (const [day, e] of [...map.entries()].sort((a, b) => a[0] - b[0])) {
        const date = addDays(cy.d1, day - 1);
        const kind = day === 1 ? "Consultation + traitement" : e.treat.length ? (e.control ? "Traitement + contrôle" : "Traitement") : "Contrôle";
        rows.push({ date, cycle: cy.n, day, kind, what: e.treat.join(", "), weekend: weekend(date) });
      }
    }
    return rows;
  }

  // ----- Liste des spécialités -----
  async function loadSL(substances) {
    if (!state.products) {
      const { data } = await sb.from("sl_products").select("specialty, galenic, substance, atc, limited").range(0, 4999);
      state.products = data || [];
      // Agents ciblés connus (DCI latine et nom de marque) pour repérer les associations hors protocole
      state.agents = new Map();
      for (const p of state.products) {
        if (!/^L01[EFX]/.test(p.atc || "") || /^L01XA/.test(p.atc)) continue; // thérapies ciblées et anticorps ; pas les cytotoxiques ni les platines
        const keys = [norm(p.substance.split(",")[0]).replace(/[^a-z]/g, "").slice(0, 7), norm(p.specialty.split(/[\s-]/)[0])];
        for (const k of keys) if (k.length >= 5) state.agents.set(k, p.substance);
      }
    }
    const missing = substances.filter((s) => !state.sl.has(s));
    if (!missing.length) return;
    const { data: lims } = await sb.from("sl_limitations")
      .select("specialty, substance, galenics, lim_code, ind_code, valid_from, valid_to, body").in("substance", missing).range(0, 1999);
    for (const s of missing) state.sl.set(s, {
      products: state.products.filter((p) => p.substance === s).sort((a, b) => a.specialty.localeCompare(b.specialty) || String(a.galenic).localeCompare(String(b.galenic), "fr", { numeric: true })),
      limits: (lims || []).filter((l) => l.substance === s)
    });
  }

  function defaultProduct(drug, products) {
    if (!products.length) return null;
    const po = /^po/.test(drug.route || "");
    const re = po ? /caps|cpr|compr/i : /perf|inj|subst/i;
    return products.find((p) => re.test(p.galenic || "") && (po || !/caps|cpr|compr/i.test(p.galenic))) || products[0];
  }

  function histoGroup(text) {
    const t = norm(text);
    if (/mesoth/.test(t)) return "meso";
    if (/non a petites|cbnpc|cpnpc|nsclc|non-small|adenocarc|epiderm/.test(t)) return "nsclc";
    if (/petites cellules|cppc|sclc|small cell/.test(t)) return "sclc";
    return null;
  }

  function score(lim, drug, c) {
    const head = norm(lim.body).slice(0, 400);
    const body = norm(lim.body);
    let s = 0;
    const groups = new Set([histoGroup(c.histo), histoGroup(c.p.category)]);
    if ((groups.has("nsclc") && /non a petites cellules|cbnpc|cpnpc/.test(head))
      || (groups.has("sclc") && /petites cellules/.test(head) && !/non a petites/.test(head))
      || (groups.has("meso") && /mesoth/.test(head))) s += 5;
    const own = new Set(c.drugs.map((d) => d.sl).filter(Boolean));
    const foreign = new Set();
    for (const w of head.split(/[^a-z]+/)) {
      if (w.length < 5) continue;
      const sub = state.agents.get(w) || state.agents.get(w.slice(0, 7));
      if (sub && !own.has(sub)) foreign.add(sub);
    }
    s -= 5 * foreign.size; // indication liée à un autre agent : quasi jamais applicable
    for (const other of c.drugs) {
      if (other.id === drug.id || other.kind === "rt") continue;
      if (body.includes(norm(other.name).slice(0, 6))) s += 2;
    }
    if (c.setting === "néoadjuvant" && /neoadjuvant/.test(head)) s += 2;
    if (c.setting === "adjuvant" && /adjuvant/.test(head) && !/neoadjuvant/.test(head)) s += 2;
    if (c.setting === "métastatique") {
      if (/metasta|avance|stade iv/.test(head)) s += 1;
      if (/adjuvant/.test(head)) s -= 2;
    }
    const trial = norm(c.trial || c.p.trial);
    if (trial && body.includes(trial)) s += 3;
    if (/^iv/.test(drug.route || "") && /sous-cutane/.test(head)) s -= 3;
    if (/\.xx/i.test(lim.ind_code || "")) s -= 1;
    return s;
  }

  function slFor(drug, c) {
    const data = state.sl.get(drug.sl) || { products: [], limits: [] };
    const key = c.p.code + "|" + drug.id;
    const ch = state.choice[key] || (state.choice[key] = {});
    let product = data.products.find((p) => p.specialty + "|" + p.galenic === ch.product);
    if (!product) product = defaultProduct(drug, data.products);
    const limits = product
      ? data.limits.filter((l) => l.specialty === product.specialty && (!l.galenics || !product.galenic || l.galenics.split(" ; ").includes(product.galenic)))
          .map((l) => ({ l, s: score(l, drug, c) })).sort((a, b) => b.s - a.s)
      : [];
    let lim = limits.find((x) => x.l.lim_code === ch.lim);
    if (!lim && ch.lim !== "none" && limits.length && limits[0].s >= 5) lim = limits[0];
    return { data, product, limits, lim: lim ? lim.l : null, key };
  }

  // ----- Textes d'ordonnance -----
  function splitGalenic(g) {
    const s = String(g || "");
    const i = s.search(/\d/);
    return i > 0 ? [s.slice(i).trim(), s.slice(0, i).replace(/[,\s]+$/, "").trim()] : [s, ""];
  }

  function rxDrug(drug, product, cycles, phases) {
    const dci = cap(drug.name);
    let head = dci;
    if (product) {
      const [dosage, form] = splitGalenic(product.galenic);
      head = [product.specialty, dosage, form].filter(Boolean).join(" - ") + ` (${dci})`;
    }
    const route = /^po/.test(drug.route || "") ? "po" : "iv";
    const parts = [];
    for (const ph of phases) {
      const cs = cycles.filter((cy) => cy.phase === ph.name && cy.items.some((it) => it.drug === drug.id));
      if (!cs.length) continue;
      const it = cs[0].items.find((x) => x.drug === drug.id);
      const step = (ph.items.find((x) => x.drug === drug.id).every || 1) * cs[0].len;
      const every = step % 7 === 0 ? `toutes les ${step / 7} semaines` : `tous les ${step} jours`;
      const count = ph.cycles.until_months ? `jusqu'à ${ph.cycles.until_months} mois de traitement`
        : ph.cycles.open ? "en maintenance" : `× ${cs.length}`;
      parts.push(`${daysText(it.days)} ${every} ${count}`);
    }
    let s = `S. ${drug.dose} ${route}`;
    if (route === "iv" && /minute/.test(drug.time || "")) s += ` en ${drug.time}`;
    s += ", " + parts.join(", puis ");
    if (route === "po" && drug.time) s += `. ${drug.time}`;
    return [head, s];
  }

  function gcsfDecision(c, chemoDays) {
    if (!chemoDays.length) return { give: false, why: "Pas de chimiothérapie cytotoxique : G-CSF non indiqué." };
    if (c.fn === "high") return { give: true, why: "Risque de NF ≥ 20 % : prophylaxie primaire." };
    if (c.fn === "mid" && c.fnrisk) return { give: true, why: "Risque de NF 10 à 20 % avec facteurs de risque : prophylaxie primaire." };
    if (c.fn === "mid") return { give: false, why: "Risque de NF 10 à 20 % sans facteur de risque : pas de prophylaxie primaire." };
    return { give: false, why: "Risque de NF < 10 % : pas de prophylaxie primaire." };
  }

  // ----- Rendu -----
  function card(id, title, nodes, text) {
    const el = $(id);
    el.replaceChildren(
      h("div", { class: "it-card-head" }, h("h2", {}, title),
        text ? h("button", { class: "btn btn-outline ug-copy", type: "button", onclick: (e) => copy(text, e.currentTarget) }, "Copier") : null),
      ...nodes.flat(Infinity).filter((x) => x != null && x !== false));
  }

  async function copy(text, btn) {
    try { await navigator.clipboard.writeText(text); btn.textContent = "Copié"; }
    catch { btn.textContent = "Copie impossible"; }
    setTimeout(() => (btn.textContent = "Copier"), 1500);
  }

  function table(head, rows, rowClass) {
    return h("div", { class: "it-table-wrap" }, h("table", { class: "it-table" },
      h("thead", {}, h("tr", {}, head.map((x) => h("th", { scope: "col" }, x)))),
      h("tbody", {}, rows.map((r, i) => h("tr", { class: rowClass ? rowClass(i) : null }, r.map((x) => h("td", {}, x)))))));
  }

  function renderSummary(c) {
    const p = c.p;
    const sit = [c.histo, [c.t, c.n, c.m].filter(Boolean).join(" "), c.stage && "stade " + c.stage, c.setting].filter(Boolean).join(", ");
    const rows = [
      ["Protocole", `${p.code} · ${p.title}`],
      ["Catégorie", `${p.clinic_label} · ${p.category}`],
      ["Version du PDF", p.version],
      ["Situation", sit || "—"],
      ["Étude de référence", c.trial || p.trial || "—"],
      ["ECOG (protocole)", p.ecog],
      ["Nombre de cycles (protocole)", p.cycles_text],
      ["Référence", p.reference]
    ];
    for (const v of p.variants || []) rows.splice(2, 0, [v.label, v.options.find((o) => o.id === c.variants[v.id]).label]);
    const text = rows.map((r) => `${r[0]} : ${r[1]}`).join("\n") + (p.notes || []).map((n) => "\n! " + n).join("");
    card("o-summary", "Résumé", [
      h("dl", { class: "ug-dl" }, rows.map((r) => [h("dt", {}, r[0]), h("dd", {}, r[1])])),
      (p.notes || []).map((n) => h("p", { class: "ug-note ug-attn" }, n))
    ], text);
  }

  function renderCycles(c, cycles, byId) {
    const rows = cycles.map((cy) => [`C${cy.n}`, cy.phase, `${wday(cy.d1)}\u00a0${fmt(cy.d1)}`,
      cy.items.map((it) => `${byId[it.drug].name} ${daysText(it.days)}`).join(" · ")]);
    const last = cycles[cycles.length - 1];
    const endNote = last ? `Fin du dernier cycle : ${fmt(addDays(last.d1, last.len - 1))}` : "";
    const text = rows.map((r) => r.join("\t")).join("\n") + "\n" + endNote;
    card("o-cycles", `Calendrier des cycles (${cycles.length})`, [
      table(["Cycle", "Phase", "J1", "Traitement"], rows),
      h("p", { class: "muted it-small" }, endNote)
    ], text);
  }

  function renderAgenda(rows) {
    const t = rows.map((r) => [`${wday(r.date)}\u00a0${fmt(r.date)}`, `C${r.cycle} J${r.day}`, r.kind, r.what]);
    const we = rows.filter((r) => r.weekend);
    const text = t.map((r) => r.filter(Boolean).join("\t")).join("\n");
    card("o-agenda", `Agenda des rendez-vous (${rows.length})`, [
      we.length ? h("p", { class: "ug-note ug-attn" }, `${we.length} rendez-vous tombent un week-end : ${we.map((r) => `C${r.cycle} J${r.day} (${fmt(r.date)})`).join(", ")}.`) : null,
      table(["Date", "Cycle", "Type", "Traitement"], t, (i) => rows[i].weekend ? "it-we" : null),
      h("p", { class: "muted it-small" }, "Règle : contrôle hebdomadaire au 1er cycle, puis à J8 des cycles suivants.")
    ], text);
  }

  function renderSL(c, sls, endDate) {
    const blocks = [], lines = [];
    for (const { drug, sl } of sls) {
      const { data, product, limits, lim, key } = sl;
      const prodSel = data.products.length > 1 ? h("select", {
        class: "it-select", "aria-label": `Spécialité ${drug.name}`,
        onchange: (e) => { state.choice[key] = { product: e.target.value }; render(); }
      }, data.products.map((p) => h("option", { value: p.specialty + "|" + p.galenic, selected: p === product }, `${p.specialty} · ${p.galenic}`))) : null;
      let status;
      if (!product) {
        status = h("p", { class: "ug-note ug-attn" }, "Absent de la Liste des spécialités (substance introuvable).");
        lines.push(`${cap(drug.name)} : absent de la LS`);
      } else if (!limits.length) {
        status = h("p", { class: "ug-note" }, product.limited ? "Limitation signalée mais texte introuvable dans l'onglet Limitations." : "Pas de limitation.");
        lines.push(`${cap(drug.name)} (${product.specialty}) : ${product.limited ? "limitation à vérifier" : "pas de limitation"}`);
      } else {
        const pick = (code) => () => { state.choice[key] = Object.assign(state.choice[key] || {}, { lim: code }); render(); };
        const item = ({ l, s }) => h("div", { class: "it-lim" + (lim === l ? " on" : "") },
          h("label", { class: "it-lim-pick" },
            h("input", { type: "radio", name: "lim-" + key, checked: lim === l, onchange: pick(l.lim_code) }),
            h("span", {}, h("strong", {}, l.ind_code || l.lim_code), " ", l.body.split("\n")[0].replace(l.ind_code || "\u0000", "").trim().slice(0, 140),
              h("span", { class: "it-lim-meta" }, [l.lim_code, l.valid_to ? "jusqu'au " + l.valid_to : null, s > 0 ? "correspondance " + s : null].filter(Boolean).join(" · ")))),
          h("details", {}, h("summary", {}, "Texte de la limitation"), h("p", { class: "it-lim-body" }, l.body)));
        const best = limits.length ? limits[0].s : 0;
        const top = limits.filter((x) => (x.s >= 5 && x.s >= best - 2) || x.l === lim), rest = limits.filter((x) => !top.includes(x));
        const expiry = lim && lim.valid_to && endDate && parseCH(lim.valid_to) < endDate
          ? h("p", { class: "ug-note ug-attn" }, `Limitation admise jusqu'au ${lim.valid_to}, avant la fin prévue du traitement (${fmt(endDate)}) : à revérifier lors du renouvellement de la LS.`) : null;
        status = h("div", { class: "it-lims", role: "radiogroup", "aria-label": `Limitation ${drug.name}` },
          expiry, top.map(item),
          rest.length ? h("details", { class: "it-more" }, h("summary", {}, `Autres indications (${rest.length})`), rest.map(item)) : null,
          h("label", { class: "it-check" }, h("input", { type: "radio", name: "lim-" + key, checked: !lim, onchange: pick("none") }), "Aucune de ces indications"));
        lines.push(`${cap(drug.name)} (${product.specialty}) : ${lim ? `code d'indication ${lim.ind_code} (${lim.lim_code})` : "aucune indication retenue"}`);
      }
      blocks.push(h("div", { class: "it-drug" }, h("h3", {}, cap(drug.name), lim ? h("span", { class: "ug-badge ug-warn" }, lim.ind_code) : null), prodSel, status));
    }
    const missing = !state.slMeta;
    card("o-sl", "Limitations LS (OFSP)", [
      missing ? h("p", { class: "ug-note ug-attn" }, "La Liste des spécialités n'est pas encore importée.") : null,
      blocks,
      state.slMeta ? h("p", { class: "muted it-small" }, `Source : ${state.slMeta.source_file}, importée le ${new Date(state.slMeta.imported_at).toLocaleDateString("fr-CH")}. La correspondance est indicative : vérifiez le texte de la limitation.`) : null
    ], lines.join("\n"));
  }

  function renderRx(c, cycles, sls) {
    const onco = sls.map(({ drug, sl }) => rxDrug(drug, sl.product, cycles, c.p.phases));
    const ontext = ["Rp.", "Traitement oncologique (doses de référence du protocole)", ...onco.flat()].join("\n");
    card("o-rx-onco", "Rp. traitement oncologique", [
      h("pre", { class: "it-rx" }, ontext),
      h("p", { class: "muted it-small" }, "Doses de référence du protocole, sans calcul individuel.")
    ], ontext);

    const chemo = c.drugs.filter((d) => d.kind === "chemo");
    const c1 = cycles[0] ? cycles[0].items.filter((it) => chemo.some((d) => d.id === it.drug)).flatMap((it) => it.days) : [];
    const blocks = [];
    for (const d of c.drugs) if (RX[d.id] && c.rx["cat:" + d.id] !== false) blocks.push(RX[d.id]);
    (c.p.home || []).forEach((b, i) => { if (c.variantOk(b) && c.rx["home:" + i] !== false) blocks.push(b); });
    for (const k of ["antiemetic", "constipation", "diarrhea"]) if (c.rx["cat:" + k]) blocks.push(RX[k]);
    const g = gcsfDecision(c, c1);
    let pegDay = 2;
    while (c1.includes(pegDay)) pegDay++;
    if (g.give) {
      const b = RX[c.gcsf];
      blocks.push({ title: b.title, lines: b.lines.map(([a, s]) => [a, s.replace("{pegDay}", pegDay)]) });
    }
    const text = blocks.length ? ["Rp.", ...blocks.flatMap((b) => [b.title, ...b.lines.flat()]), RENEW].join("\n") : "";
    const later = c1.some((d) => d > pegDay);
    card("o-rx-support", "Rp. ordonnance de support", [
      text ? h("pre", { class: "it-rx" }, text) : h("p", { class: "muted" }, "Aucune ligne sélectionnée."),
      h("p", { class: "ug-note" + (g.give ? "" : " muted") }, "G-CSF : " + g.why),
      g.give && later && c.gcsf === "pegfilgrastim" ? h("p", { class: "ug-note ug-attn" },
        `Chimiothérapie aussi à J${c1.filter((d) => d > pegDay).join(", J")} : le pegfilgrastim ne se donne pas dans les 14 jours précédant une chimiothérapie. Vérifiez le choix du G-CSF.`) : null
    ], text);
  }

  function renderHospital(c) {
    const items = (c.p.hospital || []).filter(c.variantOk);
    const hasAE = items.some((x) => /émèse/i.test(x.text));
    $("f-emeto-wrap").hidden = hasAE;
    const rows = items.map((x) => [x.when, x.text]);
    if (!hasAE) rows.push(["J1", MASCC[c.emeto]]);
    const text = rows.map((r) => `${r[0]} : ${r[1]}`).join("\n");
    card("o-hospital", "Prémédication et antiémèse en hôpital de jour", [
      table(["Quand", "Selon le protocole"], rows),
      h("p", { class: "muted it-small" }, hasAE ? "Repris du PDF du protocole." : "Antiémèse absente du PDF : schéma MASCC/ESMO selon le niveau émétogène choisi.")
    ], text);
  }

  let renderSeq = 0;
  async function render() {
    const c = current();
    const out = $("it-out");
    if (!c) { out.hidden = true; return; }
    out.hidden = false;
    if (!c.start) { $("o-summary").replaceChildren(h("p", { class: "muted" }, "Indiquez la date prévue du 1er traitement.")); return; }
    const seq = ++renderSeq;
    const byId = Object.fromEntries(c.p.drugs.map((d) => [d.id, d]));
    const cycles = schedule(c);
    const sDrugs = c.drugs.filter((d) => d.sl);
    await loadSL([...new Set(sDrugs.map((d) => d.sl))]);
    if (seq !== renderSeq) return; // un rendu plus récent a pris le relais
    const sls = sDrugs.map((drug) => ({ drug, sl: slFor(drug, c) }));
    renderSummary(c);
    renderCycles(c, cycles, byId);
    renderAgenda(agenda(cycles, byId));
    const last = cycles[cycles.length - 1];
    renderSL(c, sls, last ? addDays(last.d1, last.len - 1) : null);
    renderRx(c, cycles, sls);
    renderHospital(c);
  }

  // ----- Formulaire dynamique -----
  function fillClinics() {
    const sel = $("f-clinic");
    const has = new Set(state.protocols.map((p) => p.clinic));
    sel.replaceChildren(...BLOCS.map(([bloc, list]) => h("optgroup", { label: bloc },
      list.map(([id, label]) => h("option", { value: id, disabled: !has.has(id) }, has.has(id) ? label : `${label} (aucun protocole)`)))));
    sel.value = has.has("thoracique") ? "thoracique" : [...has][0] || "";
  }

  function fillProtocols() {
    const list = state.protocols.filter((p) => p.clinic === $("f-clinic").value)
      .sort((a, b) => a.category.localeCompare(b.category) || a.code.localeCompare(b.code));
    const groups = [...new Set(list.map((p) => p.category))];
    $("f-protocol").replaceChildren(...groups.map((g) => h("optgroup", { label: g },
      list.filter((p) => p.category === g).map((p) => h("option", { value: p.code }, `${p.code} · ${p.title}`)))));
    protocolChanged();
  }

  function protocolChanged() {
    const f = form();
    const p = state.protocols.find((x) => x.code === f.protocol.value);
    if (!p) return render();
    $("f-variants").replaceChildren(...(p.variants || []).map((v) => h("div", { class: "it-radios", role: "radiogroup", "aria-label": v.label },
      h("span", { class: "it-legend" }, v.label),
      v.options.map((o) => h("label", {}, h("input", { type: "radio", name: "v-" + v.id, value: o.id, checked: o.id === v.default }), " " + o.label)))));
    const ranged = p.phases.find((ph) => ph.cycles && ph.cycles.min);
    $("f-cycles-wrap").hidden = !ranged;
    if (ranged) {
      const { min, max } = ranged.cycles;
      f.cycles.replaceChildren(...Array.from({ length: max - min + 1 }, (_, i) => h("option", { value: min + i, selected: min + i === ranged.cycles.default }, `${min + i} cycles`)));
    }
    const opt = p.phases.find((ph) => ph.cycle_days_options);
    $("f-cyclen-wrap").hidden = !opt;
    if (opt) f.cyclen.replaceChildren(...opt.cycle_days_options.map((d) => h("option", { value: d, selected: d === opt.cycle_days }, `${d} jours`)));
    const open = p.phases.find((ph) => ph.cycles && ph.cycles.open);
    $("f-maint-wrap").hidden = !open;
    if (open) f.maint.value = open.cycles.default;
    f.trial.value = "";
    f.trial.placeholder = p.trial || "ex. CheckMate 9LA";
    fillRx(p);
    render();
  }

  function fillRx(p) {
    const drugs = new Set(p.drugs.map((d) => d.id));
    const chemo = p.drugs.some((d) => d.kind === "chemo");
    const boxes = [];
    for (const id of ["pemetrexed", "paclitaxel"]) if (drugs.has(id)) boxes.push([`cat:${id}`, RX[id].title, true]);
    (p.home || []).forEach((b, i) => boxes.push([`home:${i}`, b.title + " (protocole)", true]));
    boxes.push(["cat:antiemetic", RX.antiemetic.title, chemo], ["cat:constipation", RX.constipation.title, chemo], ["cat:diarrhea", RX.diarrhea.title, false]);
    $("f-rx").replaceChildren(...boxes.map(([v, label, on]) => h("label", { class: "it-check" }, h("input", { type: "checkbox", value: v, checked: on }), label)));
  }

  // ----- Import (admin) -----
  function loadScript(src) {
    return new Promise((ok, ko) => {
      if (window.ExcelJS) return ok();
      const s = document.createElement("script");
      s.src = src; s.onload = ok; s.onerror = () => ko(new Error("Chargement de la bibliothèque Excel impossible"));
      document.head.append(s);
    });
  }

  function validProtocols(list) {
    if (!Array.isArray(list)) throw new Error("le fichier doit contenir une liste de protocoles");
    for (const p of list) {
      if (!p.code || !p.clinic || !p.title || !Array.isArray(p.drugs) || !Array.isArray(p.phases)) throw new Error(`protocole incomplet : ${p.code || "sans code"}`);
      const ids = new Set(p.drugs.map((d) => d.id));
      for (const ph of p.phases) for (const it of ph.items) if (!ids.has(it.drug)) throw new Error(`${p.code} : médicament inconnu « ${it.drug} »`);
    }
    return list;
  }

  function setupImport() {
    $("it-admin").hidden = false;
    const out = $("it-import-msg");
    const msg = (t, k) => { out.textContent = t; out.className = "form-msg" + (k ? " " + k : ""); };
    const pending = { protocols: null, sl: null };
    const ready = () => ($("it-import").disabled = !(pending.protocols || pending.sl));
    $("it-proto-file").addEventListener("change", async (e) => {
      pending.protocols = null; ready();
      const file = e.target.files[0];
      if (!file) return;
      try {
        pending.protocols = validProtocols(JSON.parse(await file.text()));
        msg(`${pending.protocols.length} protocole(s) lu(s) : ${pending.protocols.map((p) => p.code).join(", ")}.`);
      } catch (err) { msg("Fichier de protocoles illisible : " + err.message, "error"); }
      ready();
    });
    $("it-sl-file").addEventListener("change", async (e) => {
      pending.sl = null; ready();
      const file = e.target.files[0];
      if (!file) return;
      msg("Lecture de la Liste des spécialités…");
      try {
        await loadScript(EXCELJS);
        const wb = new window.ExcelJS.Workbook();
        await wb.xlsx.load(await file.arrayBuffer());
        const res = window.SLParse.parseWorkbook(wb);
        if (!res.products.length) throw new Error("aucun produit oncologique trouvé");
        pending.sl = Object.assign(res, { name: file.name });
        msg(`${res.products.length} produits et ${res.limits.length} limitations (ATC L01, L02, L03AA).`);
      } catch (err) { msg("Liste des spécialités illisible : " + err.message, "error"); }
      ready();
    });
    $("it-import").addEventListener("click", async () => {
      $("it-import").disabled = true;
      msg("Import en cours…");
      const done = [];
      if (pending.protocols) {
        const { data, error } = await sb.rpc("protocols_upsert", { p_items: pending.protocols });
        if (error) { msg("Import des protocoles refusé : " + error.message, "error"); return ready(); }
        done.push(`${data} protocole(s)`);
      }
      if (pending.sl) {
        const { error } = await sb.rpc("sl_replace", { p_products: pending.sl.products, p_limits: pending.sl.limits, p_source: pending.sl.name });
        if (error) { msg("Import de la LS refusé : " + error.message, "error"); return ready(); }
        done.push(`${pending.sl.products.length} produits et ${pending.sl.limits.length} limitations`);
      }
      msg(`Importé : ${done.join(" ; ")}. Rechargement…`, "ok");
      setTimeout(() => location.reload(), 1200);
    });
  }

  // ----- Démarrage -----
  (async () => {
    if (!sb) return ($("it-status").textContent = "Service indisponible.");
    const { data } = await sb.auth.getSession();
    if (!data.session) return (location.href = "/fr/ruche.html");
    $("logout").addEventListener("click", async () => { await sb.auth.signOut(); location.href = "/fr/"; });

    const { data: profile } = await sb.from("profiles").select("role").eq("id", data.session.user.id).single();
    const role = profile ? profile.role : "member";
    if (role === "admin") setupImport();
    if (role !== "admin" && role !== "clinician") {
      $("it-status").textContent = "Cet outil est réservé aux médecins.";
      return;
    }
    const [{ data: rows }, { data: meta }] = await Promise.all([
      sb.from("protocols").select("data").order("code"),
      sb.from("sl_meta").select("source_file, imported_at, product_count, limitation_count").maybeSingle()
    ]);
    state.slMeta = meta;
    if (meta) $("it-source").textContent = `LS : ${meta.source_file}, importée le ${new Date(meta.imported_at).toLocaleDateString("fr-CH")} (${meta.product_count} produits, ${meta.limitation_count} limitations).`;
    state.protocols = (rows || []).map((r) => r.data);
    if (!state.protocols.length) {
      $("it-status").textContent = role === "admin"
        ? "Aucun protocole. Importez le fichier des protocoles ci-dessous."
        : "Les protocoles sont réservés aux médecins du CHUV. Contactez l'administrateur si vous pensez y avoir droit.";
      return;
    }
    $("it-status").hidden = true;
    $("it-tool").hidden = false;
    form().start.value = iso(nextMonday());
    fillClinics();
    fillProtocols();
    $("f-clinic").addEventListener("change", fillProtocols);
    $("f-protocol").addEventListener("change", protocolChanged);
    form().addEventListener("change", (e) => { if (!["clinic", "protocol"].includes(e.target.name)) render(); });
    form().addEventListener("input", (e) => { if (e.target.tagName === "INPUT" && e.target.type !== "radio" && e.target.type !== "checkbox") render(); });
    form().addEventListener("submit", (e) => e.preventDefault());
    $("it-print").addEventListener("click", () => window.print());
  })();
})();
