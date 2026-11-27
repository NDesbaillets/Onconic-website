// Le module partagé assets/js/vd-holidays.js donne les mêmes fériés vaudois que vd_holiday_dates() en base (2024 à 2032).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
const require = createRequire(import.meta.url);
const H = require('../../assets/js/vd-holidays.js');
const root = new URL('../../', import.meta.url);

test('fériés vaudois : module JS et vd_holiday_dates SQL identiques de 2024 à 2032', async () => {
  const db = new PGlite();
  try {
    await db.exec(await readFile(new URL('tests/absences/fixture.sql', root), 'utf8'));
    // aucune entrée manuelle : seuls les fériés calculés sont comparés
    await db.exec(await readFile(new URL('supabase/absences.sql', root), 'utf8'));
    // fonctions des autres migrations, que la liste de droits de la migration nomme (corps sans intérêt ici)
    await db.exec("create function public.admin_calendar_sync_status() returns jsonb language sql as 'select null::jsonb';");
    await db.exec(await readFile(new URL('supabase/migrations/202611270003_calendrier_direction.sql', root), 'utf8'));
    for (let y = 2024; y <= 2032; y++) {
      const sql = (await db.query('select public.vd_holiday_dates($1) d', [y])).rows[0].d.map((x) => (x instanceof Date ? x.toISOString().slice(0, 10) : String(x).slice(0, 10)));
      const js = H.list(y).map((x) => x.date);
      assert.equal(js.length, 9, `${y} : neuf jours`);
      assert.deepEqual(js, sql, `${y}`);
      assert.equal(H.holidayOf(`${y}-12-25`), 'Noël');
    }
    assert.equal(H.holidayOf('2027-03-26'), 'Vendredi saint');
    assert.equal(H.holidayOf('2027-03-27'), undefined);
  } finally { await db.close(); }
});

test('fériés manuels : extraMap, fusion avec le calcul, createExtra (plage, tranches, échec non mémorisé)', async () => {
  const m = H.extraMap([{ day: '2027-05-14', label: 'Pont fictif' }, { day: '2027-05-14', label: 'Autre fictif' }, { day: '2027-05-14', label: 'Pont fictif' }, { day: '2027-07-10T00:00:00', label: 'Fermeture fictive' }]);
  assert.equal(m.get('2027-05-14'), 'Pont fictif ; Autre fictif');
  assert.equal(m.get('2027-07-10'), 'Fermeture fictive');
  assert.equal(H.extraMap(null).size, 0);
  assert.equal(H.holidayWith('2027-05-14', m), 'Pont fictif ; Autre fictif');
  assert.equal(H.holidayWith('2027-12-25', m), 'Noël', 'le calcul passe avant l\'entrée manuelle');
  assert.equal(H.holidayWith('2027-05-15', m), undefined);
  assert.equal(H.holidayWith('2027-05-14'), undefined, 'sans fériés manuels');

  const calls = []; let fail = false;
  const rows = [{ day: '2027-05-14', label: 'Pont fictif' }, { day: '2029-01-10', label: 'Lointain fictif' }];
  const L = H.createExtra(async (a, b) => { calls.push([a, b]); if (fail) throw new Error('refusé'); return rows.filter((r) => r.day >= a && r.day <= b); });
  assert.equal(await L.ensure('2027-01-01', '2027-12-31'), true);
  assert.deepEqual(calls, [['2027-01-01', '2027-12-31']]);
  assert.equal(L.holidayOf('2027-05-14'), 'Pont fictif');
  assert.equal(L.holidayOf('2027-12-25'), 'Noël');
  assert.equal(await L.ensure('2027-03-01', '2027-04-01'), true);
  assert.equal(calls.length, 1, 'plage déjà couverte : aucun nouvel appel');
  // plage de 1466 jours : tranches de 801 jours au plus (p_to - p_from <= 800)
  calls.length = 0;
  assert.equal(await L.ensure('2028-01-01', '2031-12-31'), true);
  assert.ok(calls.length >= 2 && calls.every(([a, b]) => (Date.parse(b) - Date.parse(a)) / 864e5 <= 800), JSON.stringify(calls));
  assert.equal(calls[0][0], '2028-01-01'); assert.equal(calls.at(-1)[1], '2031-12-31');
  for (let i = 1; i < calls.length; i++) assert.equal(Date.parse(calls[i][0]) - Date.parse(calls[i - 1][1]), 864e5, 'tranches jointives');
  assert.equal(L.holidayOf('2029-01-10'), 'Lointain fictif');
  // marge autour de la plage demandée
  calls.length = 0;
  assert.equal(await L.ensure('2035-06-01', '2035-06-30', { pad: 100 }), true);
  assert.deepEqual(calls, [['2035-02-21', '2035-10-08']]);
  assert.equal(await L.ensure('2035-06-01', '2035-06-30'), true); assert.equal(calls.length, 1);
  // échec : false, état en échec, rien de mémorisé comme couvert, nouvel essai au prochain appel
  fail = true; calls.length = 0;
  assert.equal(await L.ensure('2040-01-01', '2040-12-31'), false);
  assert.equal(L.failed, true);
  assert.equal(L.has('2040-01-01', '2040-12-31'), false);
  assert.equal(L.holidayOf('2040-12-25'), 'Noël', 'le calcul reste disponible');
  fail = false;
  assert.equal(await L.ensure('2040-01-01', '2040-12-31'), true);
  assert.equal(L.failed, false);
  assert.equal(calls.length, 2);
  // lecture simple d'un seul jour
  const L2 = H.createExtra(async () => [{ day: '2027-05-14', label: 'Pont fictif' }]);
  await L2.ensure('2027-05-01', '2027-05-31');
  assert.equal(L2.holidayOf('2027-05-14'), 'Pont fictif');
});
