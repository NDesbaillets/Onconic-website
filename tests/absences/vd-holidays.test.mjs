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
