// Historique des demandes (plus de purge, archivage), numéro unique de demande AAAA-NNNN et recherche par numéro (migration 202611270001), PGlite, données fictives.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
const root = new URL('../../', import.meta.url);
const read = (p) => readFile(new URL(p, root), 'utf8');
const uid = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

// 1 admin, 2 direction, 3 cadre validateur Thoracique, 4 médecin Thoracique, 5 médecin Thoracique (autre membre), 6 cadre validateur Urologie, 7 médecin Urologie,
// 8 secrétaire (assistante) du cadre 3, 9 médecin Gynécologie sans lien avec les autres
const PEOPLE = [[1, 'admin', []], [2, 'direction', []], [3, 'cadre', ['Thoracique']], [4, 'clinician', ['Thoracique']], [5, 'clinician', ['Thoracique']], [6, 'cadre', ['Urologie']],
  [7, 'clinician', ['Urologie']], [8, 'assistant', []], [9, 'clinician', ['Gynécologie']]];
// deux jours ouvrables distincts par numéro n (aucun chevauchement entre absences d'une même personne)
const dd = (n) => { const d = new Date(Date.UTC(2027, 0, 4 + 7 * n)); const e = new Date(Date.UTC(2027, 0, 5 + 7 * n)); return [d.toISOString().slice(0, 10), e.toISOString().slice(0, 10)]; };

async function mk({ migrate = true } = {}) {
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
    await db.query('insert into auth.users(id,email) values($1,$2)', [uid(n), `hist${n}@example.com`]);
    await db.query('insert into profiles(id,full_name,role,institution,clinics,absence_validator) values($1,$2,$3,$4,$5,$6)', [uid(n), `Historique ${n}`, role, 'CHUV', clinics, n === 3 || n === 6]);
  }
  await db.exec('reset role');
  await db.query("insert into absence_validators(clinic,user_id) values ('Thoracique',$1),('Urologie',$2)", [uid(3), uid(6)]);
  const files = ['202611180001_circuit_configurable.sql', '202611180002_agenda_ultragenda.sql', '202611230001_cliniques_hemato_tournus.sql', '202611230002_absences_suivi_cheffe.sql'];
  for (const f of files) { const m = await read('supabase/migrations/' + f); await db.exec(m); await db.exec(m); }
  const mine = await read('supabase/migrations/202611270001_absences_historique_numero.sql');
  const apply = async () => { await db.exec(mine); await db.exec(mine); };
  if (migrate) await apply();
  await as(2);
  await rpc('admin_set_cadre_secretary', [uid(8), true, [uid(3)]]);
  await sup();
  const draft = async (n, d, kind = 'vacances', note = null) => { await as(n); return (await rpc('absence_request', [kind, note, d[0], d[1]])).id; };
  const request = async (n, d, kind = 'vacances', note = null) => { const id = await draft(n, d, kind, note); await rpc('absence_submit'); return id; };
  const decide = async (n, id, ok = true, c = null) => { await as(n); return rpc('absence_decide', [id, ok, c]); };
  const info = async (id) => { await sup(); return (await rows('select * from absences where id=$1', [id]))[0]; };
  const no = async (id) => (await info(id)).request_no;
  const ids = async (n, fn, args = []) => { await as(n); const r = (await rows(`select id from public.${fn}(${args.map((_, i) => '$' + (i + 1)).join(',')})`, args)).map((x) => Number(x.id)); await sup(); return r.sort((a, b) => a - b); };
  const year = async () => (await rows("select extract(year from now() at time zone 'Europe/Zurich')::int y"))[0].y;
  return { db, as, sup, rpc, rows, draft, request, decide, info, no, ids, year, apply };
}

