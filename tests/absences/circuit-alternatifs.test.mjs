// Circuits alternatifs attribués à des membres, des rôles ou des cliniques (migration 202611180001), en PGlite, données fictives.
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


const steps = (over = {}) => {
  const base = [
    { pos: 0, kind: 'preavis', label: 'Pré-avis de la direction', rule: 'all', blocking: false, active: true },
    { pos: 10, kind: 'clinique', label: 'Validateurs de clinique', rule: 'all', blocking: true, active: true },
    { pos: 20, kind: 'visa', label: 'Visa de la direction', rule: 'any', blocking: true, active: true }];
  return base.map((s) => ({ ...s, ...(over[s.pos] || {}) }));
};
// circuit sans étape de clinique : visa direct
const DIRECT = [{ pos: 0, kind: 'preavis', label: 'Pré-avis de la direction', rule: 'all', blocking: false, active: true }, { pos: 20, kind: 'visa', label: 'Visa de la direction', rule: 'any', blocking: true, active: true }];

// crée un circuit alternatif (direction) et enregistre ses étapes
async function circuit(t, name, st = DIRECT) {
  await t.as(2);
  const id = Number(await t.rpc('absence_circuit_create', [name]));
  await t.rpc('absence_circuit_save', [JSON.stringify(st), id]);
  return id;
}
const info = async (t, id) => { await t.sup(); return (await t.rows('select circuit_id, circuit_name, stage, preavis_active, circuit from absences where id=$1', [id]))[0]; };
// type de l'étape bloquante en cours (les positions sont renumérotées à l'enregistrement : le visa seul est en position 10)
const kindOf = async (t, id) => { const i = await info(t, id); return i.circuit.find((x) => x.pos === i.stage).kind; };
const sim = async (t, n, d = D1) => { await t.as(1); return (await t.rpc('absence_circuit_simulate', [uid(n), d[0], d[1]])).circuit; };

test('1. sans attribution : le circuit général s\'applique, le défaut est inchangé', async () => {
  const t = await mk();
  try {
    await t.as(1);
    const list = await t.rpc('absence_circuit_list');
    assert.equal(list.length, 1); assert.equal(list[0].name, 'Circuit général'); assert.equal(list[0].is_default, true); assert.equal(list[0].active_steps, 3 + 0);
    assert.equal(list[0].members, 9);
    assert.deepEqual(await sim(t, 4), { id: list[0].id, name: 'Circuit général', reason: 'default', detail: null });
    const id = await t.request(4, D1);
    assert.equal(await t.stage(id), 10);
    assert.equal((await info(t, id)).circuit_name, 'Circuit général');
    assert.equal((await info(t, id)).preavis_active, true);
    assert.deepEqual((await t.outbox('to_opinion')).map((r) => r.recipient), [uid(2)]);
  } finally { await t.db.close(); }
});

test('2. circuit par rôle : un cadre suit « Cadres » (visa direct), un médecin suit le général', async () => {
  const t = await mk();
  try {
    const cad = await circuit(t, 'Cadres');
    await t.as(2); await t.rpc('absence_circuit_assign', [cad, 'role', ['cadre']]);
    const a = await t.request(3, D1), b = await t.request(4, D1);
    assert.equal(await kindOf(t, a), 'visa'); assert.equal((await info(t, a)).circuit_name, 'Cadres');
    assert.deepEqual((await info(t, a)).circuit.map((s) => s.kind), ['visa']);
    assert.equal(await kindOf(t, b), 'clinique'); assert.equal((await info(t, b)).circuit_name, 'Circuit général');
    // la direction vise la demande du cadre directement
    await t.as(2); assert.equal(await t.rpc('absence_decide', [a, true, null]), 'approved');
    // fenêtre de confirmation : le cadre voit le visa comme première étape
    await t.as(7); await t.rpc('absence_request', ['vacances', null, '2027-05-03', '2027-05-04']);
    assert.equal((await t.rpc('absence_my_validators')).step_kind, 'visa');
    await t.as(4); await t.rpc('absence_request', ['vacances', null, '2027-05-03', '2027-05-04']);
    assert.equal((await t.rpc('absence_my_validators')).step_kind, 'clinique');
  } finally { await t.db.close(); }
});

