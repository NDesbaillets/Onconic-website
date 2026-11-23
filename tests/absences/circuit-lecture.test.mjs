// Circuit de validation en lecture pour les médecins cadres et « Mon circuit de validation » (migration 202611230001), PGlite, données fictives.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
const root = new URL('../../', import.meta.url);
const read = (p) => readFile(new URL(p, root), 'utf8');
const uid = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

// 1 admin, 2 direction, 3 cadre validateur Thoracique, 4 médecin Thoracique, 5 cadre sans l'outil Absences, 6 cadre Urologie (secrétaire 11),
// 7 cadre Urologie sans secrétaire, 11 secrétaire du cadre 6, 12 assistante sans l'outil, 13 médecin Urologie, 14 assistante avec l'outil mais sans lien,
// 15 à 30 : seize médecins (étape de groupe de plus de 12 personnes)
const PEOPLE = [[1, 'admin', []], [2, 'direction', []], [3, 'cadre', ['Thoracique']], [4, 'clinician', ['Thoracique']], [5, 'cadre', ['Thoracique']], [6, 'cadre', ['Urologie']], [7, 'cadre', ['Urologie']],
  [11, 'assistant', []], [12, 'assistant', []], [13, 'clinician', ['Urologie']], [14, 'assistant', []]];
for (let n = 15; n <= 30; n++) PEOPLE.push([n, 'clinician', ['Gynécologie']]);

async function mk() {
  const db = new PGlite();
  const as = async (n) => { await db.exec('reset role'); await db.query("select set_config('test.uid',$1,false)", [n ? uid(n) : '']); await db.exec('set role authenticated'); };
  const sup = () => db.exec('reset role');
  const rpc = async (name, args = []) => Object.values((await db.query(`select public.${name}(${args.map((_, i) => '$' + (i + 1)).join(',')})`, args)).rows[0])[0];
  const rows = async (sql, args = []) => (await db.query(sql, args)).rows;
  await db.exec(await read('tests/absences/fixture.sql'));
  await db.exec('alter table auth.users add column banned_until timestamptz;');
  await db.exec("alter table public.calendar_tokens add primary key (user_id); alter table public.calendar_tokens alter column token set default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');");
  for (const f of ['absences.sql', 'cadre_medecin.sql', 'cadre_validateur.sql', 'absences_validation.sql', 'absences_forms.sql', 'absences_cliniques_datees.sql', 'admin_direction.sql', 'absences_export.sql', 'absences_soldes.sql', 'absences_visibilite.sql', 'absences_preavis.sql', 'absences_vue_ensemble.sql'])
    await db.exec(await read('supabase/' + f));
  for (const f of ['202611110001_absence_hardening.sql', '202611120001_nurse_role.sql', '202611120002_assistant_default_tools.sql', '202611130001_securite_advisors.sql', '202611140001_absence_planning.sql', '202611160002_comptes_temporaires.sql', '202611170001_circuit_absences.sql'])
    await db.exec(await read('supabase/migrations/' + f));
  for (const [n, role, clinics] of PEOPLE) {
    await db.query('insert into auth.users(id,email) values($1,$2)', [uid(n), `cl${n}@example.com`]);
    await db.query('insert into profiles(id,full_name,role,institution,clinics,absence_validator) values($1,$2,$3,$4,$5,$6)', [uid(n), `Lecture ${n}`, role, 'CHUV', clinics, n === 3]);
  }
  await db.exec('reset role');
  await db.query("insert into absence_validators(clinic,user_id) values ('Thoracique',$1)", [uid(3)]);
  await db.query("insert into tool_access(user_id,tool,allowed) values ($1,'absences',false),($2,'absences',true)", [uid(5), uid(14)]);
  for (const f of ['202611180001_circuit_configurable.sql', '202611180002_agenda_ultragenda.sql', '202611230001_cliniques_hemato_tournus.sql']) {
    const m = await read('supabase/migrations/' + f);
    await db.exec(m); await db.exec(m);
  }
  await as(2);
  await rpc('admin_set_cadre_secretary', [uid(11), true, [uid(6)]]);
  await sup();
  return { db, as, sup, rpc, rows };
}

