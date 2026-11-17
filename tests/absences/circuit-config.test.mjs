// Circuit de validation des absences décrit en données (migration 202611180001), en PGlite, données fictives.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
const root = new URL('../../', import.meta.url);
const read = (p) => readFile(new URL(p, root), 'utf8');
const uid = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

// 1 admin, 2 direction, 3 cadre validateur Thoracique, 4 médecin Thoracique, 5 cadre validateur Thoracique, 6 médecin Gynécologie (sans validateur),
// 7 cheffe de service (cadre, sans clinique), 8 médecin Thoracique et Urologie, 9 cadre validateur Urologie
const PEOPLE = [[1, 'admin', []], [2, 'direction', []], [3, 'cadre', ['Thoracique']], [4, 'clinician', ['Thoracique']], [5, 'cadre', ['Thoracique']], [6, 'clinician', ['Gynécologie']],
  [7, 'cadre', []], [8, 'clinician', ['Thoracique', 'Urologie']], [9, 'cadre', ['Urologie']]];
const D1 = ['2027-03-01', '2027-03-03']; // 3 jours ouvrables
const D2 = ['2027-04-05', '2027-04-20']; // 12 jours ouvrables

async function mk({ migrate = true, validators = true } = {}) {
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
  if (validators) await db.query("insert into absence_validators(clinic,user_id) values ('Thoracique',$1),('Thoracique',$2),('Urologie',$3)", [uid(3), uid(5), uid(9)]);
  const mig = await read('supabase/migrations/202611180001_circuit_configurable.sql');
  const migrate_ = async () => { await db.exec(mig); await db.exec(mig); };
  if (migrate) await migrate_();
  const request = async (n, [from, to], kind = 'vacances') => { await as(n); const id = (await rpc('absence_request', [kind, null, from, to])).id; await rpc('absence_submit'); return id; };
  const stage = async (id) => { await sup(); return (await rows('select stage from absences where id=$1', [id]))[0].stage; };
  const status = async (id) => { await sup(); return (await rows('select status from absences where id=$1', [id]))[0].status; };
  const list = async (n) => { await as(n); return (await rows('select to_jsonb(r) j from public.absence_list() r')).map((x) => x.j); };
  const outbox = async (kind) => { await sup(); return rows('select recipient, absence_ids, payload from absence_outbox where kind=$1 order by id', [kind]); };
  return { db, as, sup, rpc, rows, list, request, stage, status, outbox, migrate: migrate_ };
}

// circuit complet à partir des valeurs par défaut, avec des modifications par position
const steps = (over = {}, extra = []) => {
  const base = [
    { pos: 0, kind: 'preavis', label: 'Pré-avis de la direction', rule: 'all', blocking: false, active: true },
    { pos: 10, kind: 'clinique', label: 'Validateurs de clinique', rule: 'all', blocking: true, active: true },
    { pos: 20, kind: 'visa', label: 'Visa de la direction', rule: 'any', blocking: true, active: true },
    { pos: 30, kind: 'personnes', label: 'Validation de la cheffe de service', rule: 'any', blocking: true, active: false, persons: [], pdf_slot: 'chef_service' }];
  return [...base.map((s) => ({ ...s, ...(over[s.pos] || {}) })), ...extra];
};
const CHEFFE = { 30: { active: true, persons: [uid(7)] } };

test('circuit configurable : défaut identique (avec et sans validateur de clinique)', async () => {
  const t = await mk();
  try {
    const id = await t.request(4, D1);
    assert.equal(await t.stage(id), 10);
    assert.deepEqual((await t.outbox('to_validate')).map((r) => r.recipient).sort(), [uid(3), uid(5)].sort());
    assert.deepEqual((await t.outbox('to_opinion')).map((r) => r.recipient), [uid(2)]);
    await t.as(3); await t.rpc('absence_decide', [id, true, null]);
    assert.equal(await t.stage(id), 10);
    await t.as(5); await t.rpc('absence_decide', [id, true, null]);
    assert.equal(await t.stage(id), 20);
    assert.deepEqual((await t.outbox('to_direction')).map((r) => r.recipient), [uid(2)]);
    assert.equal((await t.list(4)).find((a) => a.id === id).stage, 2);
    await t.as(2); assert.equal(await t.rpc('absence_decide', [id, true, null]), 'approved');
    assert.equal(await t.status(id), 'approved');
    // sans validateur de clinique : directement au visa
    const g = await t.request(6, D1);
    assert.equal(await t.stage(g), 20);
    await t.as(2); assert.equal(await t.rpc('absence_decide', [g, true, null]), 'approved');
  } finally { await t.db.close(); }
});