test('3. circuit par clinique, cliniques datées : avant et après un changement programmé, y compris une demande de changement', async () => {
  const t = await mk();
  try {
    const uro = await circuit(t, 'Urologie');
    await t.as(2); await t.rpc('absence_circuit_assign', [uro, 'clinic', ['Urologie']]);
    await t.sup(); await t.db.query("insert into member_clinic_changes(user_id, valid_from, clinics) values ($1,'2027-06-01','{Urologie}')", [uid(4)]);
    const JUL = ['2027-07-05', '2027-07-07'];
    assert.equal((await sim(t, 4, D1)).reason, 'default');
    assert.deepEqual(await sim(t, 4, JUL).then((c) => [c.name, c.reason, c.detail]), ['Urologie', 'clinic', 'Urologie']);
    const before = await t.request(4, D1), after = await t.request(4, JUL);
    assert.equal(await kindOf(t, before), 'clinique'); assert.equal(await kindOf(t, after), 'visa');
    assert.equal((await info(t, after)).circuit_name, 'Urologie');
    // une demande de changement vers les dates d'Urologie suit le circuit de ces dates
    await t.as(3); await t.rpc('absence_decide', [before, true, null]);
    await t.as(5); await t.rpc('absence_decide', [before, true, null]);
    await t.as(2); await t.rpc('absence_decide', [before, true, null]);
    await t.as(4); await t.rpc('absence_request_change', [before, 'modify', 'vacances', null, '2027-08-02', '2027-08-04']);
    assert.equal(await kindOf(t, before), 'visa'); assert.equal((await info(t, before)).circuit_name, 'Urologie');
  } finally { await t.db.close(); }
});

test('4. le membre nommé l\'emporte sur le rôle, qui l\'emporte sur la clinique', async () => {
  const t = await mk();
  try {
    const a = await circuit(t, 'Cadres'), b = await circuit(t, 'Uro'), c = await circuit(t, 'Nommés');
    await t.as(2);
    await t.rpc('absence_circuit_assign', [a, 'role', ['cadre']]);
    await t.rpc('absence_circuit_assign', [b, 'clinic', ['Urologie']]);
    await t.rpc('absence_circuit_assign', [c, 'member', [uid(9)]]);
    assert.deepEqual(await sim(t, 9).then((x) => [x.name, x.reason]), ['Nommés', 'member']);
    await t.as(2); await t.rpc('absence_circuit_assign', [c, 'member', []]);
    assert.deepEqual(await sim(t, 9).then((x) => [x.name, x.reason]), ['Cadres', 'role']);
    await t.as(2); await t.rpc('absence_circuit_assign', [a, 'role', []]);
    assert.deepEqual(await sim(t, 9).then((x) => [x.name, x.reason]), ['Uro', 'clinic']);
    await t.as(1); const who = await t.rpc('absence_circuit_who');
    assert.equal(who.find((w) => w.id === uid(9)).reason, 'clinic');
    assert.equal(who.find((w) => w.id === uid(4)).reason, 'default');
  } finally { await t.db.close(); }
});