test('1. numérotation : séquence, brouillon sans numéro, année de Zurich, au-delà de 9999, numéro immuable et unique', async () => {
  const t = await mk();
  try {
    const y = await t.year();
    // un brouillon n'a pas de numéro
    const d0 = await t.draft(4, dd(0));
    assert.equal(await t.no(d0), null);
    // premier envoi : séquence AAAA-0001, 0002, ... (un compteur par année)
    await t.as(4); await t.rpc('absence_submit');
    const a = d0;
    const b = await t.request(5, dd(0));
    const c = await t.request(7, dd(0));
    assert.equal(await t.no(a), `${y}-0001`);
    assert.equal(await t.no(b), `${y}-0002`);
    assert.equal(await t.no(c), `${y}-0003`);
    assert.equal((await t.rows('select last from absence_request_counters where year = $1', [y]))[0].last, 3);
    // un second brouillon reste sans numéro tant qu'il n'est pas envoyé
    const d1 = await t.draft(4, dd(1));
    assert.equal(await t.no(d1), null);
    // ajout validé d'office par la direction : numéroté immédiatement
    await t.as(2);
    const added = (await t.rpc('absence_direction_add', [uid(5), 'vacances', null, dd(2)[0], dd(2)[1], false])).id;
    assert.equal(await t.no(added), `${y}-0004`);
    // année civile de Zurich de la soumission : le 31.12 à 23h30 UTC est déjà le 1er janvier à Zurich
    await t.sup();
    await t.db.query("update absences set status = 'requested', submitted_at = '2029-12-31T23:30:00Z' where id = $1", [d1]);
    assert.equal(await t.no(d1), '2030-0001');
    const d2 = await t.draft(4, dd(3));
    await t.sup();
    await t.db.query("update absences set status = 'requested', submitted_at = '2030-06-01T10:00:00+02:00' where id = $1", [d2]);
    assert.equal(await t.no(d2), '2030-0002');
    // au-delà de 9999 : le nombre s'écrit en entier, sans troncature
    await t.db.query('insert into absence_request_counters(year, last) values (2031, 9999)');
    const d3 = await t.draft(4, dd(4)), d4 = await t.draft(4, dd(5));
    await t.sup();
    await t.db.query("update absences set status = 'requested', submitted_at = '2031-03-01T10:00:00+01:00' where id = $1", [d3]);
    await t.db.query("update absences set status = 'requested', submitted_at = '2031-03-02T10:00:00+01:00' where id = $1", [d4]);
    assert.equal(await t.no(d3), '2031-10000');
    assert.equal(await t.no(d4), '2031-10001');
    // le numéro ne se modifie ni ne s'efface
    await assert.rejects(t.db.query("update absences set request_no = '2099-0001' where id = $1", [a]), /ni modifié ni effacé/);
    await assert.rejects(t.db.query('update absences set request_no = null where id = $1', [a]), /ni modifié ni effacé/);
    assert.equal(await t.no(a), `${y}-0001`);
    // unicité : un numéro déjà pris est refusé par l'index
    await assert.rejects(t.db.query("insert into absences(user_id, kind, start_date, end_date, status, request_no) values ($1, 'vacances', '2027-09-01', '2027-09-02', 'requested', $2)", [uid(9), `${y}-0001`]), /unique|duplicate/i);
    // la colonne et l'index existent
    assert.equal((await t.rows("select count(*)::int n from pg_indexes where indexname = 'absences_request_no_key'"))[0].n, 1);
  } finally { await t.db.close(); }
});

