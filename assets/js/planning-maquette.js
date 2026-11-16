// Maquette du planning administratif : données fictives, tout reste dans le navigateur (aucun appel au serveur).
(function () {
  const $ = (id) => document.getElementById(id);
  const EXCELJS = "https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js";
  const STORE = "onconic-planning-maquette-v2";

  // ----- Catalogue des codes (repris de la légende du tableur) -----
  const P1 = "#FF99FF", P2 = "#21C5FF", P3 = "#FFC000";
  const CODES = [
    ["Assistante médecins", "AM1", "Assistante médecins, bloc 1", P1], ["Assistante médecins", "AM2", "Assistante médecins, bloc 2", P2], ["Assistante médecins", "AM3", "Assistante médecins, bloc 3", P3],
    ["Secrétariat", "SEC1", "Secrétariat, bloc 1", P1], ["Secrétariat", "SEC2", "Secrétariat, bloc 2", P2], ["Secrétariat", "SEC3", "Secrétariat, bloc 3", P3], ["Secrétariat", "SEC0", "Secrétariat, attribué selon les besoins", "#FFFFFF"],
    ["Soutien administratif", "SA1", "Soutien administratif, bloc 1", P1], ["Soutien administratif", "SA2", "Soutien administratif, bloc 2", P2], ["Soutien administratif", "SA3", "Soutien administratif, bloc 3", P3], ["Soutien administratif", "SA0", "Soutien administratif, attribué selon les besoins", "#FFFFFF"],
    ["Télétravail", "TT1", "Télétravail, bloc 1", P1], ["Télétravail", "TT2", "Télétravail, bloc 2", P2], ["Télétravail", "TT3", "Télétravail, bloc 3", P3],
    ["Desk et accueil", "DA1", "Desk accueil 7h30-16h30", "#FFFF00"], ["Desk et accueil", "DA2", "Desk accueil 8h00-17h00", "#FFFF00"], ["Desk et accueil", "UTI", "Accueil UTI", "#92D050"],
    ["Back office", "BO1", "Back office 7h30-16h30, référent BO et desk", "#002060", "#FFFFFF"], ["Back office", "BO2", "Back office 8h00-17h00", "#0066FF", "#FFFFFF"],
    ["Back office", "BO3", "Back office 8h00-17h00", "#0066FF", "#FFFFFF"], ["Back office", "BO4", "Back office 7h30-16h30", "#0066FF", "#FFFFFF"], ["Back office", "BOD", "Préparation de dossiers, archivage", "#0066FF", "#FFFFFF"],
    ["Encadrement", "CU", "Cheffe d'unité", "#CC99FF"], ["Encadrement", "AD", "Administration", "#CC0099", "#FFFFFF"], ["Encadrement", "TTC", "Télétravail (encadrement)", "#CC0099", "#FFFFFF"], ["Encadrement", "INT", "Intégratrice", "#E2EFDA"],
    ["Absences", "V", "Vacances", "#FF0000", "#FFFFFF", "abs"], ["Absences", "ML", "Maladie ou accident", "#FF7C80", null, "priv"], ["Absences", "CA", "Congé autre type", "#C00000", "#FFFFFF", "priv"],
    ["Absences", "FOR", "Formation", "#CCFF99", null, "abs"], ["Absences", "MIL", "Service militaire", "#BFBFBF", null, "priv"]
  ].map(([group, code, label, bg, fg, kind]) => ({ group, code, label, bg, fg: fg || "#000000", abs: !!kind, priv: kind === "priv" }));
  const BY = Object.fromEntries(CODES.map((c) => [c.code, c]));
  const MASK = { code: "ABS", label: "Absent·e", bg: "#D9D9D9", fg: "#333333" };
  const GREY = "#D9D9D9";

  // ----- Collaborateurs fictifs -----
  // off : demi-journées libres de la semaine (0 = lundi matin … 9 = vendredi après-midi)
  const TEAMS = { AM: "Assistantes médecins", SEC: "Secrétariat", DESK: "Desk et back office", ENCAD: "Encadrement" };
  const R1 = "S. Muller", R2 = "N. Favre";
  const SEED_PEOPLE = [
    ["p1", "Léa", "Rochat", "AM", 1, 100, [], R1], ["p2", "Camille", "Dupuis", "AM", 1, 80, [4, 5], R1], ["p3", "Inès", "Monnier", "AM", 1, 60, [0, 1, 8, 9], R1],
    ["p4", "Sofia", "Ferreira", "AM", 2, 100, [], R1], ["p5", "Julie", "Perret", "AM", 2, 80, [8, 9], R1], ["p6", "Aline", "Chappuis", "AM", 2, 100, [], R1],
    ["p7", "Mélanie", "Jaquet", "AM", 3, 100, [], R1], ["p8", "Sara", "Bianchi", "AM", 3, 60, [2, 3, 4, 5], R1], ["p9", "Laura", "Vonlanthen", "AM", 3, 80, [0, 1], R1],
    ["p10", "Chloé", "Berthoud", "SEC", 1, 100, [], R1], ["p11", "Nathalie", "Rey", "SEC", 2, 80, [4, 5], R1], ["p12", "Elodie", "Cuendet", "SEC", 3, 100, [], R1],
    ["p13", "Patricia", "Golay", "SEC", 1, 50, [0, 1, 2, 3, 4], R1], ["p14", "Fatima", "Benali", "SEC", 2, 100, [], R1], ["p15", "Céline", "Junod", "SEC", 3, 80, [8, 9], R1],
    ["p16", "Valérie", "Pittet", "SEC", 0, 60, [0, 1, 2, 3], R1],
    ["p17", "Kevin", "Martins", "DESK", null, 100, [], R2], ["p18", "Rita", "Costa", "DESK", null, 100, [], R2], ["p19", "Yasmine", "Haddad", "DESK", null, 80, [4, 5], R2],
    ["p20", "Marc", "Dubois", "DESK", null, 100, [], R2], ["p21", "Lucie", "Thévoz", "DESK", null, 100, [], R2], ["p22", "Eva", "Morand", "DESK", null, 80, [8, 9], R2],
    ["p23", "Jonas", "Keller", "DESK", null, 100, [], R2],
    ["p24", "Sandrine", "Muller", "ENCAD", null, 100, [], R1], ["p25", "Nadia", "Favre", "ENCAD", null, 90, [9], R2], ["p26", "Carole", "Mettraux", "ENCAD", null, 80, [8, 9], R2]
  ].map(([id, first, last, team, bloc, pct, off, resp]) => ({ id, first, last, name: first + " " + last, team, bloc, pct, off, resp }));
  const ME = "p1";
  const DESK_ROT = ["DA1", "DA2", "BO1", "BO2", "BO3", "BO4", "BOD"];

  // ----- Dates -----
  const pad = (n) => String(n).padStart(2, "0");
  const iso = (d) => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  const parse = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const monday = (d) => addDays(d, -((d.getDay() + 6) % 7));
  const fmtS = (s) => (s ? s.slice(8, 10) + "." + s.slice(5, 7) + "." + s.slice(0, 4) : "…");
  const fmt = (d) => pad(d.getDate()) + "." + pad(d.getMonth() + 1) + "." + d.getFullYear();
  const DOW = ["di", "lu", "ma", "me", "je", "ve", "sa"];
  const MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
  // Jours fériés vaudois 2026-2027 (dans l'outil réel : agenda commun déjà utilisé par Absences)
  const HOLIDAYS = {
    "2026-01-01": "Nouvel An", "2026-01-02": "Saint-Berthold", "2026-04-03": "Vendredi saint", "2026-04-06": "Lundi de Pâques", "2026-05-14": "Ascension",
    "2026-05-25": "Lundi de Pentecôte", "2026-09-21": "Lundi du Jeûne", "2026-12-25": "Noël",
    "2027-01-01": "Nouvel An", "2027-03-26": "Vendredi saint", "2027-03-29": "Lundi de Pâques", "2027-05-06": "Ascension", "2027-05-17": "Lundi de Pentecôte", "2027-09-20": "Lundi du Jeûne"
  };
  const workdays = (from, to) => { const out = []; for (let d = new Date(from); d <= to; d = addDays(d, 1)) if (d.getDay() % 6) out.push(new Date(d)); return out; };
  const slot = (d, h) => (d.getDay() - 1) * 2 + h;
  const isOff = (p, d, h) => p.off.includes(slot(d, h));
  // Mission (temporaires) ou dates d'entrée et de départ : hors de cette période, la ligne est hachurée et ne se remplit pas
  const inMission = (p, d) => (!p.from || iso(d) >= p.from) && (!p.to || iso(d) <= p.to);
  const DATA_FROM = new Date(2026, 10, 2), DATA_TO = new Date(2027, 0, 29);

  // ----- Semaine type et données de départ -----
  function defaultWeek(p, i) {
    const w = Array(10).fill("");
    for (let s = 0; s < 10; s++) {
      if (p.off.includes(s)) continue;
      if (p.team === "AM") w[s] = s === 7 && p.pct === 100 ? "TT" + p.bloc : "AM" + p.bloc;
      else if (p.team === "SEC") w[s] = p.bloc ? (s === 3 ? "TT" + p.bloc : "SEC" + p.bloc) : "SEC0";
      else if (p.team === "DESK") w[s] = DESK_ROT[i % DESK_ROT.length];
      else w[s] = p.id === "p26" ? (s === 2 || s === 3 ? "TTC" : "AD") : "CU";
    }
    return w;
  }
  function seed() {
    const plan = {}, weeks = {};
    const people = SEED_PEOPLE.map((p) => Object.assign({}, p, { status: "fixe", from: null, to: null, account: "compte" }));
    people.push({ id: "p27", first: "Noah", last: "Girardet", name: "Noah Girardet", team: "DESK", bloc: null, pct: 100, off: [], resp: R2,
      status: "temporaire", from: "2026-11-23", to: "2026-12-18", account: "generique" });
    people.forEach((p, i) => { weeks[p.id] = defaultWeek(p, i); plan[p.id] = {}; });
    for (const d of workdays(DATA_FROM, DATA_TO)) {
      if (HOLIDAYS[iso(d)]) continue;
      const wk = Math.floor((d - monday(DATA_FROM)) / 6048e5);
      people.forEach((p, i) => {
        for (const h of [0, 1]) {
          if (isOff(p, d, h) || !inMission(p, d)) continue;
          let c = weeks[p.id][slot(d, h)];
          if (p.team === "DESK") c = DESK_ROT[(i + wk) % DESK_ROT.length];
          if (c) plan[p.id][iso(d) + "|" + h] = c;
        }
      });
    }
    const span = (pid, a, b, code) => { for (const d of workdays(parse(a), parse(b))) if (!HOLIDAYS[iso(d)]) for (const h of [0, 1]) plan[pid][iso(d) + "|" + h] = code; };
    span("p4", "2026-11-23", "2026-11-27", "V"); span("p11", "2026-11-18", "2026-11-20", "ML"); span("p20", "2026-11-26", "2026-11-26", "FOR");
    span("p7", "2026-12-21", "2027-01-08", "V"); span("p14", "2026-12-28", "2027-01-08", "V"); span("p18", "2026-12-21", "2026-12-31", "V");
    span("p2", "2026-12-07", "2026-12-11", "MIL"); span("p12", "2026-12-14", "2026-12-15", "CA"); span("p1", "2026-12-28", "2026-12-31", "V");
    span("p21", "2027-01-11", "2027-01-15", "V"); span("p9", "2026-11-30", "2026-11-30", "FOR");
    return { people, plan, weeks, mins: { AM1: 2, AM2: 2, AM3: 2, SEC: 4, DA: 2, BO: 3 } };
  }
  let db;
  try { db = JSON.parse(localStorage.getItem(STORE)) || seed(); } catch (e) { db = seed(); }
  const save = () => { try { localStorage.setItem(STORE, JSON.stringify(db)); } catch (e) { /* stockage indisponible : la maquette fonctionne sans */ } };

  // ----- État de la vue -----
  const st = { view: "cadre", span: 10, winLen: 42, start: monday(new Date(2026, 10, 16)), tool: "AM1", anchor: null, undo: [], painting: null, onlyMe: false };
  const COVER = [["AM1", "AM bloc 1", (c) => c === "AM1"], ["AM2", "AM bloc 2", (c) => c === "AM2"], ["AM3", "AM bloc 3", (c) => c === "AM3"],
    ["SEC", "Secrétariat", (c) => /^SEC/.test(c)], ["DA", "Desk accueil", (c) => /^DA/.test(c)], ["BO", "Back office", (c) => /^BO/.test(c)]];

  function days() {
    if (st.span === "month") {
      const a = new Date(st.start.getFullYear(), st.start.getMonth(), 1), b = new Date(st.start.getFullYear(), st.start.getMonth() + 1, 0);
      return workdays(a, b);
    }
    if (st.span === "window") return workdays(st.start, addDays(st.start, st.winLen - 1));
    return workdays(st.start, addDays(st.start, st.span === 5 ? 4 : 11));
  }
  function visiblePeople() {
    const team = $("pl-team").value, q = $("pl-q").value.trim().toLowerCase();
    const ds = days(), a = iso(ds[0]), b = iso(ds[ds.length - 1]);
    return db.people.filter((p) => (!team || p.team === team) && (!q || p.name.toLowerCase().includes(q)) && (!(st.view === "lecture" && st.onlyMe) || p.id === ME)
      && (!p.from || p.from <= b) && (!p.to || p.to >= a));
  }
  const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  function shown(p, code) {
    if (!code) return null;
    const c = BY[code] || { code, label: code, bg: "#FFFFFF", fg: "#000000" };
    // Motif des absences sensibles (maladie, congé, militaire) : visible des seuls cadres admin et de la personne elle-même
    return st.view !== "cadre" && c.priv && !(st.view === "lecture" && p.id === ME) ? MASK : c;
  }
  function paintCell(td, p, d, h) {
    const k = iso(d) + "|" + h, code = db.plan[p.id][k], c = shown(p, code);
    const hol = HOLIDAYS[iso(d)], off = isOff(p, d, h), out = !inMission(p, d);
    td.classList.toggle("pl-out", out && !c);
    td.textContent = c ? c.code : "";
    td.style.background = c ? c.bg : out ? "" : hol || off ? GREY : "";
    td.style.color = c ? c.fg : "";
    td.title = p.name + " · " + DOW[d.getDay()] + " " + fmt(d) + (h ? " après-midi" : " matin") + (c ? " · " + c.label : out ? " · hors période de mission" : hol ? " · " + hol : off ? " · jour off habituel" : "");
  }

  // ----- Grille -----
  function render() {
    const ds = days(), ps = visiblePeople(), t = $("pl-grid");
    $("pl-range").textContent = st.span === "month" ? MONTHS[st.start.getMonth()] + " " + st.start.getFullYear() : fmt(ds[0]) + " – " + fmt(ds[ds.length - 1]);
    const narrow = st.span === "window" && st.winLen >= 91;
    const head0 = el("tr", "pl-months"), head1 = el("tr"), head2 = el("tr");
    const th0 = el("th", "pl-name pl-corner", "Collaborateur·rice"); th0.rowSpan = 3; head0.append(th0);
    // Ligne des mois : utile dès que la fenêtre déborde d'un mois
    for (let i = 0; i < ds.length;) {
      let j = i; while (j + 1 < ds.length && ds[j + 1].getMonth() === ds[i].getMonth()) j++;
      const th = el("th", "pl-month" + (i ? " pl-mon" : ""), MONTHS[ds[i].getMonth()] + " " + ds[i].getFullYear()); th.colSpan = (j - i + 1) * 2; head0.append(th);
      i = j + 1;
    }
    for (const d of ds) {
      const th = el("th", "pl-day" + (d.getDay() === 1 ? " pl-mon" : "") + (HOLIDAYS[iso(d)] ? " pl-hol" : ""));
      th.colSpan = 2;
      if (narrow) th.append(el("b", null, String(d.getDate())));
      else th.append(el("span", null, DOW[d.getDay()]), el("b", null, pad(d.getDate()) + "." + pad(d.getMonth() + 1)));
      th.title = (th.title ? th.title + " · " : "") + DOW[d.getDay()] + " " + fmt(d);
      if (HOLIDAYS[iso(d)]) th.title = HOLIDAYS[iso(d)];
      head1.append(th);
      head2.append(el("th", "pl-h" + (d.getDay() === 1 ? " pl-mon" : ""), narrow ? "" : "M"), el("th", "pl-h", narrow ? "" : "A"));
    }
    const thead = el("thead"); thead.append(head0, head1, head2);
    t.classList.toggle("pl-narrow", narrow);
    const tbody = el("tbody");
    for (const team of Object.keys(TEAMS)) {
      const members = ps.filter((p) => p.team === team);
      if (!members.length) continue;
      const g = el("tr", "pl-group"); const gc = el("th", "pl-name", TEAMS[team] + " (" + members.length + ")"); g.append(gc);
      const fill = el("td"); fill.colSpan = ds.length * 2; g.append(fill); tbody.append(g);
      for (const p of members) {
        const tr = el("tr", p.id === ME && st.view === "lecture" ? "pl-me" : null);
        const th = el("th", "pl-name");
        const nm = el(st.view === "cadre" ? "button" : "span", "pl-who", p.name);
        if (st.view === "cadre") { nm.type = "button"; nm.dataset.p = p.id; }
        if (p.status === "temporaire") th.append(el("span", "pl-temp", "temp."));
        th.append(nm, el("small", null, [p.status === "temporaire" ? "mission " + fmtS(p.from) + " – " + fmtS(p.to) : "", p.pct + " %", p.bloc != null ? (p.bloc ? "bloc " + p.bloc : "flottant") : "", "resp. " + p.resp].filter(Boolean).join(" · ")));
        tr.append(th);
        for (const d of ds) for (const h of [0, 1]) {
          const td = el("td", "pl-c" + (h === 0 && d.getDay() === 1 ? " pl-mon" : "") + (h === 1 ? " pl-pm" : ""));
          td.dataset.p = p.id; td.dataset.d = iso(d); td.dataset.h = h;
          paintCell(td, p, d, h);
          tr.append(td);
        }
        tbody.append(tr);
      }
    }
    // Couverture : présents par poste et par demi-journée, sur tout l'effectif (pas seulement les lignes filtrées)
    const tfoot = el("tfoot");
    const ft = el("tr", "pl-group"); const fh = el("th", "pl-name", "Couverture (min.)"); ft.append(fh); const ff = el("td"); ff.colSpan = ds.length * 2; ft.append(ff); tfoot.append(ft);
    for (const [key, label, test] of COVER) {
      const tr = el("tr", "pl-cov"); tr.append(el("th", "pl-name", label + " (" + db.mins[key] + ")"));
      for (const d of ds) for (const h of [0, 1]) {
        const td = el("td", "pl-c" + (h === 0 && d.getDay() === 1 ? " pl-mon" : "") + (h === 1 ? " pl-pm" : ""));
        if (HOLIDAYS[iso(d)]) { td.style.background = GREY; tr.append(td); continue; }
        const n = db.people.filter((p) => test(db.plan[p.id][iso(d) + "|" + h] || "")).length;
        td.textContent = n;
        if (n < db.mins[key]) { td.classList.add("pl-low"); td.title = label + " : " + n + " présent·e·s, minimum " + db.mins[key]; }
        tr.append(td);
      }
      tfoot.append(tr);
    }
    t.replaceChildren(thead, tbody, tfoot);
  }

  // ----- Peinture -----
  function setCell(pid, k, code, batch) {
    const prev = db.plan[pid][k] || "";
    if (prev === code) return;
    batch.push([pid, k, prev]);
    if (code) db.plan[pid][k] = code; else delete db.plan[pid][k];
  }
  function apply(td, batch, erase) {
    const p = db.people.find((x) => x.id === td.dataset.p), d = parse(td.dataset.d), h = Number(td.dataset.h);
    if (!inMission(p, d)) return;
    setCell(p.id, td.dataset.d + "|" + h, erase ? "" : st.tool, batch);
    paintCell(td, p, d, h);
  }
  const grid = $("pl-grid");
  grid.addEventListener("contextmenu", (e) => { if (st.view === "cadre" && e.target.closest("td.pl-c[data-p]")) e.preventDefault(); });
  grid.addEventListener("pointerdown", (e) => {
    if (st.view !== "cadre") return;
    const td = e.target.closest("td.pl-c[data-p]");
    if (!td) return;
    e.preventDefault();
    const erase = e.button === 2 || st.tool === "";
    const batch = [];
    const an = st.anchor && grid.querySelector('td[data-p="' + st.anchor.p + '"][data-d="' + st.anchor.d + '"][data-h="' + st.anchor.h + '"]');
    if (e.shiftKey && an) {
      const rows = [...grid.querySelectorAll("tbody tr")].filter((r) => r.querySelector("td[data-p]"));
      const r0 = rows.findIndex((r) => r.contains(an)), r1 = rows.findIndex((r) => r.contains(td));
      const c0 = [...an.parentNode.children].indexOf(an), c1 = [...td.parentNode.children].indexOf(td);
      if (r0 >= 0) {
        for (let r = Math.min(r0, r1); r <= Math.max(r0, r1); r++)
          for (let c = Math.min(c0, c1); c <= Math.max(c0, c1); c++) apply(rows[r].children[c], batch, erase);
        st.undo.push(batch); save(); render(); return;
      }
    }
    st.anchor = { p: td.dataset.p, d: td.dataset.d, h: td.dataset.h };
    st.painting = { batch, erase };
    apply(td, batch, erase);
  });
  grid.addEventListener("pointerover", (e) => {
    if (!st.painting) return;
    const td = e.target.closest("td.pl-c[data-p]");
    if (td) apply(td, st.painting.batch, st.painting.erase);
  });
  window.addEventListener("pointerup", () => {
    if (!st.painting) return;
    if (st.painting.batch.length) st.undo.push(st.painting.batch);
    st.painting = null; save(); render();
  });
  function undo() {
    const b = st.undo.pop();
    if (!b) return;
    for (const [pid, k, prev] of b.reverse()) { if (prev) db.plan[pid][k] = prev; else delete db.plan[pid][k]; }
    save(); render();
  }
  document.addEventListener("keydown", (e) => { if ((e.ctrlKey || e.metaKey) && e.key === "z" && st.view === "cadre" && !e.target.closest("input, select")) { e.preventDefault(); undo(); } });
  $("pl-undo").addEventListener("click", undo);

  // ----- Palette et légende -----
  function renderPalette() {
    const box = $("pl-palette"); box.replaceChildren();
    const groups = [...new Set(CODES.map((c) => c.group))];
    for (const g of groups) {
      const f = el("div", "pl-pgroup"); f.append(el("span", "pl-plabel", g));
      for (const c of CODES.filter((x) => x.group === g)) {
        const b = el("button", "pl-chip" + (st.tool === c.code ? " on" : ""), c.code);
        b.type = "button"; b.title = c.label; b.style.background = c.bg; b.style.color = c.fg;
        b.addEventListener("click", () => { st.tool = c.code; renderPalette(); });
        f.append(b);
      }
      box.append(f);
    }
    const f = el("div", "pl-pgroup"); f.append(el("span", "pl-plabel", "Effacer"));
    const gm = el("button", "pl-chip pl-eraser" + (st.tool === "" ? " on" : ""), "Gomme"); gm.type = "button";
    gm.addEventListener("click", () => { st.tool = ""; renderPalette(); });
    f.append(gm); box.append(f);
  }
  function renderLegend() {
    const box = $("pl-legend"); box.replaceChildren(el("h2", null, "Légende"));
    const list = el("div", "pl-leg");
    for (const c of CODES) {
      const i = el("span", "pl-legi"); const s = el("span", "pl-chip", c.code); s.style.background = c.bg; s.style.color = c.fg;
      i.append(s, c.label); list.append(i);
    }
    const i = el("span", "pl-legi"); const s = el("span", "pl-chip", ""); s.style.background = GREY; i.append(s, "Jour off habituel ou jour férié"); list.append(i);
    box.append(list);
  }

  // ----- Fiche d'une personne : semaine type, absence sur une période -----
  let cur = null;
  const SLOTS = ["lu", "ma", "me", "je", "ve"];
  function fillFiche() {
    $("pf-team").replaceChildren(...Object.entries(TEAMS).map(([k, v]) => { const o = el("option", null, v); o.value = k; return o; }));
    $("pf-first").value = cur.first; $("pf-last").value = cur.last; $("pf-team").value = cur.team;
    $("pf-bloc").value = cur.bloc == null ? "" : String(cur.bloc); $("pf-pct").value = cur.pct; $("pf-resp").value = cur.resp;
    $("pf-status").value = cur.status; $("pf-from").value = cur.from || ""; $("pf-to").value = cur.to || ""; $("pf-account").value = cur.account;
    const off = $("pf-off"); off.replaceChildren(el("span"), ...SLOTS.map((s) => el("b", null, s)));
    for (const h of [0, 1]) {
      off.append(el("b", null, h ? "après-midi" : "matin"));
      for (let d = 0; d < 5; d++) {
        const l = el("label", "pl-offc"); const cb = el("input"); cb.type = "checkbox"; cb.dataset.slot = d * 2 + h; cb.checked = cur.off.includes(d * 2 + h);
        l.append(cb, "off"); off.append(l);
      }
    }
  }
  function openNew() {
    const ds = days();
    cur = { id: "n" + Date.now(), first: "", last: "", name: "", team: "DESK", bloc: null, pct: 100, off: [], resp: R2, status: "temporaire", from: iso(ds[0]), to: iso(addDays(ds[0], 27)), account: "generique", isNew: true };
    $("pl-person-title").textContent = "Nouvelle ligne";
    $("pl-person-meta").textContent = "Un·e temporaire en mission, un nouvel engagement ou un remplacement. La ligne n'apparaît que pendant la période indiquée.";
    fillFiche();
    $("pl-plan-part").hidden = true;
    $("pl-person-msg").textContent = "";
    $("pl-person").showModal();
    $("pf-first").focus();
  }
  $("pl-add").addEventListener("click", openNew);
  $("pf-save").addEventListener("click", () => {
    const first = $("pf-first").value.trim(), last = $("pf-last").value.trim(), from = $("pf-from").value || null, to = $("pf-to").value || null;
    const status = $("pf-status").value;
    if (!first || !last) { $("pl-person-msg").textContent = "Prénom et nom sont nécessaires."; return; }
    if (status === "temporaire" && (!from || !to)) { $("pl-person-msg").textContent = "Une mission temporaire a une date de début et de fin."; return; }
    if (from && to && to < from) { $("pl-person-msg").textContent = "La fin précède le début."; return; }
    const isNew = cur.isNew;
    Object.assign(cur, { first, last, name: first + " " + last, team: $("pf-team").value, bloc: $("pf-bloc").value === "" ? null : Number($("pf-bloc").value),
      pct: Math.min(100, Math.max(10, Number($("pf-pct").value) || 100)), resp: $("pf-resp").value.trim(), status, from, to, account: $("pf-account").value,
      off: [...$("pf-off").querySelectorAll("input")].filter((c) => c.checked).map((c) => Number(c.dataset.slot)).sort((a, b) => a - b) });
    if (isNew) { delete cur.isNew; db.people.push(cur); db.plan[cur.id] = {}; db.weeks[cur.id] = defaultWeek(cur, db.people.length - 1); }
    save(); render();
    openPerson(cur.id, isNew ? "Ligne créée. Définissez sa semaine type et appliquez-la sur la mission." : "Fiche enregistrée.");
  });
  function openPerson(pid, note) {
    cur = db.people.find((p) => p.id === pid);
    $("pl-plan-part").hidden = false;
    fillFiche();
    $("pl-person-title").textContent = cur.name;
    $("pl-person-meta").textContent = TEAMS[cur.team] + " · " + cur.pct + " % · responsable " + cur.resp + (cur.status === "temporaire" ? " · mission du " + fmtS(cur.from) + " au " + fmtS(cur.to) : "");
    const wk = $("pl-week"); wk.replaceChildren();
    wk.append(el("span"), ...SLOTS.map((s) => el("b", null, s)));
    for (const h of [0, 1]) {
      wk.append(el("b", null, h ? "après-midi" : "matin"));
      for (let d = 0; d < 5; d++) {
        const s = el("select"); s.dataset.slot = d * 2 + h;
        const o0 = el("option", null, cur.off.includes(d * 2 + h) ? "off" : "—"); o0.value = ""; s.append(o0);
        for (const c of CODES.filter((x) => !x.abs)) { const o = el("option", null, c.code); o.value = c.code; s.append(o); }
        s.value = db.weeks[cur.id][d * 2 + h] || "";
        wk.append(s);
      }
    }
    const ac = $("pl-abs-code"); ac.replaceChildren(...CODES.filter((c) => c.abs).map((c) => { const o = el("option", null, c.label); o.value = c.code; return o; }));
    const ds = days();
    $("pl-wk-from").value = cur.from && cur.from > iso(ds[0]) ? cur.from : iso(ds[0]);
    $("pl-wk-to").value = cur.to || iso(addDays(ds[0], 27));
    $("pl-abs-from").value = iso(ds[0]); $("pl-abs-to").value = iso(ds[0]);
    $("pl-person-msg").textContent = note || "";
    if (!$("pl-person").open) $("pl-person").showModal();
  }
  grid.addEventListener("click", (e) => { const b = e.target.closest("button.pl-who"); if (b) openPerson(b.dataset.p); });
  $("pl-wk-apply").addEventListener("click", () => {
    db.weeks[cur.id] = [...$("pl-week").querySelectorAll("select")].sort((a, b) => a.dataset.slot - b.dataset.slot).map((s) => s.value);
    const a = $("pl-wk-from").value, b = $("pl-wk-to").value;
    if (!a || !b || b < a) { $("pl-person-msg").textContent = "Période invalide."; return; }
    const batch = []; let n = 0;
    for (const d of workdays(parse(a), parse(b))) {
      if (HOLIDAYS[iso(d)]) continue;
      for (const h of [0, 1]) {
        const k = iso(d) + "|" + h, prev = db.plan[cur.id][k];
        if (prev && BY[prev] && BY[prev].abs) continue;
        if (!inMission(cur, d)) continue;
        const code = isOff(cur, d, h) ? "" : db.weeks[cur.id][slot(d, h)];
        const before = batch.length; setCell(cur.id, k, code, batch); n += batch.length - before;
      }
    }
    if (batch.length) st.undo.push(batch);
    save(); render();
    $("pl-person-msg").textContent = n + " demi-journée(s) mise(s) à jour du " + fmt(parse(a)) + " au " + fmt(parse(b)) + ".";
  });
  $("pl-abs-apply").addEventListener("click", () => {
    const a = $("pl-abs-from").value, b = $("pl-abs-to").value, ha = Number($("pl-abs-from-h").value), hb = Number($("pl-abs-to-h").value), code = $("pl-abs-code").value;
    if (!a || !b || b < a || (a === b && hb < ha)) { $("pl-person-msg").textContent = "Période invalide."; return; }
    const batch = []; let n = 0;
    for (const d of workdays(parse(a), parse(b))) {
      if (HOLIDAYS[iso(d)]) continue;
      for (const h of [0, 1]) {
        if ((iso(d) === a && h < ha) || (iso(d) === b && h > hb) || isOff(cur, d, h) || !inMission(cur, d)) continue;
        setCell(cur.id, iso(d) + "|" + h, code, batch); n++;
      }
    }
    if (batch.length) st.undo.push(batch);
    save(); render();
    $("pl-person-msg").textContent = BY[code].label + " saisie : " + n + " demi-journée(s) (jours off et fériés exclus).";
  });

  // ----- Copier une semaine -----
  $("pl-copy").addEventListener("click", () => {
    const a = monday(days()[0]);
    $("pl-copy-src").textContent = "Semaine du " + fmt(a) + " au " + fmt(addDays(a, 4)) + ", pour les " + visiblePeople().length + " personnes affichées (filtres actifs).";
    $("pl-copy-dlg").showModal();
  });
  $("pl-copy-dlg").addEventListener("close", () => {
    if ($("pl-copy-dlg").returnValue !== "ok") return;
    const src = monday(days()[0]), n = Math.min(12, Math.max(1, Number($("pl-copy-n").value) || 1)), keep = $("pl-copy-keep").checked;
    const batch = [];
    for (const p of visiblePeople()) for (let w = 1; w <= n; w++) for (let i = 0; i < 5; i++) {
      const sd = addDays(src, i), td = addDays(src, w * 7 + i);
      if (HOLIDAYS[iso(td)] || !inMission(p, td)) continue;
      for (const h of [0, 1]) {
        const code = db.plan[p.id][iso(sd) + "|" + h] || "", k = iso(td) + "|" + h, prev = db.plan[p.id][k];
        if (BY[code] && BY[code].abs) continue;
        if (keep && prev && BY[prev] && BY[prev].abs) continue;
        setCell(p.id, k, code, batch);
      }
    }
    if (batch.length) st.undo.push(batch);
    save(); render();
  });

  // ----- Minimums -----
  $("pl-min").addEventListener("click", () => {
    const box = $("pl-mins"); box.replaceChildren();
    for (const [key, label] of COVER) {
      const l = el("label", null, label); const i = el("input"); i.type = "number"; i.min = 0; i.max = 30; i.value = db.mins[key]; i.dataset.k = key; l.append(i); box.append(l);
    }
    $("pl-min-dlg").showModal();
  });
  $("pl-min-dlg").addEventListener("close", () => {
    if ($("pl-min-dlg").returnValue !== "ok") return;
    for (const i of $("pl-mins").querySelectorAll("input")) db.mins[i.dataset.k] = Math.max(0, Number(i.value) || 0);
    save(); render();
  });
  $("pl-reset").addEventListener("click", () => {
    if (!confirm("Rétablir les données de départ de la maquette ?")) return;
    db = seed(); st.undo = []; save(); render();
  });

  // ----- Navigation et vues -----
  function seg(attr, fn) {
    for (const b of document.querySelectorAll("[data-" + attr + "]")) b.addEventListener("click", () => {
      for (const x of document.querySelectorAll("[data-" + attr + "]")) x.classList.toggle("on", x === b);
      fn(b.dataset[attr]); render();
    });
  }
  const ME_TEXT = {
    lecture: "Vue d'une collaboratrice admin (Léa Rochat) : lecture seule, sa ligne est surlignée, les motifs d'absence sensibles des autres (maladie, congé, militaire) sont masqués.",
    medecin: "Vue d'un médecin : lecture seule de tout le planning admin (qui est au desk, en AM, au back office), sans les motifs d'absence sensibles."
  };
  seg("view", (v) => {
    st.view = v; $("pl-tools").hidden = v !== "cadre"; $("pl-me").hidden = v === "cadre";
    if (v !== "cadre") { $("pl-me-text").textContent = ME_TEXT[v]; $("pl-only-me-wrap").hidden = v !== "lecture"; }
  });
  seg("span", (v) => {
    st.span = v === "month" || v === "window" ? v : Number(v);
    $("pl-win-wrap").hidden = v !== "window";
    if (v === "month") st.start = new Date(st.start.getFullYear(), st.start.getMonth(), 1); else st.start = monday(st.start);
  });
  $("pl-winlen").addEventListener("change", (e) => { st.winLen = Number(e.target.value); render(); });
  function move(dir) {
    if (st.span === "month") st.start = new Date(st.start.getFullYear(), st.start.getMonth() + dir, 1);
    // Fenêtre glissante : une semaine par clic (un mois au-delà de 3 mois affichés), comme dans Absences
    else if (st.span === "window") st.start = st.winLen >= 91 ? monday(new Date(st.start.getFullYear(), st.start.getMonth() + dir, st.start.getDate())) : addDays(st.start, 7 * dir);
    else st.start = addDays(st.start, dir * (st.span === 5 ? 7 : 14));
    render();
  }
  $("pl-prev").addEventListener("click", () => move(-1));
  $("pl-next").addEventListener("click", () => move(1));
  $("pl-today").addEventListener("click", () => { const t = new Date(); st.start = st.span === "month" ? new Date(t.getFullYear(), t.getMonth(), 1) : monday(t); render(); });
  for (const [k, v] of Object.entries(TEAMS)) { const o = el("option", null, v); o.value = k; $("pl-team").append(o); }
  $("pl-team").addEventListener("change", render);
  $("pl-q").addEventListener("input", render);
  $("pl-only-me").addEventListener("change", (e) => { st.onlyMe = e.target.checked; render(); });

  // ----- Export Excel, au format du tableur actuel -----
  function loadScript(src, global) {
    return new Promise((ok, ko) => {
      if (window[global]) return ok();
      const s = document.createElement("script");
      s.src = src; s.onload = ok; s.onerror = () => ko(new Error("chargement d'ExcelJS impossible"));
      document.head.append(s);
    });
  }
  const argb = (hex) => "FF" + hex.replace("#", "").toUpperCase();
  const fill = (hex) => ({ type: "pattern", pattern: "solid", fgColor: { argb: argb(hex) } });
  $("pl-xlsx").addEventListener("click", async () => {
    const msg = $("pl-xlsx-msg"); msg.textContent = "Préparation…";
    try {
      await loadScript(EXCELJS, "ExcelJS");
      const ds = $("pl-xlsx-span").value === "all" ? workdays(DATA_FROM, DATA_TO) : days();
      const wb = new window.ExcelJS.Workbook();
      const ws = wb.addWorksheet("Planning", { views: [{ state: "frozen", xSplit: 6, ySplit: 2 }] });
      const thin = { style: "thin", color: { argb: "FFBFBFBF" } };
      const head = ["Resp.", "%", "Bloc", "Titre", "Prénom", "Nom"];
      head.forEach((h, i) => { const c = ws.getCell(1, i + 1); c.value = h; c.font = { bold: true }; ws.mergeCells(1, i + 1, 2, i + 1); c.alignment = { vertical: "middle" }; });
      ds.forEach((d, j) => {
        const col = 7 + j * 2;
        ws.mergeCells(1, col, 1, col + 1);
        const c = ws.getCell(1, col); c.value = DOW[d.getDay()] + " " + pad(d.getDate()) + "." + pad(d.getMonth() + 1) + "." + d.getFullYear();
        c.alignment = { horizontal: "center", textRotation: 90 }; c.font = { bold: true, size: 8 };
        if (HOLIDAYS[iso(d)]) c.fill = fill(GREY);
        ws.getCell(2, col).value = "M"; ws.getCell(2, col + 1).value = "A";
        for (const k of [col, col + 1]) { ws.getCell(2, k).alignment = { horizontal: "center" }; ws.getCell(2, k).font = { size: 8 }; ws.getColumn(k).width = 4.3; }
      });
      ws.getRow(1).height = 62;
      [8, 5, 6, 7, 12, 14].forEach((w, i) => (ws.getColumn(i + 1).width = w));
      let r = 3;
      const a0 = iso(ds[0]), a1 = iso(ds[ds.length - 1]);
      for (const team of Object.keys(TEAMS)) for (const p of db.people.filter((x) => x.team === team && (!x.from || x.from <= a1) && (!x.to || x.to >= a0))) {
        [p.resp, p.pct, p.bloc == null ? "" : p.bloc === 0 ? "*" : p.bloc, team + (p.status === "temporaire" ? " (temp.)" : ""), p.first, p.last.toUpperCase()].forEach((v, i) => (ws.getCell(r, i + 1).value = v));
        ds.forEach((d, j) => {
          for (const h of [0, 1]) {
            const c = ws.getCell(r, 7 + j * 2 + h), code = db.plan[p.id][iso(d) + "|" + h], def = code && BY[code];
            c.alignment = { horizontal: "center" }; c.font = { size: 8, color: { argb: argb(def ? def.fg : "#000000") } }; c.border = { top: thin, bottom: thin, left: h ? thin : { style: "medium" }, right: thin };
            if (code) { c.value = code; if (def) c.fill = fill(def.bg); }
            else if (!inMission(p, d)) c.fill = { type: "pattern", pattern: "lightUp", fgColor: { argb: "FFBFBFBF" }, bgColor: { argb: "FFFFFFFF" } };
            else if (HOLIDAYS[iso(d)] || isOff(p, d, h)) c.fill = fill(GREY);
          }
        });
        r++;
      }
      // Récapitulatif de couverture, comme sous la grille de l'outil
      r++;
      const tc = ws.getCell(r, 1); tc.value = "Couverture par demi-journée (minimum entre parenthèses)"; tc.font = { bold: true }; ws.mergeCells(r, 1, r, 6);
      r++;
      for (const [key, label, test] of COVER) {
        const lc = ws.getCell(r, 1); lc.value = label + " (" + db.mins[key] + ")"; ws.mergeCells(r, 1, r, 6); lc.font = { bold: true, size: 9 };
        ds.forEach((d, j) => {
          for (const h of [0, 1]) {
            const c = ws.getCell(r, 7 + j * 2 + h);
            c.alignment = { horizontal: "center" }; c.border = { top: thin, bottom: thin, left: h ? thin : { style: "medium" }, right: thin };
            if (HOLIDAYS[iso(d)]) { c.fill = fill(GREY); continue; }
            const n = db.people.filter((p) => test(db.plan[p.id][iso(d) + "|" + h] || "")).length;
            c.value = n;
            const low = n < db.mins[key];
            c.font = { size: 8, bold: low, color: { argb: low ? "FFB3261E" : "FF333333" } };
            c.fill = fill(low ? "#F8D7D5" : "#F2F4F8");
          }
        });
        r++;
      }
      const lg = wb.addWorksheet("Légende");
      lg.getColumn(1).width = 26; lg.getColumn(2).width = 8; lg.getColumn(3).width = 46;
      lg.addRow(["Groupe", "Code", "Signification"]).font = { bold: true };
      for (const c of CODES) { const row = lg.addRow([c.group, c.code, c.label]); row.getCell(2).fill = fill(c.bg); row.getCell(2).font = { color: { argb: argb(c.fg) } }; }
      const g = lg.addRow(["", "", "Jour off habituel ou jour férié"]); g.getCell(2).fill = fill(GREY);
      lg.addRow([]); lg.addRow(["* sera attribué à l'un des blocs selon les besoins du jour ou de la semaine"]);
      const buf = await wb.xlsx.writeBuffer();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
      a.download = "planning-admin-" + iso(ds[0]) + "-" + iso(ds[ds.length - 1]) + ".xlsx";
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      msg.textContent = "Fichier téléchargé (" + ds.length + " jours ouvrables).";
    } catch (e) { msg.textContent = "Export impossible : " + e.message; }
  });

  renderPalette(); renderLegend(); render();
})();
