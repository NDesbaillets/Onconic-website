// Étape « cheffe de service » sur décision de la direction, suivi de la direction et PDF à tout moment (migration 202611230002), PGlite, données fictives.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
const root = new URL('../../', import.meta.url);
const read = (p) => readFile(new URL(p, root), 'utf8');
const uid = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

// 1 admin, 2 direction, 3 cadre validateur Thoracique, 4 médecin Thoracique, 5 cheffe de service (cadre non validateur, sans clinique), 6 médecin Gynécologie (sans validateur),
// 7 médecin Thoracique, 8 cadre sans lien avec les demandes, 9 secrétaire (assistante) du cadre 3, 10 médecin Thoracique
const PEOPLE = [[1, 'admin', []], [2, 'direction', []], [3, 'cadre', ['Thoracique']], [4, 'clinician', ['Thoracique']], [5, 'cadre', []], [6, 'clinician', ['Gynécologie']],
  [7, 'clinician', ['Thoracique']], [8, 'cadre', ['Urologie']], [9, 'assistant', []], [10, 'clinician', ['Thoracique']]];
const D = (n) => [`2027-0${n}-01`, `2027-0${n}-03`];

async function mk() {
  const db = new PGlite();
  const as = async (n) => { await db.exec('reset role'); await db.query("select set_config('test.uid',$1,false)", [n ? uid(n) : '']); await db.exec('set role authenticated'); };
  const sup = () => db.exec('reset role');
  const rpc = async (name, args = []) => { try { return Object.values((await db.query(`select public.${name}(${args.map((_, i) => '$' + (i + 1)).join(',')})`, args)).rows[0])[0]; } catch (e) { e.message += ` [${name}]`; throw e; } };
  const rows = async (sql, args = []) => (await db.query(sql, args)).rows;
  await db.exec(await read('tests/absences/fixture.sql'));
  await db.exec('alter table auth.users add column banned_until timestamptz;');
  await db.exec("alter table public.calendar_tokens add primary key (user_id); alter table public.calendar_tokens alter column token set default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');");
  for (const f of ['absences.sql', 'cadre_medecin.sql', 'cadre_validateur.sql', 'absences_validation.sql', 'absences_forms.sql', 'absences_cliniques_datees.sql', 'admin_direction.sql', 'absences_export.sql', 'absences_soldes.sql', 'absences_visibilite.sql', 'absences_preavis.sql', 'absences_vue_ensemble.sql'])
    await db.exec(await read('supabase/' + f));
  for (const f of ['202611110001_absence_hardening.sql', '202611120001_nurse_role.sql', '202611120002_assistant_default_tools.sql', '202611130001_securite_advisors.sql', '202611140001_absence_planning.sql', '202611160002_comptes_temporaires.sql', '202611170001_circuit_absences.sql'])
    await db.exec(await read('supabase/migrations/' + f));
  for (const [n, role, clinics] of PEOPLE) {
    await db.query('insert into auth.users(id,email) values($1,$2)', [uid(n), `esc${n}@example.com`]);
    await db.query('insert into profiles(id,full_name,role,institution,clinics,absence_validator) values($1,$2,$3,$4,$5,$6)', [uid(n), `Escalade ${n}`, role, 'CHUV', clinics, n === 3]);
  }
  await db.exec('reset role');
  await db.query("insert into absence_validators(clinic,user_id) values ('Thoracique',$1)", [uid(3)]);
  for (const f of ['202611180001_circuit_configurable.sql', '202611180002_agenda_ultragenda.sql', '202611230001_cliniques_hemato_tournus.sql', '202611230002_absences_suivi_cheffe.sql']) {
    const m = await read('supabase/migrations/' + f);
    await db.exec(m); await db.exec(m);
  }
  await as(2);
  await rpc('admin_set_cadre_secretary', [uid(9), true, [uid(3)]]);
  await sup();
  const request = async (n, [from, to], kind = 'vacances') => { await as(n); const id = (await rpc('absence_request', [kind, null, from, to])).id; await rpc('absence_submit'); return id; };
  const info = async (id) => { await sup(); return (await rows('select * from absences where id=$1', [id]))[0]; };
  const decide = async (n, id, ok = true, c = null) => { await as(n); return rpc('absence_decide', [id, ok, c]); };
  const outbox = async (kind) => { await sup(); return rows('select recipient, absence_ids, payload from absence_outbox where kind=$1 order by id', [kind]); };
  // désigne la cheffe de service (personne 5) dans l'étape sur décision du circuit général
  const designate = async (persons) => {
    await as(2);
    const g = await rpc('absence_circuit_get');
    const steps = g.steps.map((s) => ({ pos: s.pos, col: s.col, kind: s.kind, label: s.label, rule: s.rule, blocking: s.blocking, active: s.active, roles: s.roles, scope: s.scope,
      kinds: s.kinds, min_days: s.min_days, pdf_slot: s.pdf_slot, on_demand: s.on_demand, persons: s.on_demand ? persons.map(uid) : s.persons.map((p) => p.id) }));
    return rpc('absence_circuit_save', [JSON.stringify(steps)]);
  };
  return { db, as, sup, rpc, rows, request, info, decide, outbox, designate };
}

