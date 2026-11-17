// Circuit à colonnes simultanées, étapes « direction » et « groupe » (migration 202611180001, phase 2D), en PGlite, données fictives.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
const root = new URL('../../', import.meta.url);
const read = (p) => readFile(new URL(p, root), 'utf8');
const uid = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

// 1 admin, 2 direction, 3 cadre validateur Thoracique, 4 médecin Thoracique, 5 cadre validateur Thoracique, 6 médecin Gynécologie (sans validateur),
// 7 cheffe de service (cadre, sans clinique), 8 médecin Thoracique et Urologie, 9 cadre validateur Urologie,
// 10 et 11 CDC Thoracique, 12 CDC Urologie, 13 CDC Gynécologie
const PEOPLE = [[1, 'admin', []], [2, 'direction', []], [3, 'cadre', ['Thoracique']], [4, 'clinician', ['Thoracique']], [5, 'cadre', ['Thoracique']], [6, 'clinician', ['Gynécologie']],
  [7, 'cadre', []], [8, 'clinician', ['Thoracique', 'Urologie']], [9, 'cadre', ['Urologie']],
  [10, 'cdc', ['Thoracique']], [11, 'cdc', ['Thoracique']], [12, 'cdc', ['Urologie']], [13, 'cdc', ['Gynécologie']]];
const D1 = ['2027-03-01', '2027-03-03'];
const D2 = ['2027-04-05', '2027-04-07'];

async function mk({ old = false } = {}) {
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
  for (const f of ['202611110001_absence_hardening.sql', '202611120001_nurse_role.sql', '202611120002_assistant_default_tools.sql', '202611130001_securite_advisors.sql', '202611140001_absence_planning.sql'])
    await db.exec(await read('supabase/migrations/' + f));
  await db.exec(await read('supabase/migrations/202611170001_circuit_absences.sql'));
  for (const [n, role, clinics] of PEOPLE) {
    await db.query('insert into auth.users(id,email) values($1,$2)', [uid(n), `cc${n}@example.com`]);
    await db.query('insert into profiles(id,full_name,role,institution,clinics,absence_validator) values($1,$2,$3,$4,$5,$6)', [uid(n), `Circuit ${n}`, role, 'CHUV', clinics, [3, 5, 9].includes(n)]);
  }
  await db.exec('reset role');
  await db.query("insert into absence_validators(clinic,user_id) values ('Thoracique',$1),('Thoracique',$2),('Urologie',$3)", [uid(3), uid(5), uid(9)]);
  const mig = await read('supabase/migrations/202611180001_circuit_configurable.sql');
  const migrate = async () => { await db.exec(mig); };
  if (old) await db.exec(await read('tests/absences/fixtures/circuit_v2c.sql'));
  else { await migrate(); await migrate(); }
  const request = async (n, [from, to], kind = 'vacances') => { await as(n); const id = (await rpc('absence_request', [kind, null, from, to])).id; await rpc('absence_submit'); return id; };
  const info = async (id) => { await sup(); return (await rows('select stage, status, circuit, direction_by from absences where id=$1', [id]))[0]; };
  const stage = async (id) => (await info(id)).stage;
  const status = async (id) => (await info(id)).status;
  const outbox = async (kind) => { await sup(); return rows('select recipient, absence_ids, payload from absence_outbox where kind=$1 order by id', [kind]); };
  const pending = async (id) => { await sup(); return (await rows("select step, validator_id, decision from absence_approvals where absence_id=$1 order by step, validator_id", [id])).map((r) => [r.step, r.validator_id, r.decision]); };
  const save = async (st) => { await as(2); return rpc('absence_circuit_save', [JSON.stringify(st)]); };
  const decide = async (n, id, ok = true, c = null) => { await as(n); return rpc('absence_decide', [id, ok, c]); };
  return { db, as, sup, rpc, rows, request, info, stage, status, outbox, pending, save, decide, migrate };
}

const PRE = { pos: 0, kind: 'preavis', label: 'Pré-avis de la direction', rule: 'all', blocking: false, active: true };
const CLIN = (col, pos) => ({ pos, col, kind: 'clinique', label: 'Validateurs de clinique', rule: 'all', blocking: true, active: true });
const VISA = (col, pos) => ({ pos, col, kind: 'visa', label: 'Visa de la direction', rule: 'any', blocking: true, active: true });
const DIR = (col, pos, label, over = {}) => ({ pos, col, kind: 'direction', label, rule: 'any', blocking: true, active: true, ...over });
const GRP = (col, pos, label, roles, scope, rule = 'any', over = {}) => ({ pos, col, kind: 'groupe', label, rule, blocking: true, active: true, roles, scope, ...over });
const sorted = (a) => [...a].sort();