test('2. le numéro reste le même : refus, modification, nouvel envoi, annulation', async () => {
  const t = await mk();
  try {
    const id = await t.request(4, dd(0));
    const n0 = await t.no(id);
    assert.match(n0, /^\d{4}-\d{4}$/);
    await t.decide(3, id, false, 'Motif du refus');
    assert.equal((await t.info(id)).status, 'rejected');
    assert.equal(await t.no(id), n0);
    // modifier une demande refusée la remet en brouillon : le numéro est conservé
    await t.as(4); await t.rpc('absence_update', [id, 'vacances', null, dd(1)[0], dd(1)[1]]);
    let a = await t.info(id);
    assert.equal(a.status, 'draft'); assert.equal(a.request_no, n0);
    // nouvel envoi : même numéro, le compteur n'avance pas
    const last = (await t.rows('select last from absence_request_counters order by year desc limit 1'))[0].last;
    await t.as(4); await t.rpc('absence_submit');
    a = await t.info(id);
    assert.equal(a.status, 'requested'); assert.equal(a.request_no, n0);
    assert.equal((await t.rows('select last from absence_request_counters order by year desc limit 1'))[0].last, last);
    // une autre demande reçoit le numéro suivant, pas celui libéré
    const other = await t.request(5, dd(0));
    assert.notEqual(await t.no(other), n0);
    // annulation : même numéro
    await t.as(4); await t.rpc('absence_withdraw', [id]);
    a = await t.info(id);
    assert.equal(a.status, 'cancelled'); assert.equal(a.request_no, n0);
    // une demande validée, puis modification demandée et acceptée : même numéro
    const ok = await t.request(7, dd(0));
    await t.decide(1, ok);
    const nOk = await t.no(ok);
    await t.as(7); await t.rpc('absence_request_change', [ok, 'modify', 'vacances', null, dd(2)[0], dd(2)[1]]);
    await t.decide(1, ok);
    assert.equal(await t.no(ok), nOk);
  } finally { await t.db.close(); }
});

test('3. reprise : les demandes existantes sont numérotées par année de dépôt, ordre chronologique puis id, et la migration se rejoue', async () => {
  const t = await mk({ migrate: false });
  try {
    await t.sup();
    const ins = async (user, status, submitted, created) => Number((await t.rows(
      "insert into absences(user_id, kind, start_date, end_date, status, submitted_at, created_at) values ($1::uuid, 'vacances', $2::date, $3::date, $4::text, $5::timestamptz, coalesce($6::timestamptz, $5::timestamptz, now())) returning id",
      [uid(user), '2027-02-01', '2027-02-02', status, submitted, created]))[0].id);
    const A = await ins(4, 'approved', '2026-03-02T10:00:00+01:00', '2026-03-01T10:00:00+01:00');
    const B = await ins(5, 'rejected', '2026-01-05T09:00:00+01:00', null); // plus ancienne, insérée plus tard
    const C = await ins(7, 'requested', '2027-02-01T09:00:00+01:00', null);
    const Dr = await ins(4, 'draft', null, '2026-05-01T09:00:00+02:00');
    const E = await ins(5, 'cancelled', '2026-03-02T10:00:00+01:00', null); // même instant que A : l'id départage
    const F = await ins(7, 'approved', null, '2026-12-31T23:30:00Z'); // jamais envoyée : année de création à Zurich (2027)
    await t.apply();
    const no = async (id) => (await t.rows('select request_no from absences where id = $1', [id]))[0].request_no;
    assert.equal(await no(B), '2026-0001');
    assert.equal(await no(A), '2026-0002');
    assert.equal(await no(E), '2026-0003');
    assert.equal(await no(C), '2027-0002');
    assert.equal(await no(F), '2027-0001');
    assert.equal(await no(Dr), null);
    const cnt = Object.fromEntries((await t.rows('select year, last from absence_request_counters')).map((r) => [r.year, r.last]));
    assert.deepEqual(cnt, { 2026: 3, 2027: 2 });
    // réexécution : rien ne change ; la suite de la numérotation repart des compteurs
    const before = JSON.stringify(await t.rows('select id, request_no from absences order by id'));
    await t.apply();
    assert.equal(JSON.stringify(await t.rows('select id, request_no from absences order by id')), before);
    await t.db.query("update absences set status = 'requested', submitted_at = '2026-12-01T10:00:00+01:00' where id = $1", [Dr]);
    assert.equal(await no(Dr), '2026-0004');
  } finally { await t.db.close(); }
});