test('1. migration : étape par défaut sur décision, colonnes et réexécution', async () => {
  const t = await mk();
  try {
    await t.sup();
    const s = (await t.rows("select pos, col, kind, active, on_demand, persons, pdf_slot from absence_circuit_steps where kind = 'personnes'"))[0];
    assert.equal(s.on_demand, true); assert.equal(s.active, true); assert.deepEqual(s.persons, []); assert.equal(s.pdf_slot, 'chef_service');
    const cols = (await t.rows("select column_name from information_schema.columns where table_name = 'absences' and column_name like 'escalat%' order by 1")).map((r) => r.column_name);
    assert.deepEqual(cols, ['escalated_at', 'escalated_by', 'escalation_note']);
    // réexécution : l'étape redésactivée par l'administration n'est pas réactivée tant qu'elle n'est plus « sur décision »
    await t.sup();
    await t.db.exec("update absence_circuit_steps set on_demand = false where kind = 'personnes'");
    const m = await read('supabase/migrations/202611230002_absences_suivi_cheffe.sql');
    await t.db.exec(m);
    assert.equal((await t.rows("select on_demand from absence_circuit_steps where kind = 'personnes'"))[0].on_demand, false);
    await t.db.exec("update absence_circuit_steps set on_demand = true where kind = 'personnes'");
  } finally { await t.db.close(); }
});

test('2. éditeur de circuit : étape sur décision réservée aux colonnes après le visa', async () => {
  const t = await mk();
  try {
    await t.as(2);
    const g = await t.rpc('absence_circuit_get');
    const base = g.steps.map((s) => ({ pos: s.pos, col: s.col, kind: s.kind, label: s.label, rule: s.rule, blocking: s.blocking, active: s.active, roles: s.roles, scope: s.scope, kinds: s.kinds, min_days: s.min_days, pdf_slot: s.pdf_slot, on_demand: s.on_demand, persons: s.persons.map((p) => p.id) }));
    const save = (steps) => t.rpc('absence_circuit_save', [JSON.stringify(steps)]);
    // active sans personne : permis pour une étape sur décision
    const ok = await save(base);
    assert.equal(ok.steps.find((x) => x.kind === 'personnes').on_demand, true);
    // même colonne que le visa, ou avant : refusé
    await assert.rejects(save(base.map((s) => (s.kind === 'personnes' ? { ...s, col: 20 } : s))), /après celle du visa/);
    await assert.rejects(save(base.map((s) => (s.kind === 'personnes' ? { ...s, col: 5, pos: 5 } : s))), /après celle du visa|position|colonne/);
    // type non autorisé
    await assert.rejects(save(base.map((s) => (s.kind === 'clinique' ? { ...s, on_demand: true } : s))), /« personnes » ou « groupe »/);
    // visa inactif : refusé
    await assert.rejects(save(base.map((s) => (s.kind === 'visa' ? { ...s, active: false } : s))), /après celle du visa/);
    // un circuit copié garde le drapeau
    const cid = Number(await t.rpc('absence_circuit_create', ['Copie']));
    assert.equal((await t.rpc('absence_circuit_get', [cid])).steps.find((x) => x.kind === 'personnes').on_demand, true);
    // une étape « groupe » sur décision est permise
    const withGrp = [...base, { pos: 40, col: 40, kind: 'groupe', label: 'Finances', rule: 'any', blocking: true, active: true, roles: ['assistant'], scope: 'all', on_demand: true, persons: [] }];
    assert.equal((await save(withGrp)).steps.filter((x) => x.on_demand).length, 2);
    await save(base);
    // le simulateur et la vue d'ensemble montrent l'étape
    const sim = await t.rpc('absence_circuit_simulate', [uid(4), '2027-03-01', '2027-03-03']);
    const st = sim.steps.find((x) => x.kind === 'personnes');
    assert.equal(st.on_demand, true); assert.match(st.rule, /sur décision de la direction/); assert.match(st.note, /Aucune personne disponible/);
    assert.ok(sim.columns.some((c) => /Sur décision/.test(c.note || '')));
    assert.ok((await t.rpc('absence_circuit_overview')).warnings.some((w) => /Envoyer à la cheffe de service/.test(w)));
  } finally { await t.db.close(); }
});

