// Jours fériés vaudois calculés (Pâques par l'algorithme de Meeus), module partagé par le planning des absences et la page
// d'administration du calendrier. Mêmes neuf jours que public.vd_holiday_calc() en base (supabase/migrations/202611270003_calendrier_direction.sql).
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.OnconicHolidays = api;
})(typeof self !== "undefined" ? self : this, function () {
  const iso = (d) => d.toISOString().slice(0, 10);
  const cache = new Map();

  function easter(y) {
    const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
    return new Date(Date.UTC(y, month - 1, day));
  }

  // Année -> Map date ISO (AAAA-MM-JJ) -> nom
  function holidays(y) {
    if (cache.has(y)) return cache.get(y);
    const map = new Map();
    const at = (m, d) => new Date(Date.UTC(y, m, d));
    const off = (n) => { const d = easter(y); d.setUTCDate(d.getUTCDate() + n); return d; };
    const sep1 = at(8, 1).getUTCDay(); // 0 = dimanche
    const firstSunday = 1 + ((7 - sep1) % 7);
    [[at(0, 1), "Nouvel An"], [at(0, 2), "2 janvier"], [off(-2), "Vendredi saint"], [off(1), "Lundi de Pâques"], [off(39), "Ascension"],
      [off(50), "Lundi de Pentecôte"], [at(7, 1), "Fête nationale"], [at(8, firstSunday + 15), "Lundi du Jeûne fédéral"], [at(11, 25), "Noël"]]
      .forEach(([d, l]) => map.set(iso(d), l));
    cache.set(y, map);
    return map;
  }

  const holidayOf = (day) => holidays(Number(String(day).slice(0, 4))).get(String(day).slice(0, 10));
  // Liste triée [{ date, label }] d'une année
  const list = (y) => [...holidays(y)].map(([date, label]) => ({ date, label })).sort((x, y2) => (x.date < y2.date ? -1 : 1));

  return { easter, holidays, holidayOf, list };
});