test('reprise : une demande en stage 1 ou 2 avant la migration est remappée et va au bout', async () => {
  const t = await mk({ migrate: false });
  try {
    const a = await t.request(4, D1), b = await t.request(6, D1);
    assert.equal(await t.stage(a), 1); assert.equal(await t.stage(b), 2);
    await t.migrate();
    assert.equal(await t.stage(a), 10); assert.equal(await t.stage(b), 20);
    await t.sup();
    const c = (await t.rows('select circuit from absences where id=$1', [a]))[0].circuit;
    assert.deepEqual(c.map((s) => s.pos), [10, 20]);
    await t.migrate(); // pas de deuxième remappage
    assert.equal(await t.stage(a), 10); assert.equal(await t.stage(b), 20);
    await t.as(3); await t.rpc('absence_decide', [a, true, null]);
    await t.as(5); await t.rpc('absence_decide', [a, true, null]);
    assert.equal(await t.stage(a), 20);
    await t.as(2); await t.rpc('absence_decide', [a, true, null]); await t.rpc('absence_decide', [b, true, null]);
    assert.equal(await t.status(a), 'approved'); assert.equal(await t.status(b), 'approved');
  } finally { await t.db.close(); }
});

test('étape « personnes » après le visa : la cheffe conclut, le document porte son nom', async () => {
  const t = await mk();
  try {
    await t.as(2); await t.rpc('absence_circuit_save', [JSON.stringify(steps(CHEFFE))]);
    const id = await t.request(4, D1);
    await t.as(3); await t.rpc('absence_decide', [id, true, null]);
    await t.as(5); await t.rpc('absence_decide', [id, true, null]);
    await t.as(2); assert.equal(await t.rpc('absence_decide', [id, true, null]), 'requested');
    assert.equal(await t.stage(id), 30); assert.equal(await t.status(id), 'requested');
    // l'étape est visible comme décision du visa pour les autres
    await t.as(4);
    const ap = await t.rows('select * from absence_approvals_all()');
    assert.ok(ap.some((r) => r.step === 20 && r.validator_name === 'Circuit 2' && r.decision === 'approved' && r.step_label === 'Visa de la direction'));
    assert.ok(ap.filter((r) => r.step === 10).length === 2);
    await t.as(3); await assert.rejects(t.rpc('absence_decide', [id, true, null]), /Vous ne validez pas/);
    await t.as(2); await assert.rejects(t.rpc('absence_decide', [id, true, null]), /Vous ne validez pas/);
    await t.as(7);
    assert.deepEqual((await t.rows('select id, step_kind, step_label from absence_to_validate()')).map((r) => [r.id, r.step_kind]), [[id, 'personnes']]);
    assert.equal(await t.rpc('absence_decide', [id, true, null]), 'approved');
    assert.equal(await t.status(id), 'approved');
    await t.sup();
    const doc = (await t.rows('select data from absence_documents order by id desc limit 1'))[0].data;
    assert.deepEqual(doc.extra.map((x) => [x.name, x.slot, x.label]), [['Circuit 7', 'chef_service', 'Validation de la cheffe de service']]);
    assert.deepEqual(doc.signers.map((x) => x.name).sort(), ['Circuit 3', 'Circuit 5']);
    assert.equal(doc.direction.name, 'Circuit 2');
  } finally { await t.db.close(); }
});