test('4. plus de purge : un refus de plus de 14 jours reste en base, absent des listes actives, présent dans l\'historique', async () => {
  const t = await mk();
  try {
    const id = await t.request(4, dd(0));
    await t.decide(3, id, false, 'Refus fictif');
    const recent = await t.request(5, dd(0));
    await t.decide(3, recent, false, 'Refus récent fictif');
    // le refus de 4 date de 30 jours
    await t.sup();
    await t.db.query("update absences set decided_at = now() - interval '30 days' where id = $1", [id]);
    // la purge est un no-op, même appelée explicitement ou par un envoi
    await t.sup(); await t.db.exec('select public.absence_purge()');
    await t.as(4); await t.rpc('absence_request', ['vacances', null, dd(1)[0], dd(1)[1]]); await t.rpc('absence_submit');
    await t.sup();
    assert.equal((await t.rows('select count(*)::int n from absences where id = $1', [id]))[0].n, 1);
    assert.equal((await t.rows('select count(*)::int n from absences where id = $1', [recent]))[0].n, 1);
    // listes actives : Mes absences, À valider (refusées à gérer), Suivi
    assert.ok(!(await t.ids(4, 'absence_list')).includes(Number(id)));
    assert.ok((await t.ids(5, 'absence_list')).includes(Number(recent)));
    assert.ok(!(await t.ids(3, 'absence_rejected_to_manage')).includes(Number(id)));
    assert.ok((await t.ids(3, 'absence_rejected_to_manage')).includes(Number(recent)));
    assert.ok(!(await t.ids(2, 'absence_track', ['2027-01-01', '2027-12-31'])).includes(Number(id)));
    assert.ok((await t.ids(2, 'absence_track', ['2027-01-01', '2027-12-31'])).includes(Number(recent)));
    // le planning ne montre aucune demande refusée
    await t.as(4);
    const grid = await t.rows('select id, status from absence_grid($1, $2)', ['2027-01-01', '2027-12-31']);
    assert.ok(!grid.some((g) => g.status === 'rejected'));
    // l'historique garde les deux
    const h = await t.ids(2, 'absence_requests_history');
    assert.ok(h.includes(Number(id)) && h.includes(Number(recent)));
    await t.as(4);
    const mine = (await t.rows('select * from absence_requests_history()')).find((r) => Number(r.id) === Number(id));
    assert.equal(mine.status, 'rejected'); assert.equal(mine.decision, 'rejected'); assert.equal(mine.decision_comment, 'Refus fictif');
    assert.equal(mine.decided_by_name, 'Historique 3'); assert.ok(mine.decided_at); assert.match(mine.request_no, /^\d{4}-\d{4}$/);
    // le journal des décisions est inchangé
    await t.sup();
    assert.ok((await t.rows('select count(*)::int n from absence_decision_log where absence_id = $1', [id]))[0].n >= 1);
  } finally { await t.db.close(); }
});

