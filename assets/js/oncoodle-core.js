// Oncoodle : logique pure (dates, jours fériés vaudois, génération et classement des créneaux, fichier agenda, modèles).
// Chargé par la page (window.OncoodleCore) et par les tests Node (module.exports). Aucun accès au DOM ni au réseau.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.OncoodleCore = api;
})(typeof self !== "undefined" ? self : this, function () {
  const MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
  const DAYS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];

  // ----- Dates (chaînes AAAA-MM-JJ, sans fuseau horaire) -----
  const pd = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); };
  const iso = (d) => d.toISOString().slice(0, 10);
  const addDays = (s, n) => { const d = pd(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
  const weekday = (s) => pd(s).getUTCDay(); // 0 = dimanche
  const fmtCH = (s) => s.split("-").reverse().join(".");
  const fmtLong = (s) => { const d = pd(s); return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
  const fmtShort = (s) => { const d = pd(s); return `${DAYS[d.getUTCDay()].slice(0, 3)}. ${d.getUTCDate()}.${String(d.getUTCMonth() + 1).padStart(2, "0")}`; };
  const timeRange = (o) => (o.start && o.end ? `${o.start}–${o.end}` : "Journée");
  const optionLabel = (o) => `${fmtShort(o.day)}, ${timeRange(o)}`;
  const toMin = (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
  const fromMin = (n) => `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;

  // ----- Jours fériés vaudois (Pâques par l'algorithme de Meeus), identiques à ceux de la page Absences -----
  const cache = new Map();
  function easter(y) {
    const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
    return new Date(Date.UTC(y, month - 1, day));
  }
  function holidays(y) {
    if (cache.has(y)) return cache.get(y);
    const map = new Map();
    const at = (m, d) => new Date(Date.UTC(y, m, d));
    const off = (n) => { const d = easter(y); d.setUTCDate(d.getUTCDate() + n); return d; };
    const sep1 = at(8, 1).getUTCDay();
    const firstSunday = 1 + ((7 - sep1) % 7);
    [[at(0, 1), "Nouvel An"], [at(0, 2), "2 janvier"], [off(-2), "Vendredi saint"], [off(1), "Lundi de Pâques"], [off(39), "Ascension"],
      [off(50), "Lundi de Pentecôte"], [at(7, 1), "Fête nationale"], [at(8, firstSunday + 15), "Lundi du Jeûne fédéral"], [at(11, 25), "Noël"]]
      .forEach(([d, l]) => map.set(iso(d), l));
    cache.set(y, map);
    return map;
  }
  const holidayOf = (day) => holidays(Number(day.slice(0, 4))).get(day) || null;

  // ----- Générateur de créneaux -----
  // { from, to, weekdays: [1..5], starts: ["12:00"], duration: 60 (minutes, 0 = journée entière), skipHolidays, today, max }
  function generateSlots(o) {
    const out = [];
    const max = o.max || 40;
    const starts = (o.starts && o.starts.length ? o.starts : [null]);
    const wd = new Set(o.weekdays && o.weekdays.length ? o.weekdays : [1, 2, 3, 4, 5]);
    if (!o.from || !o.to || o.to < o.from) return { slots: out, truncated: false, error: "Période invalide." };
    if ((pd(o.to) - pd(o.from)) / 864e5 > 180) return { slots: out, truncated: false, error: "Période trop longue (6 mois au maximum)." };
    let truncated = false;
    for (let d = o.from; d <= o.to; d = addDays(d, 1)) {
      if (o.today && d < o.today) continue;
      if (!wd.has(weekday(d))) continue;
      if (o.skipHolidays !== false && holidayOf(d)) continue;
      for (const s of starts) {
        if (out.length >= max) { truncated = true; break; }
        if (!s || !o.duration) out.push({ day: d, start: null, end: null });
        else {
          const end = toMin(s) + o.duration;
          if (end > 24 * 60) continue;
          out.push({ day: d, start: s, end: fromMin(end) });
        }
      }
      if (truncated) break;
    }
    return { slots: out, truncated, error: null };
  }
  const slotKey = (s) => `${s.day}|${s.start || ""}|${s.end || ""}`;
  function mergeSlots(existing, added, max) {
    const seen = new Set(existing.map(slotKey));
    const out = existing.slice();
    for (const s of added) if (!seen.has(slotKey(s)) && out.length < (max || 40)) { seen.add(slotKey(s)); out.push(s); }
    return out.sort((a, b) => (a.day + (a.start || "")).localeCompare(b.day + (b.start || "")));
  }

  // ----- Classement des créneaux -----
  // options : [{ id, day, start, yes, maybe, no, req_no, absent }]. Un créneau est « retenable » si aucun participant obligatoire n'a répondu non.
  // Score : oui = 1, peut-être = 0,5. Départage : moins de non, moins d'absents, date la plus proche. « best » = meilleur score parmi les retenables.
  function rank(options) {
    const rows = options.map((o) => ({ id: o.id, score: (o.yes || 0) + 0.5 * (o.maybe || 0), eligible: (o.req_no || 0) === 0, no: o.no || 0, absent: o.absent || 0, key: o.day + (o.start || ""), req_no: o.req_no || 0 }));
    rows.sort((a, b) => (b.eligible - a.eligible) || (b.score - a.score) || (a.no - b.no) || (a.absent - b.absent) || a.key.localeCompare(b.key));
    const top = rows.find((r) => r.eligible && r.score > 0);
    const best = new Set(top ? rows.filter((r) => r.eligible && r.score === top.score && r.no === top.no && r.absent === top.absent).map((r) => r.id) : []);
    return rows.map((r, i) => ({ id: r.id, rank: i + 1, score: r.score, eligible: r.eligible, best: best.has(r.id), req_no: r.req_no }));
  }

  // ----- Fichier agenda (.ics), même rendu que la fonction d'envoi -----
  const esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
  function fold(line) {
    const out = [];
    let rest = line;
    while ([...rest].length > 74) { const head = [...rest].slice(0, 74).join(""); out.push(head); rest = " " + rest.slice(head.length); }
    out.push(rest);
    return out.join("\r\n");
  }
  const ZURICH = ["BEGIN:VTIMEZONE", "TZID:Europe/Zurich",
    "BEGIN:DAYLIGHT", "TZOFFSETFROM:+0100", "TZOFFSETTO:+0200", "TZNAME:CEST", "DTSTART:19700329T020000", "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU", "END:DAYLIGHT",
    "BEGIN:STANDARD", "TZOFFSETFROM:+0200", "TZOFFSETTO:+0100", "TZNAME:CET", "DTSTART:19701025T030000", "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU", "END:STANDARD", "END:VTIMEZONE"];
  function buildIcs(e, now) {
    const timed = !!(e.start && e.end), c = (d) => d.replaceAll("-", "");
    const stamp = (now || new Date()).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Onconic//Oncoodle//FR", "CALSCALE:GREGORIAN", "METHOD:PUBLISH"].concat(timed ? ZURICH : [], [
      "BEGIN:VEVENT", `UID:oncoodle-${e.id}@onconic.ch`, `DTSTAMP:${stamp}`, `SEQUENCE:${e.sequence || 0}`,
      timed ? `DTSTART;TZID=Europe/Zurich:${c(e.day)}T${e.start.replace(":", "")}00` : `DTSTART;VALUE=DATE:${c(e.day)}`,
      timed ? `DTEND;TZID=Europe/Zurich:${c(e.day)}T${e.end.replace(":", "")}00` : `DTEND;VALUE=DATE:${c(addDays(e.day, 1))}`,
      `SUMMARY:${esc(e.title)}`], e.location ? [`LOCATION:${esc(e.location)}`] : [], ["END:VEVENT", "END:VCALENDAR"]);
    return lines.map(fold).join("\r\n") + "\r\n";
  }

  // ----- Destinataires -----
  const ROLE_SINGULAR = { clinician: "médecin assistant", cdc: "chef de clinique", cadre: "médecin cadre", assistant: "assistante médicale", nurse: "infirmier·ère", pharmacist: "pharmacien·ne", direction: "direction", admin: "admin" };
  const ROLE_PLURAL = { clinician: "Médecins assistants", cdc: "Chefs de clinique", cadre: "Médecins cadres", assistant: "Assistantes médicales", nurse: "Infirmier·ères", pharmacist: "Pharmaciens", direction: "Direction", admin: "Administrateurs" };
  const ROLE_ORDER = ["clinician", "cdc", "cadre", "nurse", "assistant", "pharmacist", "direction", "admin"];
  // Nettoie le descripteur envoyé à la base : groupes vides retirés, doublons supprimés
  function cleanAudience(a) {
    const rules = (a.rules || []).filter((r) => r.all || (r.clinics && r.clinics.length) || (r.roles && r.roles.length))
      .map((r) => (r.all ? { all: true } : { clinics: [...new Set(r.clinics || [])], roles: [...new Set(r.roles || [])] }));
    return { rules, users: [...new Set(a.users || [])], exclude: [...new Set(a.exclude || [])] };
  }
  const isEmptyAudience = (a) => { const c = cleanAudience(a); return !c.rules.length && !c.users.length; };
  function ruleLabel(r) {
    if (r.all) return "Tous les membres";
    const cl = (r.clinics || []).join(", "), ro = (r.roles || []).map((x) => ROLE_PLURAL[x] || x).join(", ");
    return [cl, ro].filter(Boolean).join(" · ") || "Groupe vide";
  }

  // ----- Modèles de sondage (suggestions, modifiables) -----
  const TEMPLATES = [
    { id: "colloque", label: "Colloque hebdomadaire", kind: "slots", title: "Colloque de clinique", description: "", location: "", gen: { weekdays: [1, 2, 3, 4, 5], starts: ["12:00", "12:30"], duration: 60 } },
    { id: "tumorboard", label: "Tumor board", kind: "slots", title: "Tumor board", description: "Aucun nom de patient dans ce sondage.", location: "", gen: { weekdays: [2, 3, 4], starts: ["12:30"], duration: 60 } },
    { id: "reunion", label: "Réunion de service", kind: "slots", title: "Réunion de service", description: "", location: "", gen: { weekdays: [1, 2, 3, 4, 5], starts: ["08:00", "16:00"], duration: 60 } },
    { id: "journalclub", label: "Journal club", kind: "slots", title: "Journal club", description: "", location: "", gen: { weekdays: [1, 2, 3, 4], starts: ["12:15"], duration: 60 } },
    { id: "repas", label: "Repas d'équipe", kind: "rsvp", title: "Repas d'équipe", description: "", location: "", gen: { weekdays: [4, 5], starts: ["19:00"], duration: 180 } },
    { id: "apero", label: "Apéro ou sortie d'équipe", kind: "rsvp", title: "Apéro d'équipe", description: "", location: "", gen: { weekdays: [4, 5], starts: ["18:00"], duration: 120 } },
  ];

  return { MONTHS, DAYS, pd, iso, addDays, weekday, fmtCH, fmtLong, fmtShort, timeRange, optionLabel, toMin, fromMin, holidays, holidayOf, generateSlots, slotKey, mergeSlots, rank,
    buildIcs, ROLE_SINGULAR, ROLE_PLURAL, ROLE_ORDER, cleanAudience, isEmptyAudience, ruleLabel, TEMPLATES };
});