test('1. défaut identique, y compris la reprise d\'un instantané sans col', async () => {
  const t = await mk();
  try {
    await t.sup();
    const def = await t.rows('select pos, col, kind from absence_circuit_steps order by pos');
    assert.deepEqual(def.map((r) => [r.pos, r.col, r.kind]), [[0, 0, 'preavis'], [10, 10, 'clinique'], [20, 20, 'visa'], [30, 30, 'personnes']]);
    const id = await t.request(4, D1);
    assert.equal(await t.stage(id), 10);
    assert.deepEqual(sorted((await t.outbox('to_validate')).map((r) => r.recipient)), sorted([uid(3), uid(5)]));
    // instantané ancien : ni col ni stage_at
    await t.sup();
    await t.db.exec("update absences set stage_at = null, circuit = (select jsonb_agg(e - 'col') from jsonb_array_elements(circuit) e)");
    assert.ok((await t.info(id)).circuit.every((e) => !('col' in e)));
    await t.decide(3, id); assert.equal(await t.stage(id), 10);
    await t.decide(5, id); assert.equal(await t.stage(id), 20);
    assert.deepEqual((await t.outbox('to_direction')).map((r) => r.recipient), [uid(2)]);
    await t.as(4);
    const l = (await t.rows('select to_jsonb(r) j from public.absence_list() r')).map((x) => x.j).find((x) => x.id === id);
    assert.equal(l.stage, 2); assert.deepEqual(l.circuit.map((e) => [e.col, !!e.current]), [[10, false], [20, true]]);
    await t.as(2);
    const v = await t.rows('select step_kind, step_label, steps from absence_to_validate()');
    assert.deepEqual(v.map((r) => [r.step_kind, r.step_label]), [['visa', 'Visa de la direction']]);
    assert.deepEqual(v[0].steps.map((s) => [s.kind, s.mine]), [['visa', true]]);
    assert.equal(await t.rpc('absence_decide', [id, true, null]), 'approved');
    // sans validateur de clinique : directement au visa
    const g = await t.request(6, D1);
    assert.equal(await t.stage(g), 20);
  } finally { await t.db.close(); }
});

test('2. colonne parallèle clinique et direction (any) : la demande n\'avance qu\'après les deux ; un refus de la direction refuse', async () => {
  const t = await mk();
  try {
    await t.save([PRE, CLIN(10, 10), DIR(10, 20, 'Avis de la direction'), VISA(20, 30)]);
    const id = await t.request(4, D1);
    assert.equal(await t.stage(id), 10);
    assert.deepEqual(await t.pending(id), [[10, uid(3), 'pending'], [10, uid(5), 'pending'], [20, uid(2), 'pending']]);
    assert.deepEqual(sorted((await t.outbox('to_validate')).map((r) => r.recipient)), sorted([uid(2), uid(3), uid(5)]));
    // la direction d'abord : la colonne attend encore la clinique
    assert.equal(await t.decide(2, id), 'requested'); assert.equal(await t.stage(id), 10);
    await t.decide(3, id); assert.equal(await t.stage(id), 10);
    await t.decide(5, id); assert.equal(await t.stage(id), 20);
    assert.equal(await t.decide(2, id), 'approved');
    // refus de la direction dans la colonne parallèle
    const id2 = await t.request(4, D2);
    await t.decide(3, id2);
    await assert.rejects(t.decide(2, id2, false), /commentaire/);
    assert.equal(await t.decide(2, id2, false, 'Période chargée'), 'rejected');
    assert.equal(await t.status(id2), 'rejected');
    // étapes de la colonne exposées, mine seulement pour qui attend
    const id3 = await t.request(8, ['2027-05-03', '2027-05-04']);
    await t.as(5);
    const v = await t.rows('select step_kind, step_label, steps from absence_to_validate()');
    assert.equal(v.length, 1);
    assert.equal(v[0].step_label, 'Validateurs de clinique + Avis de la direction'); assert.equal(v[0].step_kind, 'clinique');
    assert.deepEqual(v[0].steps.map((s) => [s.kind, s.mine]), [['clinique', true], ['direction', false]]);
    assert.equal(id3 > 0, true);
  } finally { await t.db.close(); }
});