test('5. conflit entre deux cliniques : le circuit le mieux placé gagne, signalé par « qui suit »', async () => {
  const t = await mk();
  try {
    const x = await circuit(t, 'Circuit X'), y = await circuit(t, 'Circuit Y');
    await t.as(2);
    await t.rpc('absence_circuit_assign', [x, 'clinic', ['Urologie']]);
    await t.rpc('absence_circuit_assign', [y, 'clinic', ['Thoracique']]);
    // le membre 8 est en Thoracique et en Urologie
    assert.equal(await sim(t, 8).then((c) => c.name), 'Circuit X');
    await t.as(1);
    let who = (await t.rpc('absence_circuit_who')).find((w) => w.id === uid(8));
    assert.equal(who.conflict, true); assert.equal(who.circuit_name, 'Circuit X'); assert.equal(who.reason, 'clinic'); assert.deepEqual(who.clinics, ['Thoracique', 'Urologie']);
    assert.equal((await t.rpc('absence_circuit_who')).find((w) => w.id === uid(4)).conflict, false);
    assert.ok((await t.rpc('absence_circuit_overview')).warnings.some((w) => /Circuit 8 : ses cliniques mènent à des circuits différents/.test(w)));
    await t.as(2); await t.rpc('absence_circuit_reorder', [[y, x]]);
    assert.equal(await sim(t, 8).then((c) => c.name), 'Circuit Y');
    await t.as(1); who = (await t.rpc('absence_circuit_who')).find((w) => w.id === uid(8));
    assert.equal(who.circuit_name, 'Circuit Y'); assert.equal(who.conflict, true);
    assert.deepEqual((await t.rpc('absence_circuit_list')).map((c) => c.name), ['Circuit général', 'Circuit Y', 'Circuit X']);
    await t.as(2);
    await assert.rejects(t.rpc('absence_circuit_reorder', [[y]]), /incomplète/);
    await assert.rejects(t.rpc('absence_circuit_reorder', [[y, y]]), /incomplète/);
  } finally { await t.db.close(); }
});

test('6. instantané : changer une attribution après l\'envoi ne modifie pas une demande en cours', async () => {
  const t = await mk();
  try {
    const cad = await circuit(t, 'Cadres');
    await t.as(2); await t.rpc('absence_circuit_assign', [cad, 'role', ['cadre']]);
    const id = await t.request(3, D1);
    const first = await info(t, id);
    await t.as(2); await t.rpc('absence_circuit_assign', [cad, 'role', []]);
    await t.rpc('absence_circuit_save', [JSON.stringify(steps()), cad]);
    const second = await info(t, id);
    assert.deepEqual(second, first); assert.equal(second.circuit_name, 'Cadres'); assert.equal(await kindOf(t, id), 'visa');
    assert.equal(await t.rpc('absence_decide', [id, true, null]), 'approved');
    // une nouvelle demande suit désormais le circuit général
    const id2 = await t.request(3, D2);
    assert.equal((await info(t, id2)).circuit_name, 'Circuit général'); assert.equal(await kindOf(t, id2), 'clinique');
  } finally { await t.db.close(); }
});

test('7. préavis désactivé dans un circuit alternatif : aucun avis demandé, alors que le général en envoie ; valeur figée', async () => {
  const t = await mk();
  try {
    const quiet = await circuit(t, 'Sans pré-avis', steps({ 0: { active: false } }));
    await t.as(2); await t.rpc('absence_circuit_assign', [quiet, 'member', [uid(4)]]);
    const a = await t.request(4, D1);
    assert.equal((await t.outbox('to_opinion')).length, 0);
    assert.equal((await info(t, a)).preavis_active, false);
    await t.as(2); await assert.rejects(t.rpc('absence_opinion_set', [a, 'favorable', null]), /Aucun pré-avis/);
    assert.equal((await t.rows('select * from absence_opinion_todo()')).length, 0);
    const b = await t.request(8, D1);
    assert.deepEqual((await t.outbox('to_opinion')).map((r) => r.recipient), [uid(2)]);
    assert.equal((await info(t, b)).preavis_active, true);
    // valeur figée : désactiver le pré-avis du circuit général ne retire pas l'avis déjà demandé
    await t.as(2); await t.rpc('absence_circuit_save', [JSON.stringify(steps({ 0: { active: false } }))]);
    assert.deepEqual((await t.rows('select id from absence_opinion_todo()')).map((r) => r.id), [b]);
    await t.rpc('absence_opinion_set', [b, 'favorable', null]);
    assert.equal((await info(t, b)).preavis_active, true);
  } finally { await t.db.close(); }
});

