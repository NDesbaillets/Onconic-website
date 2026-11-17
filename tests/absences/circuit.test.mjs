// Circuit de validation des absences (migration 202611170001), en PGlite, données fictives.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
const root = new URL('../../', import.meta.url);
const read = (p) => readFile(new URL(p, root), 'utf8');
const uid = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

test('circuit des absences : droits, aperçu, simulateur', async (t) => {
  const db = new PGlite();
  const as = async (n) => { await db.exec('reset role'); await db.query("select set_config('test.uid',$1,false)", [n ? uid(n) : '']); await db.exec('set role authenticated'); };
  const one = async (sql, args = []) => Object.values((await db.query(sql, args)).rows[0])[0];
  try {
    await db.exec(await read('tests/absences/fixture.sql'));
    await db.exec('alter table auth.users add column banned_until timestamptz;');
    await db.exec("alter table public.calendar_tokens add primary key (user_id); alter table public.calendar_tokens alter column token set default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');");
    for (const f of ['absences.sql', 'cadre_medecin.sql', 'cadre_validateur.sql', 'absences_validation.sql', 'absences_forms.sql', 'absences_cliniques_datees.sql', 'admin_direction.sql', 'absences_export.sql', 'absences_soldes.sql', 'absences_visibilite.sql', 'absences_preavis.sql', 'absences_vue_ensemble.sql'])
      await db.exec(await read('supabase/' + f));
    for (const f of ['202611110001_absence_hardening.sql', '202611120001_nurse_role.sql', '202611120002_assistant_default_tools.sql', '202611130001_securite_advisors.sql'])
      await db.exec(await read('supabase/migrations/' + f));
    const mig = await read('supabase/migrations/202611170001_circuit_absences.sql');
    await db.exec(mig); await db.exec(mig);
    // 1 admin, 2 direction, 3 cadre validateur Thoracique, 4 médecin Thoracique, 5 cadre non validateur, 6 médecin Gynécologie,
    // 7 cdc, 8 cadre désigné pour Urologie mais case décochée, 9 médecin Urologie
    const people = [[1, 'admin', null], [2, 'direction', null], [3, 'cadre', null], [4, 'clinician', ['Thoracique']], [5, 'cadre', null], [6, 'clinician', ['Gynécologie']], [7, 'cdc', ['Thoracique']], [8, 'cadre', null], [9, 'clinician', ['Urologie']]];
    for (const [n, role, clinics] of people) {
      await db.query('insert into auth.users(id,email) values($1,$2)', [uid(n), `c${n}@example.invalid`]);
      await db.query('insert into profiles(id,full_name,role,institution,clinics) values($1,$2,$3,$4,$5)', [uid(n), `Circuit ${n}`, role, 'CHUV', clinics || '{}']);
    }
    await db.exec('reset role');
    await db.query('update profiles set absence_validator=true where id=$1', [uid(3)]);
    await db.query("insert into absence_validators(clinic,user_id) values ('Thoracique',$1),('Urologie',$2)", [uid(3), uid(8)]);
    const F = '2026-11-23', T = '2026-11-27';
    const sim = async (n, from = F, to = T) => one('select absence_circuit_simulate($1,$2,$3)', [uid(n), from, to]);
    const step = (r, k) => r.steps.find((s) => s.key === k);
    const names = (s) => s.people.map((p) => p.name);

    await t.test('droits', async () => {
      for (const n of [4, 7, 5, 3]) {
        await as(n);
        await assert.rejects(db.query('select absence_circuit_overview()'), /Réservé/, 'overview ' + n);
        await assert.rejects(db.query('select absence_circuit_simulate($1,$2,$3)', [uid(4), F, T]), /Réservé/, 'simulate ' + n);
      }
      for (const n of [1, 2]) { await as(n); assert.ok(await one('select absence_circuit_overview()')); }
    });
    await t.test('aperçu', async () => {
      await as(2); const o = await one('select absence_circuit_overview()');
      const th = o.clinics.find((c) => c.clinic === 'Thoracique');
      assert.equal(th.goes_to, 'validators'); assert.equal(th.active_count, 1);
      assert.equal(th.validators[0].name, 'Circuit 3'); assert.equal(th.validators[0].active, true);
      const gy = o.clinics.find((c) => c.clinic === 'Gynécologie');
      assert.equal(gy.goes_to, 'direction'); assert.equal(gy.active_count, 0);
      assert.ok(o.warnings.some((w) => w.startsWith('Clinique Gynécologie : aucun validateur actif')));
      const uro = o.clinics.find((c) => c.clinic === 'Urologie');
      assert.equal(uro.validators[0].active, false); assert.equal(uro.validators[0].reason, 'case Validateur décochée');
      assert.ok(o.warnings.some((w) => w.includes('Circuit 8') && w.includes('case Validateur décochée')));
      assert.equal(o.visa_fallback_admins, false); assert.equal(o.direction[0].has_tool, true);
      assert.equal(o.admins.length, 1); assert.ok(o.members.length >= 9);
      assert.ok(!o.warnings.some((w) => w.startsWith('Visa et pré-avis')));
    });
    await t.test('simulation : médecin avec cadre validateur', async () => {
      await as(1); const r = await sim(4);
      assert.deepEqual(r.clinics, ['Thoracique']);
      assert.deepEqual(names(step(r, 'clinique')), ['Circuit 3']);
      assert.deepEqual(names(step(r, 'visa')), ['Circuit 2']);
      assert.deepEqual(names(step(r, 'preavis')), ['Circuit 2']);
      assert.equal(step(r, 'preavis').blocking, false); assert.equal(step(r, 'clinique').blocking, true);
      assert.equal(r.self_excluded, false); assert.match(r.admin_override, /administrateur/);
      assert.deepEqual(r.steps.map((s) => s.key), ['preavis', 'clinique', 'visa']);
    });
    await t.test('simulation : cadre validateur de sa propre clinique', async () => {
      await db.exec('reset role'); await db.query("update profiles set clinics='{Thoracique}' where id=$1", [uid(3)]);
      await db.query("insert into member_clinic_changes(user_id,valid_from,clinics) values ($1,'2026-01-01','{Thoracique}')", [uid(3)]);
      await as(1); const r = await sim(3);
      if (r.clinics.includes('Thoracique')) { assert.equal(r.self_excluded, true); assert.ok(!names(step(r, 'clinique')).includes('Circuit 3')); }
      else assert.fail('le cadre devrait être rattaché à Thoracique : ' + JSON.stringify(r.clinics));
    });
    await t.test('simulation : clinique sans validateur', async () => {
      await as(1); const r = await sim(6);
      assert.deepEqual(step(r, 'clinique').people, []);
      assert.match(step(r, 'clinique').note, /étape sautée/);
      assert.deepEqual(names(step(r, 'visa')), ['Circuit 2']);
      assert.deepEqual(step(r, 'preavis').people, []);
      assert.equal(step(r, 'preavis').note, 'Aucun pré-avis : la direction reçoit déjà la demande au visa');
    });
    await t.test('membre désigné mais décoché : non exclu', async () => {
      await db.exec('reset role'); await db.query("update profiles set clinics='{Urologie}' where id=$1", [uid(8)]);
      await as(1); const r = await sim(8);
      assert.deepEqual(r.clinics, ['Urologie']); assert.equal(r.self_excluded, false);
    });
    await t.test('cas daté : changement de clinique futur', async () => {
      await db.exec('reset role');
      await db.query("insert into member_clinic_changes(user_id,valid_from,clinics) values ($1,'2026-12-01','{Thoracique}')", [uid(6)]);
      await as(1);
      const before = await sim(6, '2026-11-23', '2026-11-27'), after = await sim(6, '2026-12-07', '2026-12-11');
      assert.deepEqual(step(before, 'clinique').people, []);
      assert.deepEqual(names(step(after, 'clinique')), ['Circuit 3']);
      await db.exec('reset role'); await db.query('delete from member_clinic_changes where user_id=$1', [uid(6)]);
    });
    await t.test('dates inversées et membre inconnu', async () => {
      await as(1);
      await assert.rejects(db.query('select absence_circuit_simulate($1,$2,$3)', [uid(4), T, F]), /dates/);
      await assert.rejects(db.query('select absence_circuit_simulate($1,$2,$3)', [uid(99), F, T]), /introuvable/);
    });
    await t.test('sans membre direction : visa aux administrateurs', async () => {
      await db.exec('reset role'); await db.query("update profiles set role='clinician' where id=$1", [uid(2)]);
      await as(1);
      const o = await one('select absence_circuit_overview()');
      assert.equal(o.visa_fallback_admins, true);
      assert.ok(o.warnings.some((w) => w.startsWith('Visa et pré-avis : aucun membre direction')));
      const r = await sim(4);
      assert.deepEqual(names(step(r, 'visa')), ['Circuit 1']); assert.match(step(r, 'visa').note, /administrateurs/);
      assert.deepEqual(step(r, 'preavis').people, []); assert.equal(step(r, 'preavis').note, 'Aucun pré-avis demandé');
    });
  } finally { await db.close(); }
});