test('3. sans décision de la direction : le circuit se conclut comme avant', async () => {
  const t = await mk();
  try {
    await t.designate([5]);
    const id = await t.request(4, D(3));
    assert.equal((await t.info(id)).stage, 10);
    await t.decide(3, id);
    assert.equal((await t.info(id)).stage, 20);
    // l'étape sur décision est masquée au demandeur
    await t.as(4);
    const mine = (await t.rows('select * from absence_list()')).find((r) => r.id == id);
    assert.ok(!mine.circuit.some((e) => e.kind === 'personnes'));
    assert.equal(await t.decide(2, id), 'approved');
    const a = await t.info(id);
    assert.equal(a.status, 'approved'); assert.equal(a.escalated_at, null);
    assert.equal((await t.rows('select 1 from absence_approvals where absence_id=$1 and step=30', [id])).length, 0);
    assert.equal((await t.outbox('form')).length, 1);
    assert.equal((await t.outbox('escalated')).length, 0);
  } finally { await t.db.close(); }
});

test('4. envoi à la cheffe de service : validée, puis refusée', async () => {
  const t = await mk();
  try {
    await t.designate([5]);
    const id = await t.request(4, D(3));
    await t.decide(3, id);
    // le bouton : disponible pour la direction, absent pour le cadre de la première ligne et pour le demandeur
    await t.as(2);
    let todo = (await t.rows('select * from absence_to_validate()')).find((r) => r.id == id);
    assert.equal(todo.escalation.available, true); assert.match(todo.escalation.label, /cheffe de service/); assert.equal(todo.escalated, null);
    assert.equal((await t.rpc('absence_visa_escalate', [id, 'x'.repeat(500)])).length > 0, true);
    const a = await t.info(id);
    assert.equal(a.status, 'requested'); assert.equal(a.stage, 30); assert.equal(a.escalated_by, uid(2)); assert.equal(a.direction_by, uid(2)); assert.equal(a.escalation_note.length, 500);
    // la cheffe est sollicitée, le demandeur informé
    assert.deepEqual((await t.outbox('to_validate')).filter((r) => r.recipient === uid(5)).length, 1);
    const esc = await t.outbox('escalated'); assert.equal(esc.length, 1); assert.equal(esc[0].recipient, uid(4));
    assert.equal((await t.rows("select 1 from absence_approvals where absence_id=$1 and step=30 and validator_id=$2 and decision='pending'", [id, uid(5)])).length, 1);
    // le demandeur voit l'étape, la cheffe voit la demande avec la note
    await t.as(4);
    assert.ok((await t.rows('select * from absence_list()')).find((r) => r.id == id).circuit.some((e) => e.kind === 'personnes' && e.current));
    await t.as(5);
    todo = (await t.rows('select * from absence_to_validate()')).find((r) => r.id == id);
    assert.equal(todo.escalated.note.length, 500); assert.equal(todo.escalation, null); assert.equal(todo.steps[0].mine, true);
    // une seconde demande d'envoi est refusée
    await t.as(2);
    await assert.rejects(t.rpc('absence_visa_escalate', [id, null]), /déjà été envoyée/);
    // la cheffe valide : la demande est conclue, son nom va dans la case du chef de service du PDF
    assert.equal(await t.decide(5, id), 'approved');
    assert.equal((await t.info(id)).status, 'approved');
    await t.sup();
    const doc = (await t.rows("select data from absence_documents where $1 = any(absence_ids) order by id desc limit 1", [id]))[0].data;
    assert.equal(doc.extra.length, 1); assert.equal(doc.extra[0].slot, 'chef_service'); assert.equal(doc.extra[0].name, 'Escalade 5');
    assert.equal(doc.direction.name, 'Escalade 2');
    assert.equal((await t.outbox('form')).length, 1);

    // refus par la cheffe : commentaire obligatoire, demandeur prévenu
    const id2 = await t.request(4, D(4));
    await t.decide(3, id2);
    await t.as(2); await t.rpc('absence_visa_escalate', [id2, null]);
    await t.as(5);
    await assert.rejects(t.rpc('absence_decide', [id2, false, '']), /commentaire/);
    assert.equal(await t.decide(5, id2, false, 'Période chargée'), 'rejected');
    const b = await t.info(id2);
    assert.equal(b.status, 'rejected'); assert.equal(b.decided_by, uid(5)); assert.equal(b.decision_comment, 'Période chargée');
    assert.ok((await t.outbox('rejected')).some((r) => r.recipient === uid(4) && r.absence_ids.map(Number).includes(Number(id2))));

    // un nouveau tour efface l'envoi
    const id3 = await t.request(7, D(5));
    await t.decide(3, id3); await t.as(2); await t.rpc('absence_visa_escalate', [id3, 'note']);
    await t.sup(); await t.db.exec(`select public.absence_open_round(${id3})`);
    const c = await t.info(id3); assert.equal(c.escalated_at, null); assert.equal(c.escalation_note, null);
  } finally { await t.db.close(); }
});