test('5. archivage au lieu de suppression : absence_delete_rejected, absence_withdraw, absence_withdraw_for', async () => {
  const t = await mk();
  try {
    // archivage par l'usager
    const r1 = await t.request(4, dd(0));
    await t.decide(3, r1, false, 'Refus un');
    await t.as(4); await t.rpc('absence_delete_rejected', [r1]);
    let a = await t.info(r1);
    assert.ok(a.archived_at); assert.equal(a.archived_by, uid(4)); assert.equal(a.status, 'rejected');
    assert.ok(!(await t.ids(4, 'absence_list')).includes(Number(r1)));
    await t.as(4); await t.rpc('absence_delete_rejected', [r1]); // idempotent
    assert.ok((await t.ids(4, 'absence_requests_history')).includes(Number(r1)));
    await t.as(4);
    assert.ok((await t.rows('select * from absence_requests_history()')).find((r) => Number(r.id) === Number(r1)).archived_at);
    // archivage par un validateur ; refus pour un tiers sans droit
    const r2 = await t.request(5, dd(0));
    await t.decide(3, r2, false, 'Refus deux');
    await t.as(7); await assert.rejects(t.rpc('absence_delete_rejected', [r2]), /Accès refusé/);
    await t.as(4); await assert.rejects(t.rpc('absence_delete_rejected', [r2]), /Accès refusé/);
    assert.ok(!(await t.info(r2)).archived_at);
    assert.ok((await t.ids(3, 'absence_rejected_to_manage')).includes(Number(r2)));
    await t.as(3); await t.rpc('absence_delete_rejected', [r2]);
    assert.ok((await t.info(r2)).archived_at);
    assert.ok(!(await t.ids(3, 'absence_rejected_to_manage')).includes(Number(r2)));
    // une demande qui n'est pas refusée ne s'archive pas
    const r3 = await t.request(7, dd(0));
    await t.as(7); await assert.rejects(t.rpc('absence_delete_rejected', [r3]), /introuvable/);
    // retirer une demande refusée : archivée, jamais supprimée
    const r4 = await t.request(4, dd(2));
    await t.decide(3, r4, false, 'Refus quatre');
    await t.as(4); await t.rpc('absence_withdraw', [r4]);
    a = await t.info(r4);
    assert.ok(a); assert.equal(a.status, 'rejected'); assert.ok(a.archived_at);
    // retirer un brouillon jamais envoyé : suppression permise
    const d = await t.draft(4, dd(3));
    await t.as(4); await t.rpc('absence_withdraw', [d]);
    await t.sup();
    assert.equal((await t.rows('select count(*)::int n from absences where id = $1', [d]))[0].n, 0);
    // un brouillon qui a déjà un numéro (demande remise en brouillon) est annulé, pas supprimé
    const r5 = await t.request(4, dd(4));
    const n5 = await t.no(r5);
    await t.as(4); await t.rpc('absence_update', [r5, 'vacances', null, dd(5)[0], dd(5)[1]]);
    await t.as(4); await t.rpc('absence_withdraw', [r5]);
    a = await t.info(r5);
    assert.ok(a); assert.equal(a.status, 'cancelled'); assert.equal(a.request_no, n5);
    // une demande refusée remise en brouillon puis renvoyée n'est plus archivée
    const r6 = await t.request(4, dd(6));
    await t.decide(3, r6, false, 'Refus six');
    await t.as(4); await t.rpc('absence_delete_rejected', [r6]);
    await t.as(4); await t.rpc('absence_update', [r6, 'vacances', null, dd(7)[0], dd(7)[1]]);
    a = await t.info(r6);
    assert.equal(a.status, 'draft'); assert.equal(a.archived_at, null); assert.equal(a.archived_by, null);
    // secrétaire : brouillon saisi pour son cadre supprimé ; demande refusée archivée
    await t.as(8);
    const dr = (await t.rpc('absence_request_for', [uid(3), 'vacances', null, dd(0)[0], dd(0)[1]])).id;
    await t.rpc('absence_withdraw_for', [dr]);
    await t.sup();
    assert.equal((await t.rows('select count(*)::int n from absences where id = $1', [dr]))[0].n, 0);
    await t.as(8);
    const rq = (await t.rpc('absence_request_for', [uid(3), 'vacances', null, dd(1)[0], dd(1)[1]])).id;
    await t.rpc('absence_submit_for', [uid(3)]);
    await t.decide(1, rq, false, 'Refus cadre');
    assert.equal((await t.info(rq)).status, 'rejected');
    await t.as(8); await t.rpc('absence_withdraw_for', [rq]);
    a = await t.info(rq);
    assert.ok(a); assert.equal(a.status, 'rejected'); assert.ok(a.archived_at);
  } finally { await t.db.close(); }
});