test('règle « any » sur la clinique : un seul validateur suffit', async () => {
  const t = await mk();
  try {
    await t.as(2); await t.rpc('absence_circuit_save', [JSON.stringify(steps({ 10: { rule: 'any' } }))]);
    const id = await t.request(4, D1);
    await t.as(3); await t.rpc('absence_decide', [id, true, null]);
    assert.equal(await t.stage(id), 20);
    await t.sup();
    assert.equal((await t.rows('select decision from absence_approvals where absence_id=$1 and validator_id=$2', [id, uid(5)]))[0].decision, 'skipped');
    await t.as(5); assert.equal((await t.rows('select * from absence_to_validate()')).length, 0);
    await t.as(2); assert.equal(await t.rpc('absence_decide', [id, true, null]), 'approved');
  } finally { await t.db.close(); }
});

test('étape « personnes » non bloquante : avis demandé, la chaîne ne l\'attend pas', async () => {
  const t = await mk();
  try {
    await t.as(2); await t.rpc('absence_circuit_save', [JSON.stringify(steps({}, [{ pos: 5, kind: 'personnes', label: 'Avis de la cheffe', rule: 'any', blocking: false, active: true, persons: [uid(7)] }]))]);
    const id = await t.request(4, D1);
    const op = (await t.outbox('to_opinion')).filter((r) => r.recipient === uid(7));
    assert.equal(op.length, 1); assert.equal(op[0].payload.step_label, 'Avis de la cheffe');
    assert.equal(await t.stage(id), 10);
    await t.as(7);
    const todo = await t.rows('select id, step_label from absence_opinion_todo()');
    assert.deepEqual(todo.map((r) => [r.id, r.step_label]), [[id, 'Avis de la cheffe']]);
    assert.equal((await t.rows('select * from absence_to_validate()')).length, 0);
    await t.rpc('absence_opinion_set', [id, 'favorable', null]);
    await t.sup(); assert.equal((await t.rows('select step from absence_opinions where user_id=$1', [uid(7)]))[0].step, 5);
    await t.as(6); await assert.rejects(t.rpc('absence_opinion_set', [id, 'favorable', null]), /Réservé/);
    await t.as(3); await t.rpc('absence_decide', [id, true, null]);
    await t.as(5); await t.rpc('absence_decide', [id, true, null]);
    await t.as(2); assert.equal(await t.rpc('absence_decide', [id, true, null]), 'approved');
  } finally { await t.db.close(); }
});

test('condition min_days : étape ignorée à 3 jours, appliquée à 12 jours', async () => {
  const t = await mk();
  try {
    await t.as(2); await t.rpc('absence_circuit_save', [JSON.stringify(steps({ 30: { active: true, persons: [uid(7)], min_days: 10 } }))]);
    const short = await t.request(4, D1), long = await t.request(4, D2);
    const list = await t.list(4);
    assert.deepEqual(list.find((a) => a.id === short).circuit.map((s) => s.pos), [10, 20]);
    assert.deepEqual(list.find((a) => a.id === long).circuit.map((s) => s.pos), [10, 20, 30]);
    assert.ok(list.every((a) => (a.circuit || []).every((s) => !('persons' in s))));
    // une absence de congrès restreinte par motif
    await t.as(2);
    await t.rpc('absence_circuit_save', [JSON.stringify(steps({ 30: { active: true, persons: [uid(7)], kinds: ['congres'] } }))]);
    await t.as(1);
    const sim = await t.rpc('absence_circuit_simulate', [uid(4), D1[0], D1[1], 'vacances', null]);
    assert.deepEqual(sim.excluded.map((x) => [x.pos, x.reason]), [[30, 'motif non concerné']]);
  } finally { await t.db.close(); }
});

test('pré-avis désactivé : aucun to_opinion à l\'envoi', async () => {
  const t = await mk();
  try {
    await t.as(2); await t.rpc('absence_circuit_save', [JSON.stringify(steps({ 0: { active: false } }))]);
    const id = await t.request(4, D1);
    assert.equal((await t.outbox('to_opinion')).length, 0);
    await t.as(2); await assert.rejects(t.rpc('absence_opinion_set', [id, 'favorable', null]), /Aucun pré-avis/);
    assert.equal((await t.rows('select * from absence_opinion_todo()')).length, 0);
  } finally { await t.db.close(); }
});