test('5. envoi refusé : sans personne désignée, mauvaise personne, mauvais stade ; administrateur et demande de changement', async () => {
  const t = await mk();
  try {
    const id = await t.request(4, D(3));
    // au premier stade : pas de bouton, pas d'envoi
    await t.as(2);
    assert.equal((await t.rows('select * from absence_to_validate()')).find((r) => r.id == id)?.escalation ?? null, null);
    await assert.rejects(t.rpc('absence_visa_escalate', [id, null]), /ne peut pas être envoyée/);
    await t.decide(3, id);
    // sans personne désignée : bouton inactif avec raison, envoi refusé
    await t.as(2);
    const todo = (await t.rows('select * from absence_to_validate()')).find((r) => r.id == id);
    assert.equal(todo.escalation.available, false); assert.match(todo.escalation.reason, /désign/);
    await assert.rejects(t.rpc('absence_visa_escalate', [id, null]), /Aucune personne n'est désignée/);
    assert.equal((await t.info(id)).stage, 20);
    await t.designate([5]);
    // le cadre, le demandeur et un tiers ne peuvent pas ; la note est limitée à 500 caractères
    for (const n of [3, 4, 5, 8]) { await t.as(n); await assert.rejects(t.rpc('absence_visa_escalate', [id, null]), /ne peut pas|Accès|autorisé|outil/i, 'n=' + n); }
    await t.as(2);
    await assert.rejects(t.rpc('absence_visa_escalate', [id, 'x'.repeat(501)]), /trop longue/);
    assert.equal((await t.info(id)).escalated_at, null);
    // l'administrateur peut envoyer
    await t.as(1); assert.ok(await t.rpc('absence_visa_escalate', [id, null]));
    assert.equal((await t.info(id)).stage, 30); assert.equal((await t.info(id)).direction_by, uid(1));
    await t.decide(5, id);
    assert.equal((await t.info(id)).status, 'approved');

    // demande de changement qui passe par le visa
    await t.as(4);
    await t.rpc('absence_request_change', [id, 'delete', null, null, null, null]);
    await t.decide(3, id);
    await t.as(2);
    assert.equal((await t.rows('select * from absence_to_validate()')).find((r) => r.id == id).escalation.available, true);
    await t.rpc('absence_visa_escalate', [id, null]);
    assert.equal((await t.info(id)).stage, 30);
    assert.equal((await t.outbox('to_validate_change')).filter((r) => r.recipient === uid(5)).length, 1);
    await t.decide(5, id);
    assert.equal((await t.info(id)).status, 'cancelled');

    // la direction ne se vise pas elle-même ; l'administrateur le peut
    await t.sup(); await t.db.exec("update profiles set clinics = '{Gynécologie}' where id = '" + uid(2) + "'");
    const own = await t.request(2, D(6));
    await t.as(2);
    assert.equal((await t.rows('select * from absence_to_validate()')).find((r) => r.id == own)?.escalation ?? null, null);
    await assert.rejects(t.rpc('absence_visa_escalate', [own, null]), /ne peut pas|Accès|autorisé/i);
  } finally { await t.db.close(); }
});

test('6. suivi : droits, fenêtre et contenu du parcours', async () => {
  const t = await mk();
  try {
    await t.designate([5]);
    const id = await t.request(4, D(3));
    await t.as(2); await t.rpc('absence_opinion_set', [id, 'favorable', 'RAS']);
    await t.decide(3, id, true, 'ok cadre');
    await t.as(2); await t.rpc('absence_visa_escalate', [id, 'à signer']);
    const id2 = await t.request(6, D(3));
    const id3 = await t.request(7, D(4));
    await t.decide(3, id3, false, 'trop tard');
    await t.as(4); await t.rpc('absence_request', ['vacances', null, '2027-08-01', '2027-08-02']); // brouillon : exclu

    for (const n of [3, 4, 5, 8, 9, 10]) { await t.as(n); await assert.rejects(t.rpc('absence_track', ['2027-01-01', '2027-12-31']), /Réservé/, 'n=' + n); }
    await t.as(2);
    await assert.rejects(t.rpc('absence_track', ['2027-01-01', '2029-12-31']), /trop longue/);
    await assert.rejects(t.rpc('absence_track', ['2027-12-31', '2027-01-01']), /invalide/);
    const rows = await t.rows('select * from absence_track($1,$2)', ['2027-01-01', '2027-12-31']);
    assert.equal(rows.length, 3);
    const r1 = rows.find((r) => r.id == id);
    assert.equal(r1.name, 'Escalade 4'); assert.equal(r1.role, 'clinician'); assert.deepEqual(r1.clinics, ['Thoracique']); assert.equal(r1.status, 'requested');
    assert.equal(r1.escalated, true); assert.match(r1.step_label, /cheffe de service/);
    const tr = r1.trail;
    assert.equal(tr.opinions.length, 1); assert.equal(tr.opinions[0].opinion, 'favorable');
    const byKind = (k) => tr.steps.find((s) => s.kind === k);
    assert.equal(byKind('clinique').state, 'validée'); assert.equal(byKind('clinique').people[0].state, 'validé'); assert.equal(byKind('clinique').people[0].comment, 'ok cadre');
    assert.equal(byKind('visa').state, 'validée'); assert.equal(byKind('visa').people[0].name, 'Escalade 2');
    assert.equal(byKind('personnes').state, 'en cours'); assert.equal(byKind('personnes').on_demand, true); assert.equal(byKind('personnes').people[0].state, 'en attente');
    assert.equal(tr.escalation.note, 'à signer'); assert.equal(tr.escalation.by, 'Escalade 2'); assert.equal(tr.final, null);
    // sans validateur ni envoi : première ligne sautée, visa en cours, étape sur décision « non demandée »
    const r2 = rows.find((r) => r.id == id2).trail;
    assert.equal(r2.steps.find((s) => s.kind === 'clinique').state, 'sautée');
    assert.equal(r2.steps.find((s) => s.kind === 'visa').state, 'en cours'); assert.equal(r2.steps.find((s) => s.kind === 'visa').people[0].state, 'en attente');
    assert.equal(r2.steps.find((s) => s.kind === 'personnes').state, 'non demandée');
    assert.equal(rows.find((r) => r.id == id2).escalated, false);
    // refusée : décision finale
    const r3 = rows.find((r) => r.id == id3);
    assert.equal(r3.status, 'rejected'); assert.equal(r3.trail.final.decision, 'rejected'); assert.equal(r3.trail.final.comment, 'trop tard'); assert.equal(r3.trail.final.by, 'Escalade 3');
    assert.equal(r3.trail.steps.find((s) => s.kind === 'clinique').state, 'refusée'); assert.equal(r3.trail.steps.find((s) => s.kind === 'visa').state, 'sautée');
    // validée : la décision et le journal figurent
    await t.decide(5, id);
    await t.as(2);
    const done = (await t.rows('select * from absence_track($1,$2)', ['2027-03-01', '2027-03-31'])).find((r) => r.id == id);
    assert.equal(done.status, 'approved'); assert.equal(done.trail.final.decision, 'approved'); assert.equal(done.trail.steps.find((s) => s.kind === 'personnes').state, 'validée');
    assert.ok(done.trail.history.length >= 1);
    // la fenêtre filtre
    assert.equal((await t.rows('select * from absence_track($1,$2)', ['2027-06-01', '2027-06-30'])).length, 0);
    await t.as(1); assert.equal((await t.rows('select * from absence_track($1,$2)', ['2027-03-01', '2027-04-30'])).length, 3);
  } finally { await t.db.close(); }
});

test('7. PDF à tout moment : accès par statut et par personne, contenu de l\'état actuel', async () => {
  const t = await mk();
  try {
    await t.designate([5]);
    const acc = async (n, ids) => { await t.sup(); return (await t.rows('select public.absence_pdf_access($1,$2) as ok', [uid(n), ids]))[0].ok; };
    const cur = async (ids) => { await t.sup(); return (await t.rows('select public.absence_form_current($1) as d', [ids]))[0].d; };
    const id = await t.request(4, D(3));
    const draft = (await (async () => { await t.as(4); return (await t.rpc('absence_request', ['vacances', null, '2027-09-01', '2027-09-02'])).id; })());
    // demandée : l'intéressé, les validateurs, la direction, l'administration, la secrétaire du cadre 3 (cadre, pas du médecin) : seuls les premiers
    const who = {}; for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) who[n] = await acc(n, [id]);
    assert.deepEqual(who, { 1: true, 2: true, 3: true, 4: true, 5: false, 6: false, 7: false, 8: false, 9: false, 10: false });
    assert.equal(await acc(4, [draft]), false); assert.equal(await acc(2, [draft]), false); assert.equal(await acc(1, [draft]), false);
    assert.equal(await acc(4, [id, draft]), false);
    // PDF de l'état actuel : rien de signé
    let d = await cur([id]);
    assert.equal(d.live, true); assert.equal(d.role, 'clinician'); assert.deepEqual(d.signers, []); assert.equal(d.direction, null); assert.deepEqual(d.extra, []); assert.equal(d.refusal, null);
    assert.equal(d.absences[0].status, 'requested');
    // premier validateur : signature donnée
    await t.decide(3, id);
    d = await cur([id]); assert.equal(d.signers.length, 1); assert.equal(d.signers[0].name, 'Escalade 3'); assert.equal(d.direction, null);
    // visa avec envoi : la cheffe est sollicitée, donc autorisée
    await t.as(2); await t.rpc('absence_visa_escalate', [id, null]);
    assert.equal(await acc(5, [id]), true); assert.equal(await acc(8, [id]), false);
    d = await cur([id]); assert.equal(d.direction.name, 'Escalade 2'); assert.deepEqual(d.extra, []);
    await t.decide(5, id);
    // validée : document figé, comportement inchangé
    d = await cur([id]); assert.equal(d.live, false); assert.ok(d.document_id > 0); assert.equal(d.extra[0].name, 'Escalade 5');
    assert.equal(await acc(10, [id]), false);
    // refusée par le cadre : « Défavorable », nom, heure, commentaire
    const rj = await t.request(7, D(4));
    await t.decide(3, rj, false, 'Effectif insuffisant');
    d = await cur([rj]);
    assert.equal(d.live, true); assert.equal(d.refusal.name, 'Escalade 3'); assert.equal(d.refusal.comment, 'Effectif insuffisant'); assert.equal(d.refusal.kind, 'clinique');
    assert.equal(await acc(7, [rj]), true); assert.equal(await acc(5, [rj]), false);
    // refusée au visa
    const rv = await t.request(10, D(5));
    await t.decide(3, rv); await t.decide(2, rv, false, 'Non');
    d = await cur([rv]); assert.equal(d.refusal.name, 'Escalade 2'); assert.equal(d.refusal.kind, 'visa'); assert.equal(d.signers.length, 1);
    // refusée par la cheffe : emplacement du chef de service
    const rc = await t.request(4, D(6));
    await t.decide(3, rc); await t.as(2); await t.rpc('absence_visa_escalate', [rc, null]); await t.decide(5, rc, false, 'Non merci');
    d = await cur([rc]); assert.equal(d.refusal.name, 'Escalade 5'); assert.equal(d.refusal.slot, 'chef_service'); assert.equal(d.refusal.comment, 'Non merci'); assert.equal(d.direction.name, 'Escalade 2');
    // annulée : ni accès ni document
    await t.sup(); await t.db.query("update absences set status = 'cancelled' where id = $1", [rv]);
    assert.equal(await acc(10, [rv]), false); assert.equal(await cur([rv]), null);
    // rôle sans formulaire : pas de formulaire
    await t.sup(); await t.db.query("update absences set status = 'requested' where id = $1", [rv]);
    const asst = await t.request(9, D(7));
    assert.equal((await cur([asst])).no_form, true);
    // commentaire du refus masqué pour une absence confidentielle
    await t.sup(); await t.db.query("update absences set confidential = true where id = $1", [rj]);
    assert.equal((await cur([rj])).refusal.comment, null);
  } finally { await t.db.close(); }
});