test('8. droits : un médecin est refusé sur toute l\'administration des circuits', async () => {
  const t = await mk();
  try {
    const cad = await circuit(t, 'Cadres');
    await t.as(4);
    for (const [fn, args] of [['absence_circuit_create', ['Pirate']], ['absence_circuit_assign', [cad, 'role', ['cadre']]], ['absence_circuit_delete', [cad]],
      ['absence_circuit_rename', [cad, 'Autre']], ['absence_circuit_reorder', [[cad]]], ['absence_circuit_list', []], ['absence_circuit_who', []],
      ['absence_circuit_get', [cad]], ['absence_circuit_save', [JSON.stringify(steps()), cad]]]) {
      await assert.rejects(t.rpc(fn, args), /Réservé/, fn);
    }
    await t.as(3); await assert.rejects(t.rpc('absence_circuit_create', ['Pirate']), /Réservé/);
    // les tables restent fermées et les fonctions internes inaccessibles
    await assert.rejects(t.rows('select * from absence_circuits'), /permission denied/);
    await assert.rejects(t.rows('select * from absence_circuit_assignments'), /permission denied/);
    await assert.rejects(t.rows("select public.absence_circuit_resolve($1, current_date, current_date)", [uid(4)]), /permission denied/);
    await t.as(2); // la direction peut tout faire
    assert.ok(Number(await t.rpc('absence_circuit_create', ['Autorisé'])) > 0);
  } finally { await t.db.close(); }
});

