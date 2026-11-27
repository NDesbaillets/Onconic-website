// Ordre des listes de personnes : par défaut nom de famille, au choix de l'utilisateur (prénom, rôle, clinique, ou un mode propre à la liste).
// Module pur sans dépendance : window.OnconicSort dans le navigateur, module.exports sous Node (tests).
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.OnconicSort = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  const MODES = ["family", "first", "role", "clinic"];
  const LABELS = { family: "Nom de famille", first: "Prénom", role: "Rôle", clinic: "Clinique" };
  const PARTICLES = new Set(["de", "du", "des", "la", "le", "les", "del", "della", "di", "da", "dos", "von", "van", "der", "den", "ten", "ter", "zu", "zur", "af", "el", "al", "bin", "ben"]);
  const TITLES = new Set(["dr", "dre", "pr", "prof", "pd"]);
  const NO_NAME = "(sans nom)";
  const collator = new Intl.Collator("fr", { sensitivity: "base", numeric: true });
  const KEY = "onconic.sort.";

  const words = (s) => String(s == null ? "" : s).trim().split(/\s+/).filter(Boolean);
  const bare = (w) => w.replace(/\.$/, "").toLowerCase();

  // Retire les titres en tête : Dr, Dre, Pr, Prof., PD, Dr med.
  function stripTitles(ws) {
    let i = 0, afterTitle = false;
    while (i < ws.length - 1) {
      const b = bare(ws[i]);
      if (TITLES.has(b)) { afterTitle = true; i++; } else if (afterTitle && b === "med") i++; else break;
    }
    return ws.slice(i);
  }

  // Renvoie { first, last, empty } pour une chaîne « Prénom Nom » ou un objet { first, last, name }.
  function splitName(person) {
    let first = "", last = "";
    if (person && typeof person === "object") {
      const f = String(person.first || person.first_name || "").trim();
      const l = String(person.last || person.last_name || "").trim();
      if (l) { first = f; last = l; } else return splitName(person.name || person.full_name || [f].join(" "));
    } else {
      const ws = String(person == null ? "" : person).trim() === NO_NAME ? [] : stripTitles(words(person));
      if (ws.length === 1) last = ws[0];
      else if (ws.length > 1) {
        let i = ws.length - 1;
        while (i - 1 >= 1 && PARTICLES.has(ws[i - 1].toLowerCase())) i--;
        last = ws.slice(i).join(" ");
        first = ws.slice(0, i).join(" ");
      }
    }
    const empty = !last || last === NO_NAME;
    return { first: empty ? "" : first, last: empty ? "" : last, empty };
  }

  const idOf = (p) => (p && typeof p === "object" ? String(p.id == null ? "" : p.id) : String(p == null ? "" : p));
  function rankOf(p, ctx) {
    const o = ctx && ctx.roleOrder, role = p && typeof p === "object" ? p.role : undefined;
    const r = Array.isArray(o) ? o.indexOf(role) : o ? o[role] : undefined;
    return r == null || r < 0 ? 999 : r;
  }
  function clinicOf(p) {
    if (!p || typeof p !== "object") return "";
    return String((Array.isArray(p.clinics) ? p.clinics[0] : p.clinic) || "");
  }
  const byFamily = (x, y) => collator.compare(x.last, y.last) || collator.compare(x.first, y.first);

  function compareNames(a, b, mode, ctx) {
    const x = splitName(a), y = splitName(b);
    if (x.empty !== y.empty) return x.empty ? 1 : -1;
    let c = 0;
    if (!x.empty) {
      if (mode === "first") c = collator.compare(x.first, y.first) || collator.compare(x.last, y.last);
      else if (mode === "role") c = rankOf(a, ctx) - rankOf(b, ctx) || byFamily(x, y);
      else if (mode === "clinic") {
        const ca = clinicOf(a), cb = clinicOf(b);
        c = (!ca) - (!cb) || collator.compare(ca, cb) || byFamily(x, y);
      } else c = byFamily(x, y);
    }
    return c || (idOf(a) < idOf(b) ? -1 : idOf(a) > idOf(b) ? 1 : 0);
  }

  function sortPeople(list, opts) {
    const o = opts || {}, get = o.get || ((x) => x);
    return Array.from(list || []).sort((a, b) => compareNames(get(a), get(b), o.mode || "family", o.ctx));
  }

  // extra : modes supplémentaires fournis par l'appelant (ex. « sheet », l'ordre du serveur), acceptés pour cette liste seulement ;
  // l'appelant les trie lui-même (compareNames ne les connaît pas et retombe sur le nom de famille).
  const known = (m, extra) => MODES.indexOf(m) >= 0 || (Array.isArray(extra) && extra.indexOf(m) >= 0);
  function getMode(listKey, allowed, extra) {
    let v = "family";
    try { v = localStorage.getItem(KEY + listKey) || "family"; } catch (e) { v = "family"; }
    if (!known(v, extra) || (allowed && allowed.indexOf(v) < 0)) return "family";
    return v;
  }
  function setMode(listKey, mode, extra) {
    if (!known(mode, extra)) return false;
    try { localStorage.setItem(KEY + listKey, mode); return true; } catch (e) { return false; }
  }

  // Liste déroulante « Trier par » ; renvoie l'étiquette qui l'entoure (.sort-control, select en .sort-select).
  // opts.extra : { mode: "Libellé" } pour des modes propres à la liste, à citer aussi dans opts.modes pour fixer leur place.
  function control(listKey, opts) {
    const o = opts || {}, extra = o.extra || {}, extraKeys = Object.keys(extra);
    const modes = (o.modes || ["family", "first"]).filter((m) => known(m, extraKeys));
    const label = document.createElement("label");
    label.className = "sort-control";
    label.append(document.createTextNode("Trier par "));
    const sel = document.createElement("select");
    sel.className = "sort-select";
    for (const m of modes) {
      const opt = document.createElement("option");
      opt.value = m;
      opt.textContent = MODES.indexOf(m) >= 0 ? LABELS[m] : extra[m];
      sel.append(opt);
    }
    sel.value = getMode(listKey, modes, extraKeys);
    sel.addEventListener("change", () => {
      setMode(listKey, sel.value, extraKeys);
      if (typeof o.onChange === "function") o.onChange(sel.value);
    });
    label.append(sel);
    return label;
  }

  return { splitName, compareNames, sortPeople, getMode, setMode, control, MODES, LABELS };
});
