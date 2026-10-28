// Durée de traitement : recherche dans la copie du fichier Ultragenda (table ug_slots).
// Tout se passe dans le navigateur : les lignes sont chargées une fois, puis filtrées localement.
(function () {
  const cfg = window.ONCONIC_CONFIG || {};
  const sb = window.supabase && cfg.supabaseUrl ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey) : null;
  const EXCELJS = "https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js";
  const MAX_RESULTS = 60;
  const BED_MINUTES = 210; // dès 3h30 : strictement en lit

  const $ = (id) => document.getElementById(id);
  const state = { rows: [], clinic: "", route: "", byCode: new Map() };

  const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9+]+/g, " ").trim();

  function fmt(min) {
    const h = Math.floor(min / 60), m = min % 60;
    if (!h) return `${m} min`;
    return m ? `${h} h ${String(m).padStart(2, "0")}` : `${h} h`;
  }

  // Durée écrite dans l'étiquette UG (« 2h30 », « 3 heures », « 90 minutes »), pour signaler un écart
  function labelMinutes(label) {
    const l = norm(label).replace(/ h /g, "h ");
    let m = l.match(/(\d+)\s*h\s*(\d+)?/);
    if (m) return +m[1] * 60 + (m[2] ? +m[2] : 0);
    m = l.match(/(\d+)\s*heure/);
    if (m) return +m[1] * 60;
    m = l.match(/(\d+)\s*min/);
    return m ? +m[1] : null;
  }

  // Voie déduite du nom, de la note ou de l'étiquette (le fichier n'a pas de colonne dédiée)
  function route(r) {
    const all = norm([r.name, r.note, r.ug_label].join(" "));
    if (/sous cut|\bsc\b/.test(all)) return "SC";
    if (/therapie orale|per os|comprime|\boral/.test(all)) return "Oral";
    if (/\bim\b/.test(norm(r.ug_label))) return "IM";
    if (/intraveine|\biv\b|ttt anti|produit sanguin|perfusion/.test(all)) return "IV";
    return "";
  }

  const MULTI = /\bj\s?([2-9]|[12]\d)\b|jours? d.?affil|\bx\s?\/\s?semaine|suivi de \d+ jours|\bj2\s?-\s?\d/i;
  function frequency(r) {
    const t = norm(r.name + " " + (r.note || "") + " " + (r.synonyms || ""));
    if (/\bq3w\b|aux 3 semaines|3 semaines/.test(t)) return "Cycle toutes les 3 semaines";
    if (/\bq2w\b|aux 2 semaines|2 semaines/.test(t)) return "Cycle toutes les 2 semaines";
    if (/\bq4w\b|aux 4 semaines|4 semaines/.test(t)) return "Cycle toutes les 4 semaines";
    if (/hebdo|weekly/.test(t)) return "Administration hebdomadaire";
    return "";
  }

  function codesOf(r) {
    return (r.codes || "").split(/[,;&\s]+|\bet\b/).map((c) => c.trim().toUpperCase()).filter((c) => /^\d{3,4}[A-Z]$/.test(c));
  }

  function prepare(rows) {
    state.byCode.clear();
    rows.forEach((r) => {
      r._hay = norm([r.name, r.synonyms, r.codes].join(" "));
      r._name = norm(r.name);
      r._words = r._name.split(" ");
      r._hayWords = r._hay.split(" ");
      r._route = route(r);
      r._multi = MULTI.test(r.name + " " + (r.note || ""));
      r._codes = codesOf(r);
      r._codes.forEach((c) => {
        if (!state.byCode.has(c)) state.byCode.set(c, []);
        state.byCode.get(c).push(r);
      });
    });
    state.rows = rows;
  }

  function search() {
    const q = norm($("q").value);
    const tokens = q ? q.split(" ") : [];
    const hits = [];
    for (const r of state.rows) {
      if (state.clinic && r.clinic_sheet !== state.clinic && r.clinic_letter !== null) continue;
      if (state.route && r._route !== state.route) continue;
      if (!tokens.every((t) => r._hay.includes(t))) continue;
      // Mot entier > début de mot > fragment ; le nom compte plus que les synonymes
      let score = 0;
      for (const t of tokens) {
        if (r._words.includes(t)) score += 4;
        else if (r._words.some((w) => w.startsWith(t))) score += 2;
        else if (r._name.includes(t)) score += 1;
        else if (r._hayWords.includes(t)) score += 1;
      }
      if (tokens.length && r._name.startsWith(q)) score += 3;
      if (state.clinic && r.clinic_sheet === state.clinic) score += 1;
      hits.push([score, r]);
    }
    hits.sort((a, b) => b[0] - a[0] || a[1]._name.length - b[1]._name.length || a[1].position - b[1].position);
    render(hits.map((h) => h[1]), tokens.length > 0 || !!state.clinic || !!state.route);
  }

  function el(tag, cls, txt) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }

  function badge(txt, cls) { return el("span", "ug-badge " + (cls || ""), txt); }

  function linked(r) {
    // Créneaux du même plan (même code), dans la même clinique, pour les traitements sur plusieurs jours
    const seen = new Set([r]);
    const out = [];
    r._codes.forEach((c) => (state.byCode.get(c) || []).forEach((o) => {
      if (seen.has(o) || o.clinic_sheet !== r.clinic_sheet) return;
      seen.add(o);
      out.push(o);
    }));
    return out.slice(0, 8);
  }

  function card(r) {
    const d = el("details", "ug-card");
    const s = el("summary");
    const head = el("div", "ug-head");
    head.append(el("span", "ug-name", r.name));
    const meta = el("span", "ug-meta");
    meta.append(badge(r.clinic_letter ? `${r.clinic_letter} · ${r.clinic_name}` : r.clinic_name, "ug-clinic"));
    if (r._route) meta.append(badge(r._route));
    if (r.minutes >= BED_MINUTES) meta.append(badge("Lit", "ug-warn"));
    if (r._multi) meta.append(badge("Plusieurs jours", "ug-warn"));
    head.append(meta);
    s.append(head, el("span", "ug-time", fmt(r.minutes)));
    d.append(s);

    const body = el("div", "ug-body");
    const lab = el("div", "ug-label");
    lab.append(el("span", "muted", "Étiquette UG : "), el("strong", null, r.ug_label || "—"));
    if (r.ug_label) {
      const b = el("button", "btn btn-outline ug-copy", "Copier");
      b.type = "button";
      b.addEventListener("click", async (e) => {
        e.preventDefault();
        try { await navigator.clipboard.writeText(r.ug_label); b.textContent = "Copié"; }
        catch (_) { b.textContent = "Copie impossible"; }
        setTimeout(() => (b.textContent = "Copier"), 1500);
      });
      lab.append(b);
    }
    body.append(lab);
    const lm = labelMinutes(r.ug_label);
    if (lm !== null && lm !== r.minutes) {
      body.append(el("p", "ug-flag", `L'étiquette indique ${fmt(lm)}, le fichier indique ${fmt(r.minutes)}. Durée retenue : ${fmt(r.minutes)}.`));
    }
    if (r.minutes >= BED_MINUTES) body.append(el("p", "ug-flag", "Dès 3 h 30 : strictement en lit."));

    if (r._multi) {
      const m = el("div", "ug-multi");
      m.append(el("strong", null, "Traitement sur plusieurs jours"));
      const f = frequency(r);
      if (f) m.append(el("p", null, f));
      if (r.note) m.append(el("p", null, r.note));
      const others = linked(r);
      const list = el("ul");
      list.append(el("li", null, `${r.name} : ${fmt(r.minutes)}`));
      others.forEach((o) => list.append(el("li", null, `${o.name} : ${fmt(o.minutes)}`)));
      m.append(el("p", "muted", "Durée à réserver pour chaque jour du plan :"), list);
      body.append(m);
    } else if (r.note) {
      body.append(el("p", /attention/i.test(r.note) ? "ug-note ug-attn" : "ug-note", r.note));
    }

    const dl = el("dl", "ug-dl");
    [["Codes du plan", r.codes], ["Synonymes", r.synonyms], ["Onglet", r.clinic_sheet]].forEach(([k, v]) => {
      if (!v) return;
      dl.append(el("dt", null, k), el("dd", null, v));
    });
    body.append(dl);
    d.append(body);
    return d;
  }

  function render(rows, active) {
    const list = $("ug-results");
    list.replaceChildren();
    if (!active) {
      $("ug-count").textContent = "Choisissez une clinique ou tapez un médicament, un nom commercial, un acronyme ou un code de plan.";
      return;
    }
    $("ug-count").textContent = rows.length
      ? `${rows.length} résultat${rows.length > 1 ? "s" : ""}${rows.length > MAX_RESULTS ? ` (${MAX_RESULTS} premiers affichés)` : ""}`
      : "Aucun résultat. Essayez un autre nom, un nom commercial ou le code du plan.";
    rows.slice(0, MAX_RESULTS).forEach((r, i) => {
      const c = card(r);
      if (rows.length === 1 || i === 0 && rows.length <= 3) c.open = true;
      list.append(c);
    });
  }

  function chips(container, items, onPick) {
    container.replaceChildren();
    items.forEach(([value, label], i) => {
      const b = el("button", "ug-chip", label);
      b.type = "button";
      b.setAttribute("aria-pressed", i === 0 ? "true" : "false");
      b.addEventListener("click", () => {
        container.querySelectorAll(".ug-chip").forEach((x) => x.setAttribute("aria-pressed", "false"));
        b.setAttribute("aria-pressed", "true");
        onPick(value);
      });
      container.append(b);
    });
  }

  function setupFilters() {
    const clinics = [];
    const seen = new Set();
    state.rows.forEach((r) => {
      if (r.clinic_letter === null || seen.has(r.clinic_sheet)) return;
      seen.add(r.clinic_sheet);
      clinics.push([r.clinic_sheet, `${r.clinic_name} (${r.clinic_letter})`]);
    });
    chips($("ug-clinics"), [["", "Toutes"]].concat(clinics), (v) => {
      state.clinic = v;
      try { localStorage.setItem("ug-clinic", v); } catch (_) { /* stockage indisponible */ }
      search();
    });
    chips($("ug-routes"), [["", "Toutes voies"], ["IV", "IV"], ["SC", "SC"], ["Oral", "Orale"], ["IM", "IM"]], (v) => {
      state.route = v;
      search();
    });
    let saved = "";
    try { saved = localStorage.getItem("ug-clinic") || ""; } catch (_) { /* stockage indisponible */ }
    if (saved && seen.has(saved)) {
      const btn = [...$("ug-clinics").children].find((b, i) => clinics[i - 1] && clinics[i - 1][0] === saved);
      if (btn) btn.click();
    }
    $("q").addEventListener("input", search);
    search();
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

  function setupImport() {
    $("ug-admin").hidden = false;
    const out = $("ug-import-msg");
    let parsed = null;
    $("ug-file").addEventListener("change", async (e) => {
      const file = e.target.files[0];
      parsed = null;
      $("ug-import").disabled = true;
      if (!file) return;
      out.className = "form-msg";
      out.textContent = "Lecture du fichier…";
      try {
        await loadScript(EXCELJS);
        const wb = new window.ExcelJS.Workbook();
        await wb.xlsx.load(await file.arrayBuffer());
        const res = window.UGParse.parseWorkbook(wb);
        if (!res.rows.length) throw new Error("Aucune ligne trouvée");
        parsed = { rows: res.rows, name: file.name };
        const sheets = new Set(res.rows.map((r) => r.clinic_sheet)).size;
        out.textContent = `${res.rows.length} lignes lues dans ${sheets} onglets.` +
          (res.errors.length ? ` ${res.errors.length} ligne(s) ignorée(s) : ${res.errors.join(" ; ")}` : "");
        $("ug-import").disabled = false;
      } catch (err) {
        out.className = "form-msg error";
        out.textContent = "Fichier illisible : " + err.message;
      }
    });
    $("ug-import").addEventListener("click", async () => {
      if (!parsed) return;
      $("ug-import").disabled = true;
      out.className = "form-msg";
      out.textContent = "Import en cours…";
      const { data, error } = await sb.rpc("ug_replace", { p_rows: parsed.rows, p_source: parsed.name });
      if (error) {
        out.className = "form-msg error";
        out.textContent = "Import refusé : " + error.message;
        $("ug-import").disabled = false;
        return;
      }
      out.className = "form-msg ok";
      out.textContent = `${data} lignes importées. Rechargement…`;
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
      sb.from("ug_slots").select("position, clinic_sheet, clinic_letter, clinic_name, name, codes, synonyms, note, ug_label, minutes").order("position").range(0, 4999),
      sb.from("ug_meta").select("source_file, imported_at, row_count").maybeSingle()
    ]);
    if (error || !rows || !rows.length) {
      $("ug-status").textContent = role === "admin"
        ? "Aucune donnée. Importez le fichier Excel ci-dessous."
        : "Cet outil est réservé aux membres du CHUV. Contactez l'administrateur si vous pensez y avoir droit.";
      return;
    }
    if (meta) {
      const d = new Date(meta.imported_at);
      $("ug-source").textContent = `Source : ${meta.source_file}, importé le ${d.toLocaleDateString("fr-CH")} (${meta.row_count} lignes).`;
    }
    $("ug-status").hidden = true;
    $("ug-tool").hidden = false;
    prepare(rows);
    setupFilters();
    $("q").focus();
  })();
})();