test('8. droits SQL : fonctions internes fermées, fonctions de page réservées aux utilisateurs connectés', async () => {
  const t = await mk();
  try {
    await t.sup();
    const can = async (role, fn) => (await t.rows('select has_function_privilege($1, $2, \'execute\') as ok', [role, fn]))[0].ok;
    for (const fn of ['absence_escalation_state(uuid, public.absences)', 'absence_solicited_people(public.absences)', 'absence_document_build(bigint[], text, boolean)', 'absence_track_trail(public.absences)', 'absence_document_create(bigint[], text)']) {
      for (const r of ['anon', 'authenticated']) assert.equal(await can(r, 'public.' + fn), false, r + ' ' + fn);
    }
    for (const fn of ['absence_visa_escalate(bigint, text)', 'absence_track(date, date)', 'absence_to_validate()']) {
      assert.equal(await can('anon', 'public.' + fn), false, 'anon ' + fn); assert.equal(await can('authenticated', 'public.' + fn), true, 'auth ' + fn);
    }
    for (const fn of ['absence_pdf_access(uuid, bigint[])', 'absence_form_current(bigint[])']) {
      assert.equal(await can('anon', 'public.' + fn), false); assert.equal(await can('authenticated', 'public.' + fn), false); assert.equal(await can('service_role', 'public.' + fn), true);
    }
    // les fonctions de page vérifient les droits dans leur corps
    await t.as(4);
    await assert.rejects(t.rpc('absence_visa_escalate', [1, null]), /Absence introuvable|ne peut pas/);
    await assert.rejects(t.rpc('absence_track', ['2027-01-01', '2027-02-01']), /Réservé/);
  } finally { await t.db.close(); }
});