test('3. groupe « cdc » : portée clinique (clinique du demandeur) ou tous', async () => {
  const t = await mk();
  try {
    await t.save([PRE, GRP(10, 10, 'CDC de la clinique', ['cdc'], 'clinic'), VISA(20, 20)]);
    const id = await t.request(4, D1);
    assert.equal(await t.stage(id), 10);
    assert.deepEqual((await t.pending(id)).map((r) => r[1]), [uid(10), uid(11)]);
    assert.deepEqual(sorted((await t.outbox('to_validate')).map((r) => r.recipient)), sorted([uid(10), uid(11)]));
    await t.sup(); assert.equal((await t.rows("select public.absence_step_col('{\"pos\":7}') c"))[0].c, 7);
    await t.save([PRE, GRP(10, 10, 'Tous les CDC', ['cdc'], 'all'), VISA(20, 20)]);
    const id2 = await t.request(4, D2);
    assert.deepEqual((await t.pending(id2)).map((r) => r[1]), [uid(10), uid(11), uid(12), uid(13)]);
    // le demandeur lui-même est exclu : un CDC demande, les autres CDC valident
    const id3 = await t.request(10, ['2027-06-01', '2027-06-02']);
    assert.deepEqual((await t.pending(id3)).map((r) => r[1]), [uid(11), uid(12), uid(13)]);
    // simulation : colonnes avec personnes
    await t.as(1);
    const sim = await t.rpc('absence_circuit_simulate', [uid(4), D1[0], D1[1]]);
    const col = sim.columns.find((c) => c.col === 10);
    assert.deepEqual(col.steps[0].people.map((p) => p.id).sort(), sorted([uid(12), uid(13), uid(11), uid(10)]));
    assert.ok(sim.steps.every((s) => 'col' in s));
  } finally { await t.db.close(); }
});

test('4. groupe : règle all contre any', async () => {
  const t = await mk();
  try {
    await t.save([PRE, GRP(10, 10, 'CDC (tous)', ['cdc'], 'clinic', 'all'), VISA(20, 20)]);
    const a = await t.request(4, D1);
    await t.decide(10, a); assert.equal(await t.stage(a), 10);
    await t.decide(11, a); assert.equal(await t.stage(a), 20);
    await t.save([PRE, GRP(10, 10, 'CDC (un seul)', ['cdc'], 'clinic', 'any'), VISA(20, 20)]);
    const b = await t.request(4, D2);
    await t.decide(11, b); assert.equal(await t.stage(b), 20);
    assert.deepEqual(await t.pending(b), [[10, uid(10), 'skipped'], [10, uid(11), 'approved']]);
    // un refus d'un seul membre du groupe refuse la demande (règle all)
    await t.save([PRE, GRP(10, 10, 'CDC (tous)', ['cdc'], 'clinic', 'all'), VISA(20, 20)]);
    const c = await t.request(4, ['2027-06-01', '2027-06-02']);
    assert.equal(await t.decide(10, c, false, 'Pas possible'), 'rejected');
    // plus de 200 personnes : avertissement dans la vue d'ensemble, troncature déterministe
    await t.sup();
    await t.db.exec(`insert into auth.users(id,email) select ('10000000-0000-0000-0000-' || lpad(g::text, 12, '0'))::uuid, 'bulk' || g || '@example.com' from generate_series(1, 210) g;
      insert into profiles(id,full_name,role,institution,clinics) select ('10000000-0000-0000-0000-' || lpad(g::text, 12, '0'))::uuid, 'Bulk ' || g, 'clinician', 'CHUV', '{}' from generate_series(1, 210) g;`);
    await t.save([PRE, CLIN(10, 10), GRP(10, 20, 'Tous les médecins', ['clinician'], 'all'), VISA(20, 30)]);
    await t.sup();
    const n = (await t.rows("select cardinality(public.absence_step_people_for($1, '2027-03-01', '2027-03-03', '{\"kind\":\"groupe\",\"roles\":[\"clinician\"],\"scope\":\"all\"}'::jsonb)) n", [uid(4)]))[0].n;
    assert.equal(n, 200);
    await t.as(1);
    const ov = await t.rpc('absence_circuit_overview');
    assert.ok(ov.warnings.some((w) => /Tous les médecins.*plus de 200/.test(w)), 'avertissement de troncature');
  } finally { await t.db.close(); }
});