test('instantané : une modification du circuit après l\'envoi ne change pas une demande en cours', async () => {
  const t = await mk();
  try {
    const id = await t.request(4, D1);
    await t.as(2); await t.rpc('absence_circuit_save', [JSON.stringify(steps(CHEFFE))]);
    await t.as(3); await t.rpc('absence_decide', [id, true, null]);
    await t.as(5); await t.rpc('absence_decide', [id, true, null]);
    await t.as(2); assert.equal(await t.rpc('absence_decide', [id, true, null]), 'approved');
    // une nouvelle demande, elle, suit le nouveau circuit
    const id2 = await t.request(4, D2);
    await t.sup(); assert.deepEqual((await t.rows('select circuit from absences where id=$1', [id2]))[0].circuit.map((s) => s.pos), [10, 20, 30]);
  } finally { await t.db.close(); }
});

test('refus à l\'étape « personnes » : demande refusée', async () => {
  const t = await mk();
  try {
    await t.as(2); await t.rpc('absence_circuit_save', [JSON.stringify(steps(CHEFFE))]);
    const id = await t.request(4, D1);
    await t.as(3); await t.rpc('absence_decide', [id, true, null]);
    await t.as(5); await t.rpc('absence_decide', [id, true, null]);
    await t.as(2); await t.rpc('absence_decide', [id, true, null]);
    await t.as(7); await assert.rejects(t.rpc('absence_decide', [id, false, null]), /commentaire/);
    assert.equal(await t.rpc('absence_decide', [id, false, 'Effectif insuffisant']), 'rejected');
    assert.equal(await t.status(id), 'rejected');
    // la direction déjà sollicitée au visa est prévenue du refus, pas la cheffe qui refuse
    const pr = (await t.outbox('peer_rejected')).map((r) => r.recipient).sort();
    assert.deepEqual(pr, [uid(2), uid(3), uid(5)].sort());
  } finally { await t.db.close(); }
});

test('administrateur : valide d\'un coup à toute étape', async () => {
  const t = await mk();
  try {
    await t.as(2); await t.rpc('absence_circuit_save', [JSON.stringify(steps(CHEFFE))]);
    const a = await t.request(4, D1);
    await t.as(1); assert.equal(await t.rpc('absence_decide', [a, true, null]), 'approved');
    await t.sup(); assert.equal((await t.rows('select direction_by from absences where id=$1', [a]))[0].direction_by, uid(1));
    const b = await t.request(4, D2);
    await t.as(3); await t.rpc('absence_decide', [b, true, null]);
    await t.as(5); await t.rpc('absence_decide', [b, true, null]);
    await t.as(2); await t.rpc('absence_decide', [b, true, null]);
    assert.equal(await t.stage(b), 30);
    await t.as(1); assert.equal(await t.rpc('absence_decide', [b, true, null]), 'approved');
  } finally { await t.db.close(); }
});