test('9. corrections : réacheminement, document figé, parcours d\u2019un visa refusé, fenêtre des changements, étape sur décision retrouvée', async () => {
  const t = await mk();
  try {
    await t.designate([5]);
    // demande sans validateur de clinique : le visa envoie à la cheffe ; un réacheminement ne la rouvre pas
    const id = await t.request(6, D(3));
    await t.as(2); await t.rpc('absence_visa_escalate', [id, null]);
    await t.sup(); await t.db.exec(`select public.absence_reroute('${uid(6)}')`);
    let a = await t.info(id);
    assert.equal(a.stage, 30); assert.notEqual(a.escalated_at, null);

    // document figé : identique à l'ancien comportement (visa d'un tour antérieur conservé, aucune clé refusal), lot mixte compris
    const b = await t.request(4, D(4));
    const c = await t.request(4, D(5));
    await t.decide(3, b); await t.as(2); await t.rpc('absence_visa_escalate', [b, null]); await t.decide(5, b);
    await t.sup();
    await t.db.query("update absences set direction_by = $1, direction_at = '2020-01-01' where id = $2", [uid(2), c]);
    const doc = async (ids) => { const k = (await t.rows('select public.absence_document_create($1) as k'.replace('($1)', '($1, \'test\')'), [ids]))[0].k; return (await t.rows('select data from absence_documents where id = $1', [k]))[0].data; };
    const mixed = await doc([b, c]);
    assert.ok(!('refusal' in mixed)); assert.equal(mixed.direction.name, 'Escalade 2'); assert.equal(mixed.absences.length, 2);
    const stale = await doc([c]);
    assert.ok(!('refusal' in stale)); assert.equal(stale.direction.name, 'Escalade 2');
    // état actuel : la même demande n'a pas de visa valable
    assert.equal((await t.rows('select public.absence_form_current($1) as d', [[c]]))[0].d.direction, null);

    // refus au visa : étape « refusée » avec nom, heure et motif ; étapes suivantes « sautée »
    const rv = await t.request(10, D(6));
    await t.decide(3, rv); await t.decide(2, rv, false, 'Non');
    await t.as(2);
    const row = (await t.rows('select * from absence_track($1,$2)', ['2027-01-01', '2027-12-31'])).find((r) => r.id == rv);
    const visa = row.trail.steps.find((s) => s.kind === 'visa');
    assert.equal(visa.state, 'refusée'); assert.equal(visa.people[0].name, 'Escalade 2'); assert.equal(visa.people[0].comment, 'Non'); assert.ok(visa.people[0].at);
    assert.equal(row.trail.steps.find((s) => s.kind === 'personnes').state, 'non demandée');

    // fenêtre du suivi : tient compte des dates d'une demande de changement
    const cm = await t.request(7, D(7)); await t.decide(3, cm); await t.decide(2, cm);
    await t.as(7); await t.rpc('absence_request_change', [cm, 'modify', 'vacances', null, '2027-11-01', '2027-11-03']);
    await t.as(2);
    assert.equal((await t.rows('select * from absence_track($1,$2)', ['2027-11-01', '2027-11-30'])).filter((r) => r.id == cm).length, 1);
    assert.equal((await t.rows('select * from absence_track($1,$2)', ['2027-10-01', '2027-10-31'])).filter((r) => r.id == cm).length, 0);

    // étape sur décision retrouvée par type et circuit, sans lien de position : la désignation change après le dépôt
    const late = await t.request(4, D(8)); await t.decide(3, late);
    await t.designate([8]);
    await t.as(2);
    assert.equal((await t.rows('select * from absence_to_validate()')).find((r) => r.id == late).escalation.available, true);
    await t.rpc('absence_visa_escalate', [late, null]);
    assert.equal((await t.rows("select validator_id from absence_approvals where absence_id = $1 and decision = 'pending'", [late]))[0].validator_id, uid(8));
  } finally { await t.db.close(); }
});