test('5. deux étapes direction dans des colonnes différentes, plus le visa : ordre et PDF extra', async () => {
  const t = await mk();
  try {
    await t.save([PRE, DIR(10, 10, 'Direction 1'), DIR(20, 20, 'Direction 2', { pdf_slot: 'chef_service' }), VISA(30, 30)]);
    const id = await t.request(4, D1);
    assert.equal(await t.stage(id), 10);
    assert.deepEqual(await t.pending(id), [[10, uid(2), 'pending']]);
    await t.decide(2, id); assert.equal(await t.stage(id), 20);
    assert.deepEqual(await t.pending(id), [[10, uid(2), 'approved'], [20, uid(2), 'pending']]);
    await t.decide(2, id); assert.equal(await t.stage(id), 30);
    assert.equal(await t.status(id), 'requested');
    assert.equal(await t.decide(2, id), 'approved');
    await t.sup();
    const doc = (await t.rows('select data from absence_documents order by id desc limit 1'))[0].data;
    assert.deepEqual(doc.extra.map((x) => [x.label, x.name, x.slot]), [['Direction 1', 'Circuit 2', null], ['Direction 2', 'Circuit 2', 'chef_service']]);
    assert.deepEqual(doc.signers, []);
    assert.equal(doc.direction.name, 'Circuit 2');
  } finally { await t.db.close(); }
});

test('6. même personne dans deux étapes d\'une même colonne : un seul message, une seule décision', async () => {
  const t = await mk();
  try {
    // à l'ouverture (envoi) : la cheffe figure dans la clinique et dans une étape « personnes »
    await t.save([PRE, CLIN(10, 10), { pos: 20, col: 10, kind: 'personnes', label: 'Cadre désigné', rule: 'any', blocking: true, active: true, persons: [uid(3)] }, VISA(20, 30)]);
    const id = await t.request(4, D1);
    assert.deepEqual(sorted((await t.outbox('to_validate')).map((r) => r.recipient)), sorted([uid(3), uid(5)]));
    await t.decide(3, id);
    assert.deepEqual(await t.pending(id), [[10, uid(3), 'approved'], [10, uid(5), 'pending'], [20, uid(3), 'approved']]);
    assert.equal(await t.stage(id), 10);
    await t.decide(5, id); assert.equal(await t.stage(id), 20);
    await assert.rejects(t.decide(3, id), /42501|attend le visa/);
    // à l'arrivée dans la colonne (avance) : deux étapes direction, un seul message
    await t.save([PRE, CLIN(10, 10), DIR(20, 20, 'Direction A'), DIR(20, 30, 'Direction B', { rule: 'all' }), VISA(30, 40)]);
    const id2 = await t.request(4, D2);
    await t.decide(3, id2); await t.decide(5, id2);
    assert.equal(await t.stage(id2), 20);
    const m = (await t.outbox('to_validate')).filter((r) => r.recipient === uid(2) && r.absence_ids.includes(Number(id2)));
    assert.equal(m.length, 1);
    await t.decide(2, id2);
    assert.deepEqual((await t.pending(id2)).filter((r) => r[1] === uid(2)), [[20, uid(2), 'approved'], [30, uid(2), 'approved']]);
    assert.equal(await t.stage(id2), 30);
  } finally { await t.db.close(); }
});

test('7. étape consultative dans une colonne : avis demandé, la colonne ne l\'attend pas', async () => {
  const t = await mk();
  try {
    await t.save([PRE, CLIN(10, 10), { pos: 20, col: 10, kind: 'personnes', label: 'Avis de la cheffe', rule: 'any', blocking: false, active: true, persons: [uid(7)] }, VISA(20, 30)]);
    const id = await t.request(4, D1);
    const op = (await t.outbox('to_opinion')).filter((r) => r.recipient === uid(7));
    assert.equal(op.length, 1); assert.equal(op[0].payload.step_label, 'Avis de la cheffe');
    assert.deepEqual(sorted((await t.outbox('to_validate')).map((r) => r.recipient)), sorted([uid(3), uid(5)]));
    await t.decide(3, id); await t.decide(5, id);
    assert.equal(await t.stage(id), 20);
    await t.as(7);
    assert.equal((await t.rows('select id from absence_opinion_todo()')).length, 1);
    await t.rpc('absence_opinion_set', [id, 'favorable', null]);
    await t.as(7); await assert.rejects(t.rpc('absence_decide', [id, true, null]), (e) => e.code === '42501');
  } finally { await t.db.close(); }
});