test('9. le circuit général ne se supprime, ne se renomme ni ne s\'attribue ; une cible déjà prise est refusée', async () => {
  const t = await mk();
  try {
    const cad = await circuit(t, 'Cadres'), autre = await circuit(t, 'Autre');
    await t.as(2);
    const def = (await t.rpc('absence_circuit_list')).find((c) => c.is_default).id;
    await assert.rejects(t.rpc('absence_circuit_delete', [def]), /ne se supprime pas/);
    await assert.rejects(t.rpc('absence_circuit_rename', [def, 'Nouveau']), /ne se renomme pas/);
    await assert.rejects(t.rpc('absence_circuit_assign', [def, 'role', ['cadre']]), /ne s'attribue pas/);
    await t.rpc('absence_circuit_assign', [cad, 'role', ['cadre']]);
    await t.rpc('absence_circuit_assign', [cad, 'member', [uid(4)]]);
    await t.rpc('absence_circuit_assign', [cad, 'clinic', ['Urologie']]);
    for (const [ty, tg] of [['role', 'cadre'], ['member', uid(4)], ['clinic', 'Urologie']])
      await assert.rejects(t.rpc('absence_circuit_assign', [autre, ty, [tg]]), /suit déjà le circuit « Cadres »/);
    // un échec ne modifie rien
    assert.equal((await t.rpc('absence_circuit_get', [cad])).assignments.length, 3);
    await assert.rejects(t.rpc('absence_circuit_assign', [autre, 'role', ['member']]), /Rôle inconnu/);
    await assert.rejects(t.rpc('absence_circuit_assign', [autre, 'role', ['medecin']]), /Rôle inconnu/);
    await assert.rejects(t.rpc('absence_circuit_assign', [autre, 'clinic', ['Cardiologie']]), /Clinique inconnue/);
    await assert.rejects(t.rpc('absence_circuit_assign', [autre, 'member', [uid(99)]]), /n'existe pas/);
    await assert.rejects(t.rpc('absence_circuit_assign', [autre, 'member', ['pas-un-uuid']]), /invalide/);
    await assert.rejects(t.rpc('absence_circuit_assign', [autre, 'groupe', ['x']]), /Type d'attribution/);
    await assert.rejects(t.rpc('absence_circuit_assign', [9999, 'role', ['cadre']]), /introuvable/);
    // remplace : la même cible peut être réenregistrée dans son circuit, retirer libère la cible
    await t.rpc('absence_circuit_assign', [cad, 'role', ['cadre']]);
    await t.rpc('absence_circuit_assign', [cad, 'role', []]);
    await t.rpc('absence_circuit_assign', [autre, 'role', ['cadre']]);
    // noms
    await assert.rejects(t.rpc('absence_circuit_create', ['cadres']), /porte déjà ce nom/);
    await assert.rejects(t.rpc('absence_circuit_create', ['   ']), /1 à 60/);
    await assert.rejects(t.rpc('absence_circuit_create', ['x'.repeat(61)]), /1 à 60/);
    await assert.rejects(t.rpc('absence_circuit_rename', [autre, 'Cadres']), /porte déjà ce nom/);
    await t.rpc('absence_circuit_rename', [autre, 'Renommé']);
    assert.equal((await t.rpc('absence_circuit_get', [autre])).circuit.name, 'Renommé');
  } finally { await t.db.close(); }
});

test('10. suppression d\'un circuit alternatif : retour au général pour les nouvelles demandes, instantané conservé', async () => {
  const t = await mk();
  try {
    const cad = await circuit(t, 'Cadres');
    await t.as(2); await t.rpc('absence_circuit_assign', [cad, 'role', ['cadre']]);
    const a = await t.request(3, D1);
    const before = await info(t, a);
    await t.as(2); await t.rpc('absence_circuit_delete', [cad]);
    await t.sup();
    assert.equal((await t.rows('select count(*)::int n from absence_circuit_assignments'))[0].n, 0);
    assert.equal((await t.rows('select count(*)::int n from absence_circuit_steps where circuit_id=$1', [cad]))[0].n, 0);
    const after = await info(t, a);
    assert.equal(after.circuit_id, null); assert.equal(after.circuit_name, 'Cadres');
    assert.deepEqual({ ...after, circuit_id: before.circuit_id }, before);
    await t.as(2); assert.equal(await t.rpc('absence_decide', [a, true, null]), 'approved');
    await assert.rejects(t.rpc('absence_circuit_get', [cad]), /introuvable/);
    const b = await t.request(3, D2);
    assert.equal((await info(t, b)).circuit_name, 'Circuit général'); assert.equal(await kindOf(t, b), 'clinique');
    assert.equal(await sim(t, 3).then((c) => c.reason), 'default');
    // le journal garde la trace de la suppression
    await t.sup(); assert.ok((await t.rows("select 1 from absence_circuit_log where action='delete' and circuit_id=$1", [cad])).length === 1);
  } finally { await t.db.close(); }
});

test('11. simulation : circuit appliqué et raison ; brouillon simulé comme le circuit choisi', async () => {
  const t = await mk();
  try {
    const cad = await circuit(t, 'Cadres');
    await t.as(2); await t.rpc('absence_circuit_assign', [cad, 'role', ['cadre']]);
    await t.as(1);
    const r = await t.rpc('absence_circuit_simulate', [uid(3), ...D1]);
    assert.deepEqual(r.circuit, { id: cad, name: 'Cadres', reason: 'role', detail: 'cadre' });
    assert.deepEqual(r.steps.map((s) => s.key), ['preavis', 'visa']);
    const m = await t.rpc('absence_circuit_simulate', [uid(4), ...D1]);
    assert.equal(m.circuit.reason, 'default'); assert.deepEqual(m.steps.map((s) => s.key), ['preavis', 'clinique', 'visa']);
    // brouillon du circuit « Cadres » simulé pour un médecin : circuit simulé = Cadres, circuit réel du membre = général
    const d = await t.rpc('absence_circuit_simulate', [uid(4), D1[0], D1[1], 'vacances', JSON.stringify(DIRECT), cad]);
    assert.deepEqual([d.circuit.id, d.circuit.name, d.circuit.reason], [cad, 'Cadres', 'draft']);
    assert.equal(d.resolved.name, 'Circuit général'); assert.deepEqual(d.steps.map((s) => s.key), ['preavis', 'visa']);
    const g = await t.rpc('absence_circuit_simulate', [uid(4), D1[0], D1[1], 'vacances', JSON.stringify(steps())]);
    assert.equal(g.circuit.name, 'Circuit général');
    await assert.rejects(t.rpc('absence_circuit_simulate', [uid(4), D1[0], D1[1], 'vacances', JSON.stringify(steps()), 9999]), /introuvable/);
  } finally { await t.db.close(); }
});

test('12. création par copie, liste, journal et avertissements', async () => {
  const t = await mk();
  try {
    await t.as(2);
    await t.rpc('absence_circuit_save', [JSON.stringify([...steps(), { pos: 30, kind: 'personnes', label: 'Cheffe', rule: 'any', blocking: true, active: true, persons: [uid(7)] }])]);
    const copy = Number(await t.rpc('absence_circuit_create', ['Copie du général']));
    const src = await circuit(t, 'Source', DIRECT);
    const fromSrc = Number(await t.rpc('absence_circuit_create', ['Copie de Source', src]));
    const g1 = await t.rpc('absence_circuit_get', [copy]);
    assert.deepEqual(g1.steps.map((s) => s.kind), ['preavis', 'clinique', 'visa', 'personnes']); assert.equal(g1.steps[3].persons[0].name, 'Circuit 7');
    assert.deepEqual((await t.rpc('absence_circuit_get', [fromSrc])).steps.map((s) => s.kind), ['preavis', 'visa']);
    // les circuits sont indépendants
    await t.rpc('absence_circuit_save', [JSON.stringify(DIRECT), copy]);
    assert.equal((await t.rpc('absence_circuit_get')).steps.length, 4);
    await t.rpc('absence_circuit_assign', [copy, 'member', [uid(4), uid(6)]]);
    await t.rpc('absence_circuit_rename', [copy, 'Médecins ciblés']);
    const list = await t.rpc('absence_circuit_list');
    const c = list.find((x) => x.id === copy);
    assert.deepEqual([c.name, c.active_steps, c.members], ['Médecins ciblés', 2, 2]);
    assert.deepEqual(c.assignments.map((a) => [a.type, a.name]), [['member', 'Circuit 4'], ['member', 'Circuit 6']]);
    assert.equal(list[0].is_default, true);
    const log = (await t.rpc('absence_circuit_get', [copy])).log.map((l) => l.action);
    assert.ok(['rename', 'assign', 'save_steps', 'create'].every((a) => log.includes(a)));
    assert.match((await t.rpc('absence_circuit_get', [copy])).log.find((l) => l.action === 'assign').summary, /Attributions \(membres\) : Circuit 4, Circuit 6/);
    // avertissements : circuit sans attribution, membre sans rôle, étape sans personne
    const o1 = await t.rpc('absence_circuit_overview');
    assert.ok(o1.warnings.some((w) => /Circuit « Source » : aucune attribution/.test(w)));
    assert.equal(o1.circuits.length, 4);
    await t.sup(); await t.db.exec(`update profiles set role='member' where id='${uid(6)}'`);
    await t.as(2);
    assert.ok((await t.rpc('absence_circuit_overview')).warnings.some((w) => /Circuit « Médecins ciblés » : Circuit 6 est attribué mais n'a plus de rôle/.test(w)));
    assert.equal((await t.rpc('absence_circuit_who')).some((w) => w.id === uid(6)), false);
  } finally { await t.db.close(); }
});

test('13. peer_rejected : une personne désignée dans un circuit alternatif reçoit le type de notification', async () => {
  const t = await mk();
  try {
    await circuit(t, 'Avec cheffe', [...DIRECT, { pos: 30, kind: 'personnes', label: 'Cheffe', rule: 'any', blocking: true, active: true, persons: [uid(7)] }]);
    await t.sup();
    assert.ok((await t.rows('select public.notification_kinds_for($1) k', [uid(7)]))[0].k.includes('peer_rejected'));
    assert.ok(!(await t.rows('select public.notification_kinds_for($1) k', [uid(6)]))[0].k.includes('peer_rejected'));
  } finally { await t.db.close(); }
});

test('14. migration réexécutable avec des données, et par-dessus l\'ancienne forme des tables', async () => {
  const t = await mk();
  try {
    const cad = await circuit(t, 'Cadres');
    await t.as(2); await t.rpc('absence_circuit_assign', [cad, 'role', ['cadre']]);
    const id = await t.request(3, D1);
    await t.sup(); await t.migrate(); await t.migrate();
    assert.equal((await t.rows('select count(*)::int n from absence_circuits'))[0].n, 2);
    assert.equal((await t.rows('select count(*)::int n from absence_circuit_steps'))[0].n, 4 + 2);
    assert.equal((await t.rows('select count(*)::int n from absence_circuit_assignments'))[0].n, 1);
    assert.equal((await info(t, id)).circuit_name, 'Cadres');
    assert.equal((await t.rows("select count(*)::int n from pg_proc where proname in ('absence_circuit_simulate','absence_circuit_get','absence_circuit_save','absence_circuit_steps_json','absence_preavis_active')"))[0].n, 4);
    // ancienne forme (sans circuit_id) : les étapes existantes passent au circuit général, la clé d'unicité devient par circuit
    await t.db.exec(`delete from absence_circuit_assignments; update absences set circuit_id = null; delete from absence_circuits where not is_default;
      drop index absence_circuit_steps_kind_once; alter table absence_circuit_steps drop constraint absence_circuit_steps_circuit_pos_key;
      alter table absence_circuit_steps drop column circuit_id;
      delete from absence_circuit_steps;
      insert into absence_circuit_steps(pos,kind,label,rule,blocking,active,pdf_slot) values (0,'preavis','P','all',false,true,null),(10,'clinique','C','all',true,true,null),(20,'visa','V','any',true,true,null);
      alter table absence_circuit_steps add constraint absence_circuit_steps_pos_key unique (pos);
      create unique index absence_circuit_steps_kind_once on absence_circuit_steps (kind) where kind in ('preavis','clinique','visa');`);
    // anciennes signatures déjà appliquées : remplacées sans ambiguïté
    await t.db.exec(`create function public.absence_circuit_get() returns jsonb language sql as 'select null::jsonb';
      create function public.absence_circuit_save(jsonb) returns jsonb language sql as 'select null::jsonb';
      create function public.absence_circuit_simulate(uuid, date, date, text, jsonb) returns jsonb language sql as 'select null::jsonb';
      create function public.absence_circuit_steps_json() returns jsonb language sql as 'select null::jsonb';
      create function public.absence_circuit_steps_named() returns jsonb language sql as 'select null::jsonb';
      create function public.absence_circuit_build(text, date, date, jsonb) returns jsonb language sql as 'select null::jsonb';
      create function public.absence_preavis_active() returns boolean language sql as 'select true';`);
    await t.migrate();
    assert.deepEqual((await t.rows("select proname, pronargs::int n from pg_proc where proname in ('absence_circuit_get','absence_circuit_save','absence_circuit_simulate','absence_circuit_steps_json','absence_circuit_steps_named','absence_circuit_build','absence_preavis_active') order by 1")).map((r) => [r.proname, r.n]),
      [['absence_circuit_build', 5], ['absence_circuit_get', 1], ['absence_circuit_save', 2], ['absence_circuit_simulate', 6], ['absence_circuit_steps_json', 1], ['absence_circuit_steps_named', 1]]);
    assert.equal((await t.rows('select count(*)::int n from absence_circuit_steps where circuit_id = (select id from absence_circuits where is_default)'))[0].n, 3);
    assert.equal((await t.rows("select count(*)::int n from pg_constraint where conrelid='absence_circuit_steps'::regclass and contype='u'"))[0].n, 1);
    await t.as(1); assert.equal((await t.rpc('absence_circuit_get')).steps.length, 3);
  } finally { await t.db.close(); }
});

test('15. assign_all : une transaction, un refus ne laisse rien d\'enregistré, un seul journal, droits', async () => {
  const t = await mk();
  try {
    const a = await circuit(t, 'Cadres'), b = await circuit(t, 'Autre');
    await t.as(2); await t.rpc('absence_circuit_assign', [b, 'role', ['direction']]);
    // le premier type est valide, le deuxième est pris par un autre circuit : rien ne reste
    await assert.rejects(t.rpc('absence_circuit_assign_all', [a, [uid(4)], ['direction'], []]), /suit déjà le circuit « Autre »/);
    assert.deepEqual((await t.rpc('absence_circuit_get', [a])).assignments, []);
    const before = (await t.rpc('absence_circuit_get', [a])).log.length;
    const res = await t.rpc('absence_circuit_assign_all', [a, [uid(4)], ['cadre'], ['Urologie']]);
    assert.deepEqual(res.map((x) => [x.type, x.target]), [['clinic', 'Urologie'], ['member', uid(4)], ['role', 'cadre']]);
    const log = (await t.rpc('absence_circuit_get', [a])).log;
    assert.equal(log.length, before + 1); assert.equal(log[0].action, 'assign');
    await assert.rejects(t.rpc('absence_circuit_assign_all', [1, [], [], []]), /ne s'attribue pas/);
    // remplace tout, y compris en vidant
    assert.deepEqual(await t.rpc('absence_circuit_assign_all', [a, [], [], []]), []);
    await t.as(4); await assert.rejects(t.rpc('absence_circuit_assign_all', [a, [], ['cadre'], []]), /Réservé/);
  } finally { await t.db.close(); }
});

test('16. pré-avis par demande : qui valide A reçoit l\'avis pour B', async () => {
  const t = await mk();
  try {
    // circuit alternatif pour Urologie : la direction (2) valide en premier
    const uro = await circuit(t, 'Urologie', [...DIRECT.slice(0, 1), { pos: 10, kind: 'personnes', label: 'Direction', rule: 'any', blocking: true, active: true, persons: [uid(2)] }, DIRECT[1]]);
    await t.as(2); await t.rpc('absence_circuit_assign', [uro, 'clinic', ['Urologie']]);
    await t.sup(); await t.db.query("insert into member_clinic_changes(user_id, valid_from, clinics) values ($1,'2027-06-01','{Urologie}')", [uid(4)]);
    await t.as(4);
    const gen = (await t.rpc('absence_request', ['vacances', null, ...D1])).id, alt = (await t.rpc('absence_request', ['vacances', null, '2027-07-05', '2027-07-07'])).id;
    await t.rpc('absence_submit');
    const op = (await t.outbox('to_opinion')).filter((r) => r.recipient === uid(2));
    assert.equal(op.length, 1);
    assert.deepEqual(op[0].absence_ids.map(Number), [gen]);
    assert.ok((await t.outbox('to_validate')).some((r) => r.recipient === uid(2) && r.absence_ids.map(Number).includes(alt)));
  } finally { await t.db.close(); }
});

test('17. avertissement : attribution vers une clinique disparue ; journal des réordonnancements', async () => {
  const t = await mk();
  try {
    const a = await circuit(t, 'A'), b = await circuit(t, 'B');
    await t.as(2); await t.rpc('absence_circuit_assign', [a, 'clinic', ['Urologie']]);
    await t.sup(); await t.db.exec("delete from absence_clinic_settings where clinic='Urologie'");
    await t.as(2);
    assert.ok((await t.rpc('absence_circuit_overview')).warnings.some((w) => /Circuit « A » : la clinique « Urologie » n'existe plus/.test(w)));
    await t.rpc('absence_circuit_reorder', [[b, a]]);
    for (const id of [a, b, 1]) {
      const g = await t.rpc('absence_circuit_get', [id === 1 ? null : id]);
      assert.ok(g.log.some((l) => l.action === 'reorder'), 'journal ' + id);
    }
  } finally { await t.db.close(); }
});