test('6. matrice d\'accès : historique et recherche par numéro', async () => {
  const t = await mk();
  try {
    const R4 = await t.request(4, dd(0));
    const R5 = await t.request(5, dd(0));
    const R7 = await t.request(7, dd(0));
    await t.as(8);
    const Rc = (await t.rpc('absence_request_for', [uid(3), 'vacances', null, dd(0)[0], dd(0)[1]])).id;
    await t.rpc('absence_submit_for', [uid(3)]);
    const draft5 = await t.draft(9, dd(0));
    // demande confidentielle de 4 (motif « autre »)
    const conf = await t.request(4, dd(5), 'autre', 'Précision confidentielle fictive');
    await t.sup(); await t.db.query('update absences set confidential = true where id = $1', [conf]);
    await t.decide(3, R5, false, 'Refus visible');
    await t.decide(3, conf, false, 'Motif confidentiel fictif');
    const all = [R4, R5, R7, Rc, conf].map(Number).sort((a, b) => a - b);
    const only = (...x) => x.map(Number).sort((a, b) => a - b);
    const exp = { 1: all, 2: all, 3: only(R4, R5, conf, Rc), 4: only(R4, conf), 5: only(R5), 6: only(R7), 7: only(R7), 8: only(Rc), 9: [] };
    for (const [n, want] of Object.entries(exp)) {
      assert.deepEqual(await t.ids(Number(n), 'absence_requests_history'), want, 'historique de ' + n);
    }
    // aucun brouillon, jamais
    assert.ok(!(await t.ids(2, 'absence_requests_history')).includes(Number(draft5)));
    // la recherche suit exactement les mêmes droits ; un numéro hors périmètre ne se distingue pas d'un numéro inexistant
    const y = await t.year();
    for (const target of [R4, R5, R7, Rc, conf]) {
      const num = await t.no(target);
      for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
        const seen = (await t.ids(n, 'absence_find', [num])).includes(Number(target));
        assert.equal(seen, exp[n].includes(Number(target)), `recherche ${num} par ${n}`);
      }
    }
    for (const n of [4, 5, 7, 9]) {
      assert.deepEqual(await t.ids(n, 'absence_find', [`${y}-9999`]), []);
      assert.deepEqual(await t.ids(n, 'absence_find', ['n\'importe quoi']), []);
      assert.deepEqual(await t.ids(n, 'absence_find', ['']), []);
    }
    // normalisation : numéro complet, partiel, avec année, espaces et casse ignorés
    const num4 = await t.no(R4); const suffix = num4.split('-')[1]; const plain = String(Number(suffix));
    for (const q of [num4, suffix, plain, `${y}-${plain}`, ` ${y} - ${suffix} `, `N° ${num4}`, `n ${plain}`, num4.toUpperCase()]) {
      assert.ok((await t.ids(2, 'absence_find', [q])).includes(Number(R4)), 'requête « ' + q + ' »');
    }
    assert.deepEqual(await t.ids(2, 'absence_find', [`${y + 1}-${plain}`]), []);
    // filtre par personne : hors périmètre = liste vide, jamais d'erreur
    assert.deepEqual(await t.ids(4, 'absence_requests_history', [uid(7)]), []);
    assert.deepEqual(await t.ids(2, 'absence_requests_history', [uid(7)]), only(R7));
    assert.deepEqual(await t.ids(3, 'absence_requests_history', [uid(7)]), []);
    // statut, année, recherche texte, pagination
    await t.as(2);
    const status = async (s) => (await t.rows('select id from absence_requests_history(null, null, $1::text[])', [s])).map((r) => Number(r.id)).sort((a, b) => a - b);
    assert.deepEqual(await status(['rejected']), only(R5, conf));
    assert.deepEqual(await status(['approved']), []);
    assert.deepEqual(await status(['n_importe_quoi']), []);
    assert.deepEqual((await t.rows('select id from absence_requests_history(null, $1)', [y])).length, 5);
    assert.deepEqual((await t.rows('select id from absence_requests_history(null, $1)', [y + 3])).length, 0);
    assert.deepEqual((await t.rows("select id from absence_requests_history(null, null, null, 'historique 7')")).map((r) => Number(r.id)), only(R7));
    assert.deepEqual((await t.rows("select id from absence_requests_history(null, null, null, 'autre')")).map((r) => Number(r.id)), only(conf));
    const p1 = (await t.rows('select id from absence_requests_history(null, null, null, null, 2, 0)')).map((r) => Number(r.id));
    const p2 = (await t.rows('select id from absence_requests_history(null, null, null, null, 2, 2)')).map((r) => Number(r.id));
    assert.equal(p1.length, 2); assert.equal(p2.length, 2); assert.equal(new Set([...p1, ...p2]).size, 4);
    // tri par date de soumission décroissante
    const sorted = await t.rows('select submitted_at from absence_requests_history()');
    for (let i = 1; i < sorted.length; i++) assert.ok(new Date(sorted[i - 1].submitted_at) >= new Date(sorted[i].submitted_at));
    // 50 résultats au plus pour la recherche
    await t.sup();
    await t.db.query("insert into absences(user_id, kind, start_date, end_date, status, submitted_at) select $1, 'vacances', '2027-09-01', '2027-09-02', 'requested', make_timestamptz(y, 6, 1, 10, 0, 0, 'Europe/Zurich') from generate_series(2100, 2159) y", [uid(9)]);
    assert.equal((await t.ids(2, 'absence_find', ['1'])).length, 50);
    assert.equal((await t.ids(9, 'absence_find', ['2100-1'])).length, 1);
    assert.equal((await t.ids(4, 'absence_find', ['2100-1'])).length, 0);
    // sans session : accès refusé
    await t.as(null);
    await assert.rejects(t.rpc('absence_requests_history', []), /Accès refusé/);
    await assert.rejects(t.rpc('absence_find', ['1']), /Accès refusé/);
  } finally { await t.db.close(); }
});