test('8. normalisation : renumérotation des colonnes et des positions, groupe sans rôle, deux visas', async () => {
  const t = await mk();
  try {
    const raw = [PRE, CLIN(7, 5), DIR(7, 6, 'Direction'), VISA(3, 100), GRP(3, 50, 'Groupe', ['cdc', 'cadre'], 'clinic')];
    await t.sup();
    const norm = (await t.rows('select public.absence_circuit_normalize($1::jsonb) n', [JSON.stringify(raw)]))[0].n;
    assert.deepEqual(norm.map((s) => [s.kind, s.col, s.pos]), [['preavis', 0, 0], ['groupe', 10, 10], ['visa', 10, 20], ['clinique', 20, 30], ['direction', 20, 40]]);
    assert.deepEqual(norm[1].roles, ['cadre', 'cdc']);
    // sans col : la position tient lieu de colonne
    const n2 = (await t.rows('select public.absence_circuit_normalize($1::jsonb) n', [JSON.stringify([{ pos: 3, kind: 'clinique', label: 'C', blocking: true }, { pos: 8, kind: 'visa', label: 'V' }])]))[0].n;
    assert.deepEqual(n2.map((s) => [s.col, s.pos]), [[10, 10], [20, 20]]);
    await assert.rejects(t.rpc('absence_circuit_normalize', [JSON.stringify([VISA(10, 10), GRP(10, 20, 'G', [], 'clinic')])]), /choisissez au moins un rôle/);
    await assert.rejects(t.rpc('absence_circuit_normalize', [JSON.stringify([VISA(10, 10), GRP(10, 20, 'G', ['cdc', 'member'], 'clinic')])]), /Rôle inconnu/);
    await assert.rejects(t.rpc('absence_circuit_normalize', [JSON.stringify([VISA(10, 10), GRP(10, 20, 'G', ['cdc'], 'monde')])]), /portée/);
    await assert.rejects(t.rpc('absence_circuit_normalize', [JSON.stringify([VISA(10, 10), VISA(20, 20)])]), /Une seule étape « Visa/);
    await assert.rejects(t.rpc('absence_circuit_normalize', [JSON.stringify([GRP(10, 10, 'G', ['cdc'], 'all', 'any', { blocking: false })])]), /au moins une étape active, bloquante/);
    // un groupe inactif sans rôle est accepté ; enregistré, relu avec col, roles et scope
    const saved = await t.save([PRE, CLIN(10, 10), VISA(20, 20), GRP(30, 30, 'Groupe en attente', [], 'all', 'any', { active: false })]);
    assert.deepEqual(saved.steps.map((s) => [s.kind, s.col, s.pos]), [['preavis', 0, 0], ['clinique', 10, 10], ['visa', 20, 20], ['groupe', 30, 30]]);
    assert.deepEqual([saved.steps[3].roles, saved.steps[3].scope], [[], 'all']);
    const ov = (await (async () => { await t.as(1); return t.rpc('absence_circuit_overview'); })());
    assert.ok(ov.steps.every((s) => 'col' in s && 'roles' in s && 'scope' in s));
  } finally { await t.db.close(); }
});

test('9. droits : un non-membre d\'une étape ne décide pas (42501)', async () => {
  const t = await mk();
  try {
    await t.save([PRE, GRP(10, 10, 'CDC de la clinique', ['cdc'], 'clinic'), VISA(20, 20)]);
    const id = await t.request(4, D1);
    const denied = (e) => e.code === '42501';
    for (const n of [12, 13, 3, 5, 6, 8]) await assert.rejects(t.decide(n, id), denied, `membre ${n}`);
    await assert.rejects(t.decide(2, id), denied, 'la direction n\'est pas encore au visa');
    await assert.rejects(t.decide(4, id), denied, 'le demandeur');
    await t.as(12); assert.equal((await t.rows('select id from absence_to_validate()')).length, 0);
    await t.as(10); assert.equal((await t.rows('select id from absence_to_validate()')).length, 1);
    await t.sup();
    assert.ok((await t.rows('select public.notification_kinds_for($1) k', [uid(10)]))[0].k.includes('to_validate'));
    assert.ok(!(await t.rows('select public.notification_kinds_for($1) k', [uid(8)]))[0].k.includes('to_validate'));
    // l'administrateur valide tout d'un coup
    assert.equal(await t.decide(1, id), 'approved');
  } finally { await t.db.close(); }
});