const PRE = { pos: 0, kind: 'preavis', label: 'Pré-avis de la direction', rule: 'all', blocking: false, active: true };
const CLIN = { pos: 10, col: 10, kind: 'clinique', label: 'Validateurs de clinique', rule: 'all', blocking: true, active: true };
const GRP = { pos: 20, col: 20, kind: 'groupe', label: 'Médecins', rule: 'any', blocking: true, active: true, roles: ['clinician'], scope: 'all' };
const VISA = { pos: 30, col: 30, kind: 'visa', label: 'Visa de la direction', rule: 'any', blocking: true, active: true };
const D1 = ['2027-03-01', '2027-03-03'];

test('circuit en lecture pour les cadres et « Mon circuit »', async (st) => {
  const t = await mk();
  try {
    await t.as(2);
    await t.rpc('absence_circuit_save', [JSON.stringify([PRE, CLIN, GRP, VISA])]);
    const cad = Number(await t.rpc('absence_circuit_create', ['Circuit des cadres']));
    await t.rpc('absence_circuit_save', [JSON.stringify([PRE, { ...VISA, pos: 20, col: 20 }]), cad]);
    await t.rpc('absence_circuit_assign', [cad, 'member', [uid(13)]]);
    await t.sup();

    await st.test('can_view : direction, administration, cadre avec l\'outil, personne d\'autre', async () => {
      const exp = { 1: true, 2: true, 3: true, 6: true, 7: true, 5: false, 4: false, 11: false, 12: false, 14: false, 15: false };
      for (const [n, ok] of Object.entries(exp)) {
        await t.as(Number(n));
        if (ok) assert.ok(await t.rpc('absence_circuit_get'), 'get ' + n);
        else await assert.rejects(t.rpc('absence_circuit_get'), /Réservé/, 'get ' + n);
      }
    });
    await st.test('un cadre lit : get, list, who, overview, simulate d\'un circuit enregistré', async () => {
      await t.as(3);
      const g = await t.rpc('absence_circuit_get');
      assert.equal(g.steps.length, 4);
      assert.ok(g.steps.some((s) => s.kind === 'groupe'));
      assert.ok(Array.isArray(g.log));
      assert.equal((await t.rpc('absence_circuit_get', [cad])).circuit.name, 'Circuit des cadres');
      const list = await t.rpc('absence_circuit_list');
      assert.deepEqual(list.map((c) => c.name), ['Circuit général', 'Circuit des cadres']);
      assert.ok((await t.rpc('absence_circuit_who')).some((w) => w.id === uid(13) && w.circuit_name === 'Circuit des cadres'));
      const ov = await t.rpc('absence_circuit_overview');
      assert.ok(ov.circuits.length === 2 && Array.isArray(ov.warnings) && Array.isArray(ov.clinics));
      const sim = await t.rpc('absence_circuit_simulate', [uid(4), D1[0], D1[1]]);
      assert.equal(sim.member.id, uid(4));
      assert.equal(sim.circuit.name, 'Circuit général');
      assert.equal((await t.rpc('absence_circuit_simulate', [uid(13), D1[0], D1[1], 'congres', null, null])).circuit.name, 'Circuit des cadres');
      assert.equal((await t.rpc('absence_circuit_simulate', [uid(13), D1[0], D1[1], 'vacances', null, cad])).kind, 'vacances');
    });
    await st.test('un cadre ne simule pas un brouillon et ne modifie rien', async () => {
      await t.as(3);
      await assert.rejects(t.rpc('absence_circuit_simulate', [uid(4), D1[0], D1[1], 'vacances', JSON.stringify([PRE, CLIN, VISA]), null]), /Réservé à l'administration\./);
      await assert.rejects(t.rpc('absence_circuit_save', [JSON.stringify([PRE, CLIN, VISA])]), /Réservé/);
      await assert.rejects(t.rpc('absence_circuit_save', [JSON.stringify([PRE, CLIN, VISA]), cad]), /Réservé/);
      await assert.rejects(t.rpc('absence_circuit_create', ['Pirate']), /Réservé/);
      await assert.rejects(t.rpc('absence_circuit_create', ['Pirate', cad]), /Réservé/);
      await assert.rejects(t.rpc('absence_circuit_rename', [cad, 'Autre']), /Réservé/);
      await assert.rejects(t.rpc('absence_circuit_delete', [cad]), /Réservé/);
      await assert.rejects(t.rpc('absence_circuit_reorder', [[cad]]), /Réservé/);
      await assert.rejects(t.rpc('absence_circuit_assign', [cad, 'member', [uid(4)]]), /Réservé/);
      await assert.rejects(t.rpc('absence_circuit_assign_all', [cad, [uid(4)], [], []]), /Réservé/);
      await t.sup();
      assert.equal((await t.rows('select count(*)::int n from absence_circuits'))[0].n, 2);
      assert.equal((await t.rows('select count(*)::int n from absence_circuit_assignments'))[0].n, 1);
      assert.equal((await t.rows("select name from absence_circuits where id=$1", [cad]))[0].name, 'Circuit des cadres');
    });
    await st.test('refusés : médecin, cadre sans l\'outil, assistantes, anonyme', async () => {
      for (const n of [4, 5, 11, 12, 14, 15, 0]) {
        await t.as(n);
        for (const [fn, args] of [['absence_circuit_get', []], ['absence_circuit_list', []], ['absence_circuit_who', []], ['absence_circuit_overview', []],
          ['absence_circuit_simulate', [uid(4), D1[0], D1[1]]]])
          await assert.rejects(t.rpc(fn, args), /Réservé|permission denied|Accès refusé/, `${fn} ${n}`);
      }
    });
    await st.test('direction et administration : lecture, brouillon et écriture inchangés', async () => {
      for (const n of [1, 2]) {
        await t.as(n);
        assert.ok((await t.rpc('absence_circuit_simulate', [uid(4), D1[0], D1[1], 'vacances', JSON.stringify([PRE, CLIN, VISA]), null])).steps.length >= 3);
        assert.ok(await t.rpc('absence_circuit_overview'));
      }
      await t.as(2);
      await t.rpc('absence_circuit_rename', [cad, 'Circuit des cadres']);
    });

    await st.test('mon circuit : soi-même, jours ouvrables, motif', async () => {
      await t.as(4);
      const m = await t.rpc('absence_circuit_mine');
      assert.equal(m.member.id, uid(4));
      assert.equal(m.kind, 'vacances');
      assert.equal(m.days, 5);
      assert.equal(m.circuit.name, 'Circuit général');
      assert.equal(new Date(m.from + 'T12:00:00Z').getUTCDay(), 1, 'le lundi');
      assert.ok(m.from > new Date().toISOString().slice(0, 10));
      assert.equal(Number(await t.rpc('absence_workdays', [m.from, m.to])), 5);
      const m12 = await t.rpc('absence_circuit_mine', [null, 'congres', 12]);
      assert.equal(m12.kind, 'congres');
      assert.equal(Number(await t.rpc('absence_workdays', [m12.from, m12.to])), 12);
      assert.equal(m12.from, m.from);
      const m60 = await t.rpc('absence_circuit_mine', [null, 'autre', 60]);
      assert.equal(Number(await t.rpc('absence_workdays', [m60.from, m60.to])), 60);
      assert.equal((await t.rpc('absence_circuit_mine', [uid(4), 'vacances', 5])).member.id, uid(4));
      await assert.rejects(t.rpc('absence_circuit_mine', [null, 'vacances', 0]), /1 à 60/);
      await assert.rejects(t.rpc('absence_circuit_mine', [null, 'vacances', 61]), /1 à 60/);
      await assert.rejects(t.rpc('absence_circuit_mine', [null, 'voyage', 5]), /Motif inconnu/);
      await t.as(13);
      assert.equal((await t.rpc('absence_circuit_mine')).circuit.name, 'Circuit des cadres');
      assert.equal((await t.rpc('absence_circuit_mine')).resolved.reason, 'member');
    });
    await st.test('mon circuit : secrétaire, cadre, autres membres', async () => {
      await t.as(11);
      assert.equal((await t.rpc('absence_circuit_mine', [uid(6), 'vacances', 5])).member.id, uid(6));
      await assert.rejects(t.rpc('absence_circuit_mine', [uid(7)]), /Accès refusé/);
      await assert.rejects(t.rpc('absence_circuit_mine', [uid(4)]), /Accès refusé/);
      await t.as(14);
      await assert.rejects(t.rpc('absence_circuit_mine', [uid(6)]), /Accès refusé/);
      await t.as(4);
      await assert.rejects(t.rpc('absence_circuit_mine', [uid(3)]), /Accès refusé/);
      await assert.rejects(t.rpc('absence_circuit_mine', [uid(13)]), /Accès refusé/);
      await t.as(3);
      assert.equal((await t.rpc('absence_circuit_mine', [uid(4)])).member.id, uid(4));
      await assert.rejects(t.rpc('absence_circuit_mine', [uid(99)]), /introuvable/);
      for (const n of [12, 5, 0]) { await t.as(n); await assert.rejects(t.rpc('absence_circuit_mine'), /Accès refusé|permission denied/, 'mine ' + n); }
    });
    await st.test('mon circuit : douze noms au plus, sans identifiants, hors administration', async () => {
      await t.as(4);
      const m = await t.rpc('absence_circuit_mine');
      const g = m.steps.find((s) => s.kind === 'groupe');
      assert.equal(g.people.length, 12);
      assert.equal(g.more, 5); // 17 médecins (4, 13, 15 à 30), 12 affichés
      assert.ok(g.people.every((p) => Object.keys(p).join() === 'name' && typeof p.name === 'string'));
      const col = m.columns.flatMap((c) => c.steps).find((s) => s.kind === 'groupe');
      assert.equal(col.people.length, 12); assert.equal(col.more, g.more);
      const cl = m.steps.find((s) => s.kind === 'clinique');
      assert.equal(cl.more, 0);
      assert.ok(!('admin_override' in m));
      assert.ok(!JSON.stringify(m.steps).includes(uid(15)) && !JSON.stringify(m.columns).includes(uid(15)));
      await t.as(3); // un cadre a la même vue réduite
      assert.ok(!('admin_override' in await t.rpc('absence_circuit_mine')));
      assert.equal((await t.rpc('absence_circuit_mine')).steps.find((s) => s.kind === 'groupe').people.length, 12);
      await t.as(1);
      const a = await t.rpc('absence_circuit_mine', [uid(4)]);
      const ga = a.steps.find((s) => s.kind === 'groupe');
      assert.equal(ga.people.length, 17); assert.ok(ga.people[0].id); assert.ok('admin_override' in a);
    });
    await st.test('droits : fonctions internes fermées, interface réservée aux utilisateurs connectés', async () => {
      await t.sup();
      const priv = async (r, f) => (await t.rows('select has_function_privilege($1, $2, \'execute\') v', [r, f]))[0].v;
      for (const f of ['absence_circuit_can_view()', 'absence_circuit_simulate_core(uuid,date,date,text,jsonb,bigint)', 'absence_circuit_trim(jsonb,int)', 'absence_circuit_trim_step(jsonb,int)'])
        for (const r of ['anon', 'authenticated']) assert.equal(await priv(r, 'public.' + f), false, `${f} ${r}`);
      for (const f of ['absence_circuit_mine(uuid,text,int)', 'absence_circuit_get(bigint)', 'absence_circuit_list()', 'absence_circuit_who()', 'absence_circuit_overview()', 'absence_circuit_simulate(uuid,date,date,text,jsonb,bigint)']) {
        assert.equal(await priv('anon', 'public.' + f), false, f + ' anon');
        assert.equal(await priv('authenticated', 'public.' + f), true, f + ' authenticated');
      }
      assert.equal((await t.rows("select count(*)::int n from pg_proc where proname in ('absence_circuit_simulate', 'absence_circuit_mine', 'absence_circuit_simulate_core')"))[0].n, 3);
      await t.as(4);
      await assert.rejects(t.db.query('select public.absence_circuit_simulate_core($1,$2,$3)', [uid(4), D1[0], D1[1]]), /permission denied|does not exist/);
    });
  } finally { await t.db.close(); }
});