test('7. absences confidentielles : texte libre et commentaire de décision masqués aux non-concernés', async () => {
  const t = await mk();
  try {
    const conf = await t.request(4, dd(0), 'autre', 'Précision confidentielle fictive');
    await t.sup(); await t.db.query('update absences set confidential = true where id = $1', [conf]);
    await t.decide(3, conf, false, 'Commentaire confidentiel fictif');
    const row = async (n) => { await t.as(n); const r = (await t.rows('select * from absence_requests_history()')).find((x) => Number(x.id) === Number(conf)); await t.sup(); return r; };
    for (const n of [4, 1, 2]) { const r = await row(n); assert.equal(r.note, 'Précision confidentielle fictive', 'note vue par ' + n); assert.equal(r.decision_comment, 'Commentaire confidentiel fictif'); }
    const v = await row(3);
    assert.equal(v.kind, 'autre'); assert.equal(v.note, null); assert.equal(v.decision_comment, null);
    // par la recherche aussi
    await t.as(3);
    const f = (await t.rows('select * from absence_find($1)', [await t.no(conf)]))[0];
    assert.equal(f.note, null); assert.equal(f.decision_comment, null); assert.equal(f.kind, 'autre');
  } finally { await t.db.close(); }
});

test('8. retours des RPC modifiées : request_no partout, planning limité aux droits', async () => {
  const t = await mk();
  try {
    const id = await t.request(4, dd(0));
    const num = await t.no(id);
    await t.as(4);
    const mine = (await t.rows('select * from absence_list()')).find((r) => Number(r.id) === Number(id));
    assert.equal(mine.request_no, num);
    await t.as(3);
    assert.equal((await t.rows('select * from absence_to_validate()')).find((r) => Number(r.id) === Number(id)).request_no, num);
    const rej = await t.request(5, dd(0));
    await t.decide(3, rej, false, 'Refus fictif');
    await t.as(3);
    assert.equal((await t.rows('select * from absence_rejected_to_manage()')).find((r) => Number(r.id) === Number(rej)).request_no, await t.no(rej));
    await t.as(2);
    const trk = (await t.rows('select * from absence_track($1, $2)', ['2027-01-01', '2027-12-31'])).find((r) => Number(r.id) === Number(id));
    assert.equal(trk.request_no, num); assert.equal(trk.trail.request_no, num);
    const exp = (await t.rows('select * from absence_export($1, $2)', ['2027-01-01', '2027-12-31'])).find((r) => Number(r.id) === Number(id));
    assert.equal(exp.request_no, num);
    // planning : le numéro n'est donné qu'à qui a le droit de voir la demande
    const gridNo = async (n) => { await t.as(n); const g = (await t.rows('select id, request_no from absence_grid($1, $2)', ['2027-01-01', '2027-12-31'])).find((r) => Number(r.id) === Number(id)); await t.sup(); return g && g.request_no; };
    assert.equal(await gridNo(4), num);
    assert.equal(await gridNo(3), num);
    assert.equal(await gridNo(2), num);
    assert.equal(await gridNo(5), null); // collègue de la clinique : voit l'absence, pas le numéro
    // documents figés : request_no dans chaque absence ; ancien document sans numéro complété à la lecture
    await t.sup();
    const k = (await t.rows("select public.absence_document_create($1, 'test') as k", [[id]]))[0].k;
    const data = (await t.rows('select data from absence_documents where id = $1', [k]))[0].data;
    assert.equal(data.absences[0].request_no, num);
    const cur = (await t.rows('select public.absence_form_current($1) as d', [[id]]))[0].d;
    assert.equal(cur.absences[0].request_no, num);
    const old = await t.request(5, dd(3));
    await t.sup();
    await t.db.query("insert into absence_documents(user_id, absence_ids, action, data) values ($1, $2, 'legacy_snapshot', $3)", [uid(5), [old], JSON.stringify({ owner: 'Test', role: 'clinician', absences: [{ id: Number(old), kind: 'vacances' }] })]);
    const legacy = (await t.rows('select public.absence_form_data($1) as d', [[old]]))[0].d;
    assert.equal(legacy.absences[0].request_no, await t.no(old));
    // boîte d'envoi : aucun numéro dans le payload (il est lu à l'envoi à partir des identifiants)
    const ob = await t.rows('select payload from absence_outbox');
    assert.ok(ob.length > 0);
    assert.ok(!ob.some((o) => JSON.stringify(o.payload).includes('request_no')));
  } finally { await t.db.close(); }
});