test('10. migration réexécutable par-dessus la version précédente (circuits alternatifs), avec une demande en cours', async () => {
  const t = await mk({ old: true });
  try {
    // version précédente : étapes sans col, instantané sans col, stage = pos
    await t.as(2);
    await t.rpc('absence_circuit_save', [JSON.stringify([{ pos: 0, kind: 'preavis', label: 'Pré-avis de la direction', rule: 'all', blocking: false, active: true },
      { pos: 10, kind: 'clinique', label: 'Validateurs de clinique', rule: 'all', blocking: true, active: true },
      { pos: 20, kind: 'visa', label: 'Visa de la direction', rule: 'any', blocking: true, active: true },
      { pos: 30, kind: 'personnes', label: 'Cheffe', rule: 'any', blocking: true, active: true, persons: [uid(7)] }])]);
    const id = await t.request(4, D1);
    await t.decide(3, id);
    assert.equal(await t.stage(id), 10);
    await t.sup();
    assert.ok(!(await t.rows("select 1 from information_schema.columns where table_name='absence_circuit_steps' and column_name='col'")).length);
    assert.ok((await t.info(id)).circuit.every((e) => !('col' in e)));
    await t.migrate(); await t.migrate();
    assert.deepEqual((await t.rows('select pos, col, kind from absence_circuit_steps order by pos')).map((r) => [r.pos, r.col, r.kind]), [[0, 0, 'preavis'], [10, 10, 'clinique'], [20, 20, 'visa'], [30, 30, 'personnes']]);
    await t.migrate();
    // la demande en cours continue avec son ancien instantané
    await t.decide(5, id); assert.equal(await t.stage(id), 20);
    await t.decide(2, id); assert.equal(await t.stage(id), 30);
    assert.equal(await t.decide(7, id), 'approved');
    // les nouveaux types sont admis par la contrainte remplacée
    await t.save([PRE, CLIN(10, 10), DIR(10, 20, 'Direction'), GRP(20, 30, 'Groupe', ['cdc'], 'all'), VISA(30, 40)]);
    await t.sup();
    assert.equal((await t.rows("select count(*)::int n from pg_constraint where conrelid='absence_circuit_steps'::regclass and conname='absence_circuit_steps_kind_check'"))[0].n, 1);
    assert.equal((await t.rows("select count(*)::int n from absence_circuit_steps where kind in ('direction','groupe')"))[0].n, 2);
  } finally { await t.db.close(); }
});

test('11. destinataire du visa aussi présent dans une autre étape de la colonne : « à valider » seulement, pas « à la direction »', async () => {
  const t = await mk();
  try {
    await t.save([PRE, CLIN(10, 10), { pos: 20, col: 20, kind: 'personnes', label: 'Direction désignée', rule: 'any', blocking: true, active: true, persons: [uid(2)] }, VISA(20, 30)]);
    const id = await t.request(4, D1);
    await t.decide(3, id); await t.decide(5, id);
    assert.equal(await t.stage(id), 20);
    const msgs = (k) => t.outbox(k).then((r) => r.filter((x) => x.recipient === uid(2) && x.absence_ids.includes(Number(id))));
    assert.equal((await msgs('to_validate')).length, 1);
    assert.equal((await msgs('to_direction')).length, 0);
    // contrôle : sans doublon de personne, le message « à la direction » part toujours
    await t.save([PRE, CLIN(10, 10), VISA(20, 20)]);
    const id2 = await t.request(4, D2);
    await t.decide(3, id2); await t.decide(5, id2);
    assert.equal((await t.outbox('to_direction')).filter((x) => x.recipient === uid(2) && x.absence_ids.includes(Number(id2))).length, 1);
  } finally { await t.db.close(); }
});