test('absence_circuit_save : contrôles, droits et journal', async () => {
  const t = await mk();
  try {
    const save = (s) => t.rpc('absence_circuit_save', [JSON.stringify(s)]);
    await t.as(4); await assert.rejects(save(steps()), /Réservé/);
    await t.as(3); await assert.rejects(t.rpc('absence_circuit_get'), /Réservé/);
    await t.as(2);
    await assert.rejects(save(steps({ 10: { min_days: 5 }, 20: { kinds: ['congres'] } })), /sans condition/);
    await assert.rejects(save(steps({}, [{ pos: 40, kind: 'visa', label: 'Deuxième visa', active: true }])), /Une seule étape/);
    await assert.rejects(save(steps({ 30: { active: true, persons: [] } })), /au moins une personne/);
    await assert.rejects(save(steps({ 30: { active: true, persons: [uid(99)] } })), /n'existe pas/);
    await assert.rejects(save(steps({ 30: { label: '' } })), /libellé/);
    await assert.rejects(save(steps({ 30: { pos: 20 } })), /même position/);
    await assert.rejects(save(steps({ 30: { min_days: 400 } })), /365/);
    await assert.rejects(save(steps({ 30: { kinds: ['voyage'] } })), /Motif inconnu/);
    await assert.rejects(save(steps({ 30: { rule: 'plusieurs' } })), /règle/);
    await assert.rejects(save(steps({ 0: { pos: 5 } })), /position 0/);
    // refus sans effet : le circuit reste celui d'origine
    assert.equal((await t.rpc('absence_circuit_get')).log.length, 0);
    const res = await save(steps({ 30: { active: true, persons: [uid(7)], min_days: 10 } }));
    assert.equal(res.steps.find((s) => s.pos === 30).persons[0].name, 'Circuit 7');
    assert.equal(res.log.length, 1); assert.match(res.log[0].summary, /Validation de la cheffe de service/); assert.equal(res.log[0].by_name, 'Circuit 2');
    await t.sup();
    const lg = (await t.rows('select before, after from absence_circuit_log'))[0];
    assert.equal(lg.before.find((s) => s.pos === 30).active, false); assert.equal(lg.after.find((s) => s.pos === 30).active, true);
    await t.as(1); const o = await t.rpc('absence_circuit_overview'); assert.equal(o.steps.length, 4);
    assert.equal(await t.rpc('absence_circuit_get').then((g) => g.steps.length), 4);
  } finally { await t.db.close(); }
});

test('simulation sur un circuit non enregistré', async () => {
  const t = await mk();
  try {
    await t.as(1);
    const sim = await t.rpc('absence_circuit_simulate', [uid(4), D1[0], D1[1], 'vacances', JSON.stringify(steps(CHEFFE))]);
    assert.deepEqual(sim.steps.map((s) => s.key), ['preavis', 'clinique', 'visa', 'personnes']);
    const pe = sim.steps.find((s) => s.key === 'personnes');
    assert.deepEqual(pe.people.map((p) => p.name), ['Circuit 7']); assert.equal(pe.blocking, true); assert.equal(pe.rule_code, 'any');
    // rien n'est enregistré
    assert.equal((await t.rpc('absence_circuit_get')).steps.find((s) => s.pos === 30).active, false);
    const plain = await t.rpc('absence_circuit_simulate', [uid(4), D1[0], D1[1]]);
    assert.deepEqual(plain.steps.map((s) => s.key), ['preavis', 'clinique', 'visa']);
    // circuit non valide refusé aussi à la simulation
    await assert.rejects(t.rpc('absence_circuit_simulate', [uid(4), D1[0], D1[1], 'vacances', JSON.stringify(steps({ 30: { active: true, persons: [] } }))]), /au moins une personne/);
    await assert.rejects(t.rpc('absence_circuit_simulate', [uid(4), D1[0], D1[1], 'voyage', null]), /Motif inconnu/);
    // ancienne signature à trois arguments supprimée, appel à trois arguments toujours possible
    assert.equal(await t.rows("select count(*)::int n from pg_proc where proname='absence_circuit_simulate'").then((r) => r[0].n), 1);
  } finally { await t.db.close(); }
});

test('refus d\'une clinique : décisions de toutes les étapes visibles et message aux autres validateurs', async () => {
  const t = await mk();
  try {
    const id = await t.request(8, D1); // Thoracique (validateurs 3 et 5) et Urologie (validateur 9)
    assert.deepEqual((await t.outbox('to_validate')).map((r) => r.recipient).sort(), [uid(3), uid(5), uid(9)].sort());
    await t.as(3); await t.rpc('absence_decide', [id, true, null]);
    // pendant l'attente, chacun voit déjà la décision de l'autre
    await t.as(9);
    const todo = await t.rows('select progress from absence_to_validate()');
    assert.ok(todo[0].progress.some((p) => p.name === 'Circuit 3' && p.decision === 'approved' && p.step === 10 && p.step_label === 'Validateurs de clinique'));
    assert.equal(await t.rpc('absence_decide', [id, false, 'Effectif insuffisant']), 'rejected');
    await t.sup();
    const pr = await t.outbox('peer_rejected');
    assert.deepEqual(pr.map((r) => r.recipient).sort(), [uid(3), uid(5)].sort());
    assert.ok(pr.every((r) => r.payload.by === 'Circuit 9' && r.payload.owner === 'Circuit 8' && r.payload.step_label === 'Validateurs de clinique'));
    assert.deepEqual(await t.rpc('absence_notification_ids', [uid(3), [id], 'peer_rejected']), [id]);
    assert.deepEqual(await t.rpc('absence_notification_ids', [uid(8), [id], 'peer_rejected']), []);
    // le validateur de la première clinique voit sa validation et le refus de l'autre, commentaire compris
    await t.as(3);
    const rej = (await t.rows('select id, approvals from absence_rejected_to_manage()')).find((r) => r.id === id);
    assert.ok(rej);
    const by = (n) => rej.approvals.find((x) => x.name === n);
    assert.equal(by('Circuit 3').decision, 'approved');
    assert.equal(by('Circuit 9').decision, 'rejected'); assert.equal(by('Circuit 9').comment, 'Effectif insuffisant');
    assert.equal(by('Circuit 9').step_label, 'Validateurs de clinique');
    // le demandeur voit toutes les décisions de sa demande
    await t.as(8);
    const all = await t.rows('select validator_name, decision, step_label from absence_approvals_all()');
    assert.ok(all.some((r) => r.validator_name === 'Circuit 9' && r.decision === 'rejected'));
  } finally { await t.db.close(); }
});

test('circuit sans visa : sans validateur, la demande va à la direction (repli) et peut être conclue', async () => {
  const t = await mk();
  try {
    await t.as(2);
    const res = await t.rpc('absence_circuit_save', [JSON.stringify(steps({ 20: { active: false } }))]);
    assert.equal(res.warning, 'Aucun visa de la direction actif : les demandes sans validateur iront aux administrateurs.');
    await t.as(6); await t.rpc('absence_request', ['vacances', null, ...D1]);
    const who = await t.rpc('absence_my_validators');
    assert.equal(who.step_kind, 'visa'); assert.equal(who.fallback, true); assert.deepEqual(who.validators.map((v) => v.name), ['Circuit 2']);
    const id = (await t.rpc('absence_submit')).ids[0];
    assert.equal(await t.stage(id), 1000);
    assert.deepEqual((await t.outbox('to_validate')).map((r) => r.recipient), [uid(2)]);
    await t.as(2); assert.deepEqual((await t.rows('select id from absence_to_validate()')).map((r) => r.id), [id]);
    assert.equal(await t.rpc('absence_decide', [id, true, null]), 'approved');
    // un circuit avec visa ne renvoie pas d'avertissement
    assert.equal((await t.rpc('absence_circuit_save', [JSON.stringify(steps())])).warning, undefined);
  } finally { await t.db.close(); }
});

test('même personne à une étape « personnes » puis validatrice de clinique : voit encore la demande', async () => {
  const t = await mk();
  try {
    await t.as(2); await t.rpc('absence_circuit_save', [JSON.stringify(steps({}, [{ pos: 5, kind: 'personnes', label: 'Avant la clinique', rule: 'any', blocking: true, active: true, persons: [uid(3)] }]))]);
    const id = await t.request(4, D1);
    assert.equal(await t.stage(id), 5);
    await t.as(3); await t.rpc('absence_decide', [id, true, null]);
    assert.equal(await t.stage(id), 10);
    assert.deepEqual((await t.rows('select id, step_kind from absence_to_validate()')).map((r) => [r.id, r.step_kind]), [[id, 'clinique']]);
    await t.rpc('absence_decide', [id, true, null]);
    assert.equal(await t.stage(id), 10);
    await t.as(5); await t.rpc('absence_decide', [id, true, null]);
    assert.equal(await t.stage(id), 20);
  } finally { await t.db.close(); }
});

test('confidentialité : commentaires masqués pour les validateurs, visibles pour l\'administration', async () => {
  const t = await mk();
  try {
    const id = await t.request(8, D1);
    await t.as(9); await t.rpc('absence_decide', [id, false, 'Motif confidentiel']);
    await t.sup(); await t.db.exec('update absences set confidential = true');
    await t.as(3);
    const r3 = (await t.rows('select decision_comment, approvals from absence_rejected_to_manage()')).find((r) => r.approvals.length);
    assert.equal(r3.decision_comment, null); assert.ok(r3.approvals.every((x) => x.comment === null));
    await t.as(1);
    const r1 = (await t.rows('select decision_comment, approvals from absence_rejected_to_manage()'))[0];
    assert.equal(r1.decision_comment, 'Motif confidentiel'); assert.ok(r1.approvals.some((x) => x.comment === 'Motif confidentiel'));
    await t.as(3); await t.rpc('absence_approvals_all', [uid(8)]).catch(() => {});
    const ap3 = await t.rows('select comment from absence_approvals_all($1)', [uid(8)]);
    assert.ok(ap3.length && ap3.every((x) => x.comment === null));
    await t.as(1); assert.ok((await t.rows('select comment from absence_approvals_all($1)', [uid(8)])).some((x) => x.comment === 'Motif confidentiel'));
    await t.as(8); assert.ok((await t.rows('select comment from absence_approvals_all()')).some((x) => x.comment === 'Motif confidentiel'));
  } finally { await t.db.close(); }
});

test('personnes d\'une étape « personnes » : accès limité aux demandes où elles figurent dans l\'instantané', async () => {
  const t = await mk();
  try {
    await t.as(2); await t.rpc('absence_circuit_save', [JSON.stringify(steps({ 30: { active: true, persons: [uid(7)], min_days: 10 } }))]);
    const short = await t.request(4, D1), long = await t.request(4, D2);
    await t.as(7);
    assert.deepEqual((await t.rows('select to_jsonb(r) j from public.absence_list($1) r', [uid(4)])).map((x) => x.j.id), [long]);
    assert.deepEqual([...new Set((await t.rows('select absence_id from absence_approvals_all($1)', [uid(4)])).map((x) => x.absence_id))], [long]);
    await t.as(6); await assert.rejects(t.rows('select * from public.absence_list($1)', [uid(4)]), /Accès refusé/);
    await t.as(3); await t.rpc('absence_decide', [long, false, 'Refus de test']);
    await t.as(7);
    assert.deepEqual((await t.rows('select id from absence_rejected_to_manage()')).map((x) => x.id), [long]);
    await assert.rejects(t.rpc('absence_delete_rejected', [short]), /introuvable|refusé/);
    await t.rpc('absence_delete_rejected', [long]);
    await t.sup(); assert.equal((await t.rows('select 1 from absences where id=$1', [long])).length, 0);
    assert.equal((await t.rows('select 1 from absences where id=$1', [short])).length, 1);
  } finally { await t.db.close(); }
});

test('droits refusés, renvoi aux bonnes personnes, un seul avis par personne, historique sans circuit', async () => {
  const t = await mk();
  try {
    await t.as(4);
    await assert.rejects(t.rpc('absence_circuit_overview'), /Réservé/);
    await assert.rejects(t.rpc('absence_circuit_simulate', [uid(4), ...D1]), /Réservé/);
    await t.as(2); await t.rpc('absence_circuit_save', [JSON.stringify(steps(CHEFFE, [{ pos: 5, kind: 'personnes', label: 'Avis', rule: 'any', blocking: false, active: true, persons: [uid(2)] }]))]);
    const id = await t.request(4, D1);
    // la direction reçoit le pré-avis et figure dans une étape non bloquante : un seul message
    assert.equal((await t.outbox('to_opinion')).filter((r) => r.recipient === uid(2)).length, 1);
    await t.sup();
    assert.deepEqual((await t.rows('select recipient from absence_resend_pairs($1,$2) order by 1', [uid(4), [id]])).map((r) => r.recipient).sort(), [uid(3), uid(5)].sort());
    await t.as(3); await t.rpc('absence_decide', [id, true, null]);
    await t.as(5); await t.rpc('absence_decide', [id, true, null]);
    await t.as(2); await t.rpc('absence_decide', [id, true, null]);
    assert.equal(await t.stage(id), 30);
    await t.sup();
    assert.deepEqual((await t.rows('select absence_id, recipient from absence_resend_pairs($1,$2)', [uid(4), [id]])).map((r) => [r.absence_id, r.recipient]), [[id, uid(7)]]);
    await t.as(4);
    const h = await t.rpc('absence_history', [id]);
    assert.ok(h.length > 0 && h.every((e) => !('circuit' in (e.before_data || {})) && !('circuit' in (e.after_data || {}))));
  } finally { await t.db.close(); }
});
