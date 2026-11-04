// Formation : recueils de présentations (HTML ou PDF) par clinique puis pathologie, recherche en texte intégral.
// Lecture : membres ayant l'outil « formation » (recueils publiés) ; dépôt et gestion : admin. Fichiers dans le bucket privé « formation ».
// Un recueil HTML s'affiche dans un cadre isolé (app/formation-viewer.html, sandbox sans accès à la session ni au réseau).
(function () {
  const cfg = window.ONCONIC_CONFIG || {};
  const sb = window.supabase && cfg.supabaseUrl ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey) : null;
  const BUCKET = "formation";
  const PDFJS = "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js";
  const PDFJS_WORKER = "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js";
  const MAX_HTML = 15 * 1024 * 1024;
  const CLINICS = ["Sénologie", "Gynécologie", "Urologie", "Thoracique", "Neuro-oncologie", "Mélanome", "Lower GI", "Upper GI", "ORL", "Sarcomes", "Radiologie interventionnelle"];
  const LEVELS = { tous: "Tous niveaux", residents: "Résidents", cadres: "Cadres" };
  const COLS = "id, title, clinic, pathology, tags, level, author, summary, kind, file_path, file_size, source_path, status, created_at, updated_at";

  const $ = (id) => document.getElementById(id);
  const state = { rows: [], admin: false, me: "", q: "", clinic: "", hits: null, editing: null, current: null, blobUrl: null };

  const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9+]+/g, " ").trim();
  function el(tag, cls, txt) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }
  const badge = (txt, cls) => el("span", "ug-badge " + (cls || ""), txt);
  function button(label, cls, onClick) { const b = el("button", cls, label); b.type = "button"; b.addEventListener("click", onClick); return b; }
  const fmtDate = (ts) => new Date(ts).toLocaleDateString("fr-CH");
  const mb = (n) => (n / 1048576).toFixed(1).replace(".", ",") + " Mo";

  // ----- Données -----
  async function load() {
    const { data, error } = await sb.from("trainings").select(COLS).order("title").range(0, 999);
    if (error) throw error;
    state.rows = data || [];
    const paths = [...new Set(state.rows.map((r) => r.pathology))].sort((a, b) => a.localeCompare(b, "fr"));
    $("fm-paths").replaceChildren(...paths.map((p) => { const o = el("option"); o.value = p; return o; }));
  }

  // ----- Recherche -----
  async function search() {
    const terms = norm(state.q).split(" ").filter(Boolean);
    state.hits = null;
    if (terms.length) {
      const { data, error } = await sb.rpc("trainings_search", { p_terms: terms });
      if (error) { $("ug-count").textContent = "Recherche impossible : " + error.message; return; }
      state.hits = new Map((data || []).map((h) => [h.id, h]));
    }
    render();
  }

  // ----- Affichage : arbre clinique > pathologie > recueil, ou liste de résultats -----
  function render() {
    const rows = state.rows.filter((r) => (!state.clinic || r.clinic === state.clinic) && (!state.hits || state.hits.has(r.id)));
    $("ug-count").textContent = `${rows.length} recueil${rows.length > 1 ? "s" : ""}` + (rows.length !== state.rows.length ? ` sur ${state.rows.length}` : "");
    const box = $("fm-tree");
    box.replaceChildren();
    if (!rows.length) {
      box.append(el("p", "muted", state.rows.length ? "Aucun recueil ne correspond à cette recherche." : "Aucun recueil pour l'instant."));
      return;
    }
    if (state.hits) {
      const ordered = [...rows].sort((a, b) => Number(state.hits.get(b.id).in_title) - Number(state.hits.get(a.id).in_title) || a.title.localeCompare(b.title, "fr"));
      ordered.forEach((r) => box.append(row(r, state.hits.get(r.id), true)));
      return;
    }
    const open = state.rows.length <= 12 || !!state.clinic;
    for (const clinic of CLINICS) {
      const inClinic = rows.filter((r) => r.clinic === clinic);
      if (!inClinic.length) continue;
      const d = el("details", "fm-clinic-group");
      d.open = open;
      d.append(el("summary", null, `${clinic} (${inClinic.length})`));
      const paths = [...new Set(inClinic.map((r) => r.pathology))].sort((a, b) => a.localeCompare(b, "fr"));
      for (const p of paths) {
        d.append(el("h3", "fm-path", p));
        inClinic.filter((r) => r.pathology === p).forEach((r) => d.append(row(r)));
      }
      box.append(d);
    }
  }

  function row(r, hit, withPath) {
    const c = el("div", "fm-row");
    const main = el("div", "fm-row-main");
    const t = button(r.title, "fm-title", () => openDeck(r, hit && hit.slide ? hit.slide : null));
    main.append(t);
    if (withPath) main.append(el("span", "muted fm-where", `${r.clinic} › ${r.pathology}`));
    if (hit && hit.slide) main.append(el("span", "fm-slide", `${r.kind === "pdf" ? "Page" : "Diapositive"} ${hit.slide}${hit.slide_title ? " : " + hit.slide_title : ""}`));
    if (r.summary) main.append(el("span", "muted fm-sum", r.summary));
    c.append(main);
    const meta = el("div", "ug-meta");
    meta.append(badge(r.kind === "pdf" ? "PDF" : "Diaporama"), badge(LEVELS[r.level]));
    if (r.status === "draft") meta.append(badge("Brouillon", "ug-warn"));
    (r.tags || []).slice(0, 4).forEach((x) => meta.append(badge(x, "lt-marker")));
    c.append(meta);
    c.append(el("span", "muted fm-date", "Mis à jour le " + fmtDate(r.updated_at)));
    if (state.admin) {
      const tools = el("div", "fm-tools");
      tools.append(button("Modifier", "an-mini", () => openForm(r)), button("Supprimer", "an-mini lt-danger", () => remove(r)));
      c.append(tools);
    }
    return c;
  }

  // ----- Lecture -----
  function setReaderMsg(t, kind) { const m = $("fm-reader-msg"); m.className = "form-msg" + (kind ? " " + kind : ""); m.textContent = t || ""; }
  function closeDeck() {
    $("fm-frame").removeAttribute("src");
    if (state.blobUrl) { URL.revokeObjectURL(state.blobUrl); state.blobUrl = null; }
    state.current = null;
    $("fm-reader").hidden = true;
    $("fm-list-view").hidden = false;
    history.replaceState(null, "", location.pathname);
  }
  async function openDeck(r, slide) {
    state.current = r;
    $("fm-list-view").hidden = true;
    $("fm-reader").hidden = false;
    $("fm-reader-title").textContent = r.title;
    $("fm-open").hidden = true; $("fm-source").hidden = true;
    setReaderMsg("Chargement…");
    window.scrollTo(0, 0);
    history.replaceState(null, "", `?d=${r.id}` + (slide ? `&s=${slide}` : ""));
    const { data, error } = await sb.storage.from(BUCKET).download(r.file_path);
    if (error || !data) return setReaderMsg("Fichier indisponible : " + ((error && error.message) || "introuvable"), "error");
    const frame = $("fm-frame");
    if (r.kind === "pdf") {
      frame.removeAttribute("sandbox");
      state.blobUrl = URL.createObjectURL(new Blob([data], { type: "application/pdf" }));
      frame.src = state.blobUrl + (slide ? `#page=${slide}` : "");
      const a = $("fm-open");
      a.href = state.blobUrl + (slide ? `#page=${slide}` : ""); a.hidden = false;
      setReaderMsg("");
    } else {
      const html = await data.text();
      frame.setAttribute("sandbox", "allow-scripts");
      const onMsg = (e) => {
        if (e.source !== frame.contentWindow || !e.data || e.data.type !== "ready") return;
        window.removeEventListener("message", onMsg);
        frame.contentWindow.postMessage({ type: "load", html, slide: slide || 0 }, "*");
        setReaderMsg("");
      };
      window.addEventListener("message", onMsg);
      frame.src = "/app/formation-viewer.html";
    }
    if (r.source_path) {
      const { data: signed } = await sb.storage.from(BUCKET).createSignedUrl(r.source_path, 3600, { download: true });
      if (signed && signed.signedUrl) { const a = $("fm-source"); a.href = signed.signedUrl; a.hidden = false; }
    }
  }

  // ----- Dépôt et gestion (admin) -----
  const hasExternal = (html) => /(<script[^>]+src=["']?https?:|<link[^>]+href=["']?https?:|<img[^>]+src=["']?https?:|@import\s+url\(["']?https?:)/i.test(html);
  function extractHtml(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc.querySelectorAll("script, style, noscript").forEach((n) => n.remove());
    doc.body.querySelectorAll("*").forEach((e) => e.append(" ")); // sépare les mots entre éléments voisins (li, td…)
    const nodes = [...doc.querySelectorAll("section.slide, .slide")];
    const slides = (nodes.length ? nodes : [doc.body]).map((n, i) => {
      const title = n.getAttribute("data-title") || (n.querySelector("h1, h2, h3") || {}).textContent || "";
      return { n: i + 1, t: title.trim().slice(0, 120), x: norm(n.textContent).slice(0, 4000) };
    });
    return { slides, text: (doc.body.textContent || "").replace(/\s+/g, " ").trim().slice(0, 4000) };
  }
  function loadScript(src, global) {
    return new Promise((ok, ko) => {
      if (window[global]) return ok();
      const s = document.createElement("script");
      s.src = src; s.onload = ok; s.onerror = () => ko(new Error("chargement de pdf.js impossible"));
      document.head.append(s);
    });
  }
  async function extractPdf(file) {
    await loadScript(PDFJS, "pdfjsLib");
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
    const pdf = await window.pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    const slides = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      const raw = content.items.map((i) => i.str).join(" ").replace(/\s+/g, " ").trim();
      slides.push({ n: p, t: raw.slice(0, 80), x: norm(raw).slice(0, 4000) });
    }
    return { slides, text: slides.map((s) => s.t).join(" ") };
  }

  function openForm(r) {
    state.editing = r || null;
    const f = $("fm-form");
    f.reset();
    $("fm-form-title").textContent = r ? "Modifier le recueil" : "Déposer un recueil";
    $("fm-form-msg").textContent = ""; $("fm-form-msg").className = "form-msg";
    $("fm-file-hint").textContent = r ? "(laisser vide pour conserver le fichier actuel)" : "";
    if (r) {
      f.elements.title.value = r.title; f.elements.clinic.value = r.clinic; f.elements.pathology.value = r.pathology;
      f.elements.tags.value = (r.tags || []).join(", "); f.elements.level.value = r.level;
      f.elements.author.value = r.author || ""; f.elements.summary.value = r.summary || "";
      f.elements.published.checked = r.status === "published"; f.elements.nopatient.checked = true;
      $("fm-text").value = "";
    } else {
      f.elements.author.value = state.me;
    }
    $("fm-dialog").showModal();
    f.elements.title.focus();
  }

  async function save(e) {
    e.preventDefault();
    const f = $("fm-form");
    const msg = $("fm-form-msg");
    const err = (t) => { msg.className = "form-msg error"; msg.textContent = t; };
    const v = (k) => f.elements[k].value.trim();
    if (v("title").length < 3) return err("Le titre est obligatoire.");
    if (!v("clinic")) return err("Choisissez une clinique.");
    if (v("pathology").length < 2) return err("La pathologie est obligatoire.");
    if (!f.elements.nopatient.checked) return err("Confirmez l'absence de donnée de patient identifiable.");
    const file = f.elements.file.files[0];
    const source = f.elements.source.files[0];
    if (!state.editing && !file) return err("Choisissez un fichier HTML ou PDF.");
    msg.className = "form-msg"; msg.textContent = "Préparation…";
    const rec = {
      title: v("title"), clinic: v("clinic"), pathology: v("pathology"), level: v("level"), author: v("author") || null, summary: v("summary") || null,
      tags: v("tags").split(",").map((t) => t.trim()).filter(Boolean), status: f.elements.published.checked ? "published" : "draft"
    };
    let extra = v("text");
    const uploaded = [];
    try {
      if (file) {
        const isPdf = /\.pdf$/i.test(file.name);
        if (!isPdf && !/\.html?$/i.test(file.name)) return err("Le fichier doit être un HTML ou un PDF.");
        rec.kind = isPdf ? "pdf" : "html";
        let ex;
        if (isPdf) {
          msg.textContent = "Extraction du texte du PDF…";
          try { ex = await extractPdf(file); } catch (x) { ex = { slides: [], text: "" }; msg.textContent = "Texte du PDF non extrait (" + x.message + ") : la recherche s'appuiera sur le titre, les mots-clés et le texte saisi."; }
        } else {
          if (file.size > MAX_HTML) return err("Fichier HTML trop lourd (max. 15 Mo) : compressez les images.");
          const html = await file.text();
          if (hasExternal(html) && !confirm("Ce fichier appelle des ressources externes (scripts, images ou styles en ligne). Elles ne s'afficheront pas. Intégrez-les au fichier. Déposer quand même ?")) { msg.textContent = ""; return; }
          ex = extractHtml(html);
        }
        rec.slides = ex.slides;
        extra = extra || ex.text;
        rec.file_size = file.size;
        rec.file_path = `${norm(rec.clinic).replace(/ /g, "-")}/${crypto.randomUUID()}.${isPdf ? "pdf" : "html"}`;
        msg.textContent = "Envoi du fichier…";
        const up = await sb.storage.from(BUCKET).upload(rec.file_path, file, { contentType: isPdf ? "application/pdf" : "text/html", upsert: false });
        if (up.error) return err("Envoi refusé : " + up.error.message);
        uploaded.push(rec.file_path);
      }
      if (source) {
        rec.source_path = `${norm(rec.clinic).replace(/ /g, "-")}/${crypto.randomUUID()}.pptx`;
        const up = await sb.storage.from(BUCKET).upload(rec.source_path, source, { contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", upsert: false });
        if (up.error) return err("Envoi du fichier source refusé : " + up.error.message);
        uploaded.push(rec.source_path);
      }
      const slidesText = (rec.slides || (state.editing ? [] : [])).map((s) => s.x).join(" ");
      rec.title_norm = norm(rec.title + " " + rec.pathology);
      rec.search_norm = norm([rec.title, rec.pathology, rec.tags.join(" "), rec.summary, extra].join(" ")) + " " + slidesText;
      rec.search_norm = rec.search_norm.slice(0, 400000);
      msg.textContent = "Enregistrement…";
      let res;
      if (state.editing) {
        if (!file) {
          // Sans nouveau fichier : conserver diapositives et texte existants
          const { data: old } = await sb.from("trainings").select("slides, search_norm").eq("id", state.editing.id).single();
          rec.slides = old ? old.slides : [];
          rec.search_norm = norm([rec.title, rec.pathology, rec.tags.join(" "), rec.summary, extra].join(" ")) + " " + (rec.slides || []).map((s) => s.x).join(" ");
        }
        res = await sb.from("trainings").update(rec).eq("id", state.editing.id).select("id").single();
      } else {
        res = await sb.from("trainings").insert(rec).select("id").single();
      }
      if (res.error) { await sb.storage.from(BUCKET).remove(uploaded); return err("Refusé : " + res.error.message); }
      // Ancien fichier remplacé : suppression
      if (state.editing) {
        const old = [];
        if (file) old.push(state.editing.file_path);
        if (source && state.editing.source_path) old.push(state.editing.source_path);
        if (old.length) await sb.storage.from(BUCKET).remove(old);
      }
      $("fm-dialog").close();
      await refresh();
    } catch (x) {
      await sb.storage.from(BUCKET).remove(uploaded);
      err("Échec : " + x.message);
    }
  }

  async function remove(r) {
    if (!confirm(`Supprimer le recueil « ${r.title} » ?`)) return;
    const { error } = await sb.from("trainings").delete().eq("id", r.id);
    if (error) return alert("Suppression refusée : " + error.message);
    await sb.storage.from(BUCKET).remove([r.file_path].concat(r.source_path ? [r.source_path] : []));
    await refresh();
  }

  async function refresh() { await load(); await search(); }

  // ----- Démarrage -----
  (async () => {
    if (!sb) return ($("ug-status").textContent = "Service indisponible.");
    const { data } = await sb.auth.getSession();
    if (!data.session) return (location.href = "/fr/the-hive.html");
    $("logout").addEventListener("click", async () => { await sb.auth.signOut(); location.href = "/fr/"; });
    const { data: profile } = await sb.from("profiles").select("role, first_name, last_name, full_name").eq("id", data.session.user.id).single();
    const role = profile ? profile.role : "member";
    const { data: canUse } = await sb.rpc("has_tool", { p_tool: "formation" });
    if (role !== "admin" && canUse !== true) return ($("ug-status").textContent = "Cet outil ne fait pas partie de vos accès. Contactez l'administrateur si besoin.");
    state.admin = role === "admin";
    state.me = [profile.first_name, profile.last_name].filter(Boolean).join(" ") || profile.full_name || "";
    try { await load(); } catch (e) { return ($("ug-status").textContent = "Chargement impossible : " + e.message); }
    $("ug-status").hidden = true;
    $("fm-list-view").hidden = false;
    const all = el("option", null, "Toutes les cliniques"); all.value = "";
    $("fm-clinic").replaceChildren(all, ...CLINICS.map((c) => { const o = el("option", null, c); o.value = c; return o; }));
    const pick = el("option", null, "Choisir"); pick.value = "";
    $("fm-f-clinic").replaceChildren(pick, ...CLINICS.map((c) => { const o = el("option", null, c); o.value = c; return o; }));
    $("q").addEventListener("input", (e) => { state.q = e.target.value; clearTimeout(state.t); state.t = setTimeout(search, 250); });
    $("fm-clinic").addEventListener("change", (e) => { state.clinic = e.target.value; render(); });
    $("fm-back").addEventListener("click", closeDeck);
    $("fm-full").addEventListener("click", () => { const f = $("fm-frame"); (f.requestFullscreen || f.webkitRequestFullscreen || function () {}).call(f); });
    if (state.admin) {
      $("fm-new").hidden = false;
      $("fm-new").addEventListener("click", () => openForm(null));
      $("fm-form").addEventListener("submit", save);
      $("fm-cancel").addEventListener("click", () => $("fm-dialog").close());
    }
    render();
    const qs = new URLSearchParams(location.search);
    const id = +qs.get("d");
    if (id) { const r = state.rows.find((x) => x.id === id); if (r) openDeck(r, +qs.get("s") || null); }
  })();
})();
