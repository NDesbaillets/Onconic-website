// Planning administratif (migration 202611160003), en PGlite, données fictives.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
const root = new URL('../../', import.meta.url);
const read = (p) => readFile(new URL(p, root), 'utf8');
const uid = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

test('planning administratif : droits, masquage, écriture', async (t) => {
  const db = new PGlite();
  const as = async (n) => { await db.exec('reset role'); await db.query("select set_config('test.uid',$1,false)", [n ? uid(n) : '']); await db.exec('set role authenticated'); };
  const one = async (sql, args = []) => Object.values((await db.query(sql, args)).rows[0])[0];
  try {
    await db.exec(await read('tests/absences/fixture.sql'));
    await db.exec('alter table auth.users add column banned_until timestamptz;');
    for (const f of ['absences.sql', 'cadre_medecin.sql', 'cadre_validateur.sql', 'absences_validation.sql', 'absences_forms.sql', 'absences_cliniques_datees.sql', 'admin_direction.sql', 'absences_export.sql', 'absences_soldes.sql', 'absences_visibilite.sql', 'absences_preavis.sql', 'absences_vue_ensemble.sql'])
      await db.exec(await read('supabase/' + f));
    for (const f of ['202611110001_absence_hardening.sql', '202611120001_nurse_role.sql', '202611120002_assistant_default_tools.sql', '202611130001_securite_advisors.sql', '202611160002_comptes_temporaires.sql'])
      await db.exec(await read('supabase/migrations/' + f));
    const mig = await read('supabase/migrations/202611160003_planning_admin.sql');
    await db.exec(mig); await db.exec(mig);
    // 1 admin, 2 direction, 3 assistante cadre admin, 4 assistante, 5 médecin, 6 médecin hors CHUV, 7 en attente
    for (const [n, role, inst] of [[1, 'admin', 'CHUV'], [2, 'direction', 'CHUV'], [3, 'assistant', 'CHUV'], [4, 'assistant', 'CHUV'], [5, 'clinician', 'CHUV'], [6, 'clinician', null], [7, 'member', 'CHUV']]) {
      await db.query('insert into auth.users(id,email) values($1,$2)', [uid(n), `t${n}@example.invalid`]);
      await db.query('insert into profiles(id,full_name,role,institution) values($1,$2,$3,$4)', [uid(n), `Test ${n}`, role, inst]);
    }
    await as(2); await db.query('select admin_set_admin_lead($1,true)', [uid(3)]);
    let a, b;

    await t.test('accès : outil planning pour les membres CHUV, édition pour les cadres administratifs', async () => {
      for (const [n, view, edit] of [[1, true, true], [2, true, true], [3, true, true], [4, true, false], [5, true, false], [6, false, false], [7, false, false]]) {
        await as(n);
        assert.equal((await one('select my_tools()')).includes('planning'), view, 'vue ' + n);
        assert.equal(await one('select can_edit_planning()'), edit, 'édition ' + n);
      }
      await as(6); await assert.rejects(db.query("select plan_grid('2026-11-16','2026-11-20')"), /Réservé/);
    });
    await t.test('effectif, cellules, semaine type', async () => {
      await as(4); await assert.rejects(db.query("select plan_staff_save('{\"first_name\":\"A\",\"last_name\":\"B\"}')"), /Réservé/);
      await as(3);
      a = await one(`select plan_staff_save($1::jsonb)`, [JSON.stringify({ first_name: 'Léa', last_name: 'Fictive', team: 'AM', bloc: 1, pct: 80, off: [8, 9], user_id: uid(4), week: ['AM1','AM1','AM1','AM1','AM1','AM1','AM1','TT1','',''] })]);
      b = await one(`select plan_staff_save($1::jsonb)`, [JSON.stringify({ first_name: 'Noé', last_name: 'Temporaire', team: 'DESK', status: 'temporaire', start_date: '2026-11-18', end_date: '2026-11-20' })]);
      await assert.rejects(db.query(`select plan_staff_save($1::jsonb)`, [JSON.stringify({ first_name: 'X', last_name: 'Y', status: 'temporaire' })]), /check/);
      const n = await one('select plan_set_cells($1::jsonb)', [JSON.stringify([
        { s: a, d: '2026-11-16', h: 0, c: 'AM1' }, { s: a, d: '2026-11-16', h: 1, c: 'ML' }, { s: b, d: '2026-11-18', h: 0, c: 'DA1' }, { s: b, d: '2026-11-19', h: 0, c: 'V' }])]);
      assert.equal(n, 4);
      await assert.rejects(db.query('select plan_set_cells($1::jsonb)', [JSON.stringify([{ s: b, d: '2026-11-17', h: 0, c: 'DA1' }])]), /hors de la période/);
      await assert.rejects(db.query('select plan_set_cells($1::jsonb)', [JSON.stringify([{ s: a, d: '2026-11-21', h: 0, c: 'AM1' }])]), /jours ouvrables/);
      await assert.rejects(db.query('select plan_set_cells($1::jsonb)', [JSON.stringify([{ s: a, d: '2026-11-17', h: 0, c: 'ZZZ' }])]), /Code inconnu/);
      await db.query('select plan_set_cells($1::jsonb)', [JSON.stringify([{ s: b, d: '2026-11-19', h: 0, c: '' }])]);
      await db.exec('reset role');
      assert.equal(await one('select count(*)::int from plan_cells'), 3);
    });
    await t.test('lecture : motifs privés masqués sauf pour les éditeurs et la personne concernée', async () => {
      const cellOf = (g) => g.cells.find((c) => c[0] === a && c[2] === 1)[3];
      await as(5); let g = await one("select plan_grid('2026-11-16','2026-11-20')");
      assert.equal(g.editor, false); assert.equal(cellOf(g), 'ABS'); assert.equal(g.staff.find((s) => s.id === a).week, null, 'pas de semaine type pour les lecteurs');
      assert.equal(g.staff.find((s) => s.id === a).user_id, null);
      await as(4); g = await one("select plan_grid('2026-11-16','2026-11-20')");
      assert.equal(cellOf(g), 'ML', 'la personne voit son propre motif'); assert.equal(g.staff.find((s) => s.id === a).me, true);
      await as(3); g = await one("select plan_grid('2026-11-16','2026-11-20')");
      assert.equal(g.editor, true); assert.equal(cellOf(g), 'ML');
      g = await one("select plan_grid('2026-11-23','2026-11-27')");
      assert.ok(!g.staff.some((s) => s.id === b), 'temporaire hors période absent');
      assert.ok(g.codes.length >= 30 && g.coverage.length === 6);
    });
    await t.test('catalogue et couverture', async () => {
      await as(3);
      await db.query(`select plan_code_save('{"code":"rdv2","label":"Rendez-vous","bg":"#21c5ff"}')`);
      await db.exec('reset role'); assert.equal(await one("select bg from plan_codes where code='RDV2'"), '#21C5FF');
      await as(3);
      await assert.rejects(db.query(`select plan_code_save('{"code":"bad code"}')`), /check/);
      await assert.rejects(db.query(`select plan_code_save('{"code":"ABS"}')`), /réservé/);
      await db.query(`select plan_coverage_save('[{"label":"AM","codes":["AM1"],"min":3}]')`);
      await assert.rejects(db.query(`select plan_coverage_save('[{"label":"","codes":[],"min":3}]')`), /invalide/);
      await as(5); await assert.rejects(db.query(`select plan_code_save('{"code":"X1"}')`), /Réservé/);
    });
    await t.test('tables inaccessibles directement', async () => {
      for (const n of [3, 5]) {
        await as(n);
        for (const tb of ['plan_cells', 'plan_staff', 'plan_codes', 'plan_settings']) await assert.rejects(db.query(`select * from ${tb}`), /permission denied/, tb);
      }
    });
    await t.test('fin d\'accès et rôle en attente : plus de planning', async () => {
      await as(1); await db.query('select admin_set_access_until($1, ch_date()-1)', [uid(4)]);
      await as(4); assert.ok(!(await one('select my_tools()')).includes('planning'));
      await as(7); await assert.rejects(db.query("select plan_grid('2026-11-16','2026-11-20')"), /Réservé/);
    });
  } finally { await db.close(); }
});