test('9. droits d\'exécution : RPC pour les connectés, fonctions internes et compteur fermés', async () => {
  const t = await mk();
  try {
    await t.sup();
    const can = async (role, fn) => (await t.rows('select has_function_privilege($1, $2, \'execute\') as ok', [role, 'public.' + fn]))[0].ok;
    for (const fn of ['absence_requests_history(uuid, int, text[], text, int, int)', 'absence_find(text)', 'absence_delete_rejected(bigint)', 'absence_withdraw(bigint)', 'absence_withdraw_for(bigint)',
      'absence_list(uuid)', 'absence_to_validate()', 'absence_rejected_to_manage()', 'absence_export(date, date)', 'absence_track(date, date)', 'absence_grid(date, date)']) {
      assert.equal(await can('anon', fn), false, 'anon ' + fn); assert.equal(await can('authenticated', fn), true, 'authenticated ' + fn);
    }
    for (const fn of ['absence_can_view_request(uuid, public.absences)', 'absence_requests_core(uuid, uuid, int, text[], text, int, int, int, int)', 'absence_doc_numbers(jsonb)', 'absence_request_no_set()']) {
      for (const r of ['anon', 'authenticated']) assert.equal(await can(r, fn), false, r + ' ' + fn);
    }
    assert.equal(await can('anon', 'absence_purge()'), false); assert.equal(await can('authenticated', 'absence_purge()'), false); assert.equal(await can('service_role', 'absence_purge()'), true);
    for (const fn of ['absence_form_data(bigint[])', 'absence_document_data(bigint)']) { assert.equal(await can('authenticated', fn), false); assert.equal(await can('service_role', fn), true); }
    for (const role of ['anon', 'authenticated']) {
      const g = (await t.rows('select has_table_privilege($1, $2, \'select\') s, has_table_privilege($1, $2, \'insert\') i, has_table_privilege($1, $2, \'update\') u, has_table_privilege($1, $2, \'delete\') d', [role, 'public.absence_request_counters']))[0];
      assert.deepEqual(Object.values(g), [false, false, false, false], role);
    }
    assert.equal((await t.rows("select relrowsecurity r from pg_class where oid = 'public.absence_request_counters'::regclass"))[0].r, true);
    // un membre ne peut appeler ni le noyau ni le compteur
    await t.as(4);
    await assert.rejects(t.rpc('absence_requests_core', [uid(4), null, null, null, null, null, null, 10, 0]), /permission denied/);
    await assert.rejects(t.db.query('select * from absence_request_counters'), /permission denied/);
    // la migration est inscrite
    await t.sup();
    assert.equal((await t.rows("select count(*)::int n from onconic_migrations where version = '202611270001'"))[0].n, 1);
  } finally { await t.db.close(); }
});
