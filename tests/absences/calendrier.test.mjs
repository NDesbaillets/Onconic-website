// Calendrier des fériés et événements géré par la direction (migration 202611270003), PGlite, données fictives.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
const root = new URL('../../', import.meta.url);
const read = (p) => readFile(new URL(p, root), 'utf8');
const uid = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

// 1 admin, 2 direction, 3 cadre, 4 médecin, 5 assistante admin_lead, 6 à 13 médecins Thoracique (absences d'essai)
const PEOPLE = [[1, 'admin', []], [2, 'direction', []], [3, 'cadre', ['Thoracique']], [4, 'clinician', ['Thoracique']], [5, 'assistant', []]];
for (let n = 6; n <= 13; n++) PEOPLE.push([n, 'clinician', ['Thoracique']]);

async function mk() {
  const db = new PGlite();
  const as = async (n) => { await db.exec('reset role'); await db.query("select set_config('test.uid',$1,false)", [n ? uid(n) : '']); await db.exec('set role authenticated'); };
  const sup = () => db.exec('reset role');
  const rpc = async (name, args = []) => { try { return Object.values((await db.query(`select public.${name}(${args.map((_, i) => '$' + (i + 1)).join(',')})`, args)).rows[0])[0]; } catch (e) { e.message += ` [${name}]`; throw e; } };
  const rows = async (sql, args = []) => (await db.query(sql, args)).rows;
  await db.exec(await read('tests/absences/fixture.sql'));
  await db.exec('alter table auth.users add column banned_until timestamptz;');
  await db.exec("alter table public.calendar_tokens add primary key (user_id); alter table public.calendar_tokens alter column token set default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');");
  await db.exec('alter table public.events add column if not exists to_confirm boolean not null default false;');
  for (const f of ['absences.sql', 'cadre_medecin.sql', 'cadre_validateur.sql', 'absences_validation.sql', 'absences_forms.sql', 'absences_cliniques_datees.sql', 'admin_direction.sql', 'absences_export.sql', 'absences_soldes.sql', 'absences_visibilite.sql', 'absences_preavis.sql', 'absences_vue_ensemble.sql', 'agenda_commun.sql'])
    await db.exec(await read('supabase/' + f));
  for (const f of ['202611110001_absence_hardening.sql', '202611120001_nurse_role.sql', '202611120002_assistant_default_tools.sql', '202611130001_securite_advisors.sql', '202611140001_absence_planning.sql', '202611160002_comptes_temporaires.sql', '202611170001_circuit_absences.sql'])
    await db.exec(await read('supabase/migrations/' + f));
  for (const [n, role, clinics] of PEOPLE) {
    await db.query('insert into auth.users(id,email) values($1,$2)', [uid(n), `cal${n}@example.com`]);
    await db.query('insert into profiles(id,full_name,role,institution,clinics,absence_validator) values($1,$2,$3,$4,$5,$6)', [uid(n), `Calendrier ${n}`, role, 'CHUV', clinics, n === 3]);
  }
  await db.query('update profiles set admin_lead = true where id = $1', [uid(5)]);
  await db.query("insert into absence_validators(clinic,user_id) values ('Thoracique',$1)", [uid(3)]);
  for (const f of ['202611180001_circuit_configurable.sql', '202611180002_agenda_ultragenda.sql', '202611230001_cliniques_hemato_tournus.sql', '202611230002_absences_suivi_cheffe.sql', '202611270001_absences_historique_numero.sql', '202611270002_creation_membres_direction.sql'])
    await db.exec(await read('supabase/migrations/' + f));
  const mine = await read('supabase/migrations/202611270003_calendrier_direction.sql');
  await db.exec(mine); await db.exec(mine); // réexécutable (deux fois de suite)
  const holidays = async (y) => (await rows('select public.vd_holiday_dates($1) d', [y]))[0].d.map((x) => (x instanceof Date ? x.toISOString().slice(0, 10) : String(x).slice(0, 10)));
  const save = async (n, kind, label, a, b = a, id = null) => { await as(n); try { return await rpc('admin_calendar_save', [id, kind, label, a, b]); } finally { await sup(); } };
  const fails = async (p, re) => { await assert.rejects(p, re); await sup(); };
  const wd = async (a, b) => (await rows('select public.absence_workdays($1::date,$2::date) n', [a, b]))[0].n;
  const wl = async (a, b) => (await rows('select public.absence_workday_list($1::date,$2::date) l', [a, b]))[0].l.map((x) => (x instanceof Date ? x.toISOString().slice(0, 10) : String(x).slice(0, 10)));
  return { db, as, sup, rpc, rows, holidays, save, fails, wd, wl };
}

test('1. contrainte de type, colonnes, volatilité et dépendances de vd_holiday_dates', async () => {
  const t = await mk();
  try {
    for (const k of ['ferie', 'presence_obligatoire', 'evenement', 'vacances_scolaires'])
      await t.db.query("insert into absence_calendar(kind,label,start_date,end_date) values ($1,'Essai','2027-02-01','2027-02-02')", [k]);
    await assert.rejects(t.db.query("insert into absence_calendar(kind,label,start_date,end_date) values ('autre','Essai','2027-02-01','2027-02-02')"), /check/);
    await assert.rejects(t.db.query("insert into absence_calendar(kind,label,start_date,end_date) values ('ferie','Long','2027-02-01','2027-03-15')"), /check/);
    const c = await t.rows("select count(*)::int n from pg_constraint where conrelid = 'public.absence_calendar'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%presence_obligatoire%'");
    assert.equal(c[0].n, 1, 'une seule contrainte de type après deux applications');
    const cols = (await t.rows("select column_name from information_schema.columns where table_name = 'absence_calendar'")).map((x) => x.column_name);
    for (const col of ['created_by', 'updated_by', 'updated_at']) assert.ok(cols.includes(col), col);
    assert.equal((await t.rows("select provolatile v from pg_proc where proname = 'vd_holiday_dates'"))[0].v, 's', 'STABLE');
    const dep = await t.rows(`select count(*)::int n from pg_depend d where d.refclassid = 'pg_proc'::regclass and d.refobjid = 'public.vd_holiday_dates(integer)'::regprocedure
      and d.classid in ('pg_class'::regclass, 'pg_attrdef'::regclass, 'pg_constraint'::regclass)`);
    assert.equal(dep[0].n, 0, 'aucun index, colonne générée ni contrainte ne dépend de vd_holiday_dates');
    const imm = await t.rows(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.provolatile = 'i' and p.prosrc like '%vd_holiday_dates%'`);
    assert.deepEqual(imm, [], 'aucune fonction IMMUTABLE ne s\'appuie sur vd_holiday_dates');
    assert.ok((await t.rows("select indexdef from pg_indexes where indexname = 'absence_calendar_ferie'"))[0].indexdef.includes("kind = 'ferie'"));
    assert.equal((await t.rows("select has_function_privilege('anon', 'public.admin_calendar_impact(date, date)', 'execute') a, has_function_privilege('authenticated', 'public.admin_calendar_impact(date, date)', 'execute') b"))[0].a, false);
    assert.equal((await t.rows("select count(*)::int n from onconic_migrations where version = '202611270003'").catch(() => [{ n: 1 }]))[0].n, 1);
  } finally { await t.db.close(); }
});

test('2. vd_holiday_dates : fériés calculés, jour seul, plage, plage à cheval sur deux années, doublon avec un férié calculé', async () => {
  const t = await mk();
  try {
    const base = await t.holidays(2029);
    assert.equal(base.length, 9);
    assert.deepEqual(base, [...base].sort());
    await t.save(2, 'ferie', 'Pont fictif', '2029-05-11');
    await t.save(2, 'ferie', 'Fermeture fictive', '2029-07-09', '2029-07-12');
    await t.save(2, 'ferie', 'Fin d\'année fictive', '2029-12-27', '2030-01-04');
    await t.save(2, 'ferie', 'Doublon du Nouvel An', '2029-01-01');
    await t.save(2, 'evenement', 'Retraite fictive', '2029-09-03', '2029-09-04');
    await t.save(2, 'presence_obligatoire', 'Journée fictive', '2029-10-01');
    const y29 = await t.holidays(2029);
    for (const d of ['2029-05-11', '2029-07-09', '2029-07-10', '2029-07-11', '2029-07-12', '2029-12-27', '2029-12-28', '2029-12-29', '2029-12-30', '2029-12-31']) assert.ok(y29.includes(d), d);
    assert.ok(!y29.includes('2030-01-01'), 'une année ne contient que ses propres jours');
    assert.ok(!y29.includes('2029-09-03') && !y29.includes('2029-10-01'), 'ni événement ni présence obligatoire');
    assert.equal(y29.filter((d) => d === '2029-01-01').length, 1, 'doublon fusionné');
    assert.equal(y29.length, 9 + 1 + 4 + 5, 'neuf calculés, un jour seul, quatre jours de plage, cinq jours de fin d\'année (le Nouvel An est déjà compté)');
    assert.deepEqual(y29, [...y29].sort());
    const y30 = await t.holidays(2030);
    for (const d of ['2030-01-01', '2030-01-02', '2030-01-03', '2030-01-04']) assert.ok(y30.includes(d), d);
    assert.equal(y30.length, 9 + 2, '3 et 4 janvier 2030 s\'ajoutent aux neuf calculés');
    assert.equal((await t.holidays(2031)).length, 9);
  } finally { await t.db.close(); }
});

test('3. jours ouvrables : absence_workdays, absence_workday_list, absence_circuit_mine changent après ajout puis suppression d\'un férié', async () => {
  const t = await mk();
  try {
    assert.equal(await t.wd('2027-03-15', '2027-03-19'), 5);
    const id = await t.save(2, 'ferie', 'Pont fictif', '2027-03-17');
    assert.equal(await t.wd('2027-03-15', '2027-03-19'), 4);
    assert.ok(!(await t.wl('2027-03-15', '2027-03-19')).includes('2027-03-17'));
    assert.equal((await t.wl('2027-03-15', '2027-03-19')).length, 4);
    // plage à cheval sur deux années, via la liste
    await t.save(2, 'ferie', 'Fermeture de fin d\'année', '2027-12-29', '2028-01-04');
    assert.deepEqual(await t.wl('2027-12-27', '2028-01-05'), ['2027-12-27', '2027-12-28', '2028-01-05']);
    // suppression : tout redevient comme avant
    await t.as(2); await t.rpc('admin_calendar_delete', [id]); await t.sup();
    assert.equal(await t.wd('2027-03-15', '2027-03-19'), 5);
    // calcul en ligne de absence_circuit_mine (202611230001) : le premier jour ouvrable du prochain lundi saute le férié ajouté
    const d1 = (await t.rows("select (public.ch_today() + (8 - extract(isodow from public.ch_today())::int))::text d"))[0].d;
    const before = (await t.wl(d1, String(new Date(Date.parse(d1) + 14 * 864e5).toISOString().slice(0, 10))));
    await t.as(4);
    const r0 = await t.rpc('absence_circuit_mine', [null, 'vacances', 5]);
    assert.equal(r0.from, before[0]);
    await t.save(2, 'ferie', 'Férié du prochain jour ouvrable', before[0]);
    await t.as(4);
    const r1 = await t.rpc('absence_circuit_mine', [null, 'vacances', 5]);
    assert.equal(r1.from, before[1], 'le premier jour ouvrable avance');
    assert.equal(r1.to, before[5], 'cinq jours ouvrables, le férié est sauté');
    await t.sup();
  } finally { await t.db.close(); }
});

test('4. droits : membre ordinaire, assistante admin_lead, cadre et anonyme refusés ; direction et admin acceptés', async () => {
  const t = await mk();
  try {
    const calls = [['admin_calendar_list', []], ['admin_calendar_log_list', [30]], ['admin_calendar_impact', ['2027-03-15', '2027-03-19']],
      ['admin_calendar_save', [null, 'ferie', 'Pont fictif', '2027-03-17', '2027-03-17']], ['admin_calendar_sync_status', []]];
    for (const n of [4, 3, 5, null]) {
      await t.as(n);
      for (const [fn, args] of calls) { await t.as(n); await t.fails(t.rows(`select * from public.${fn}(${args.map((_, i) => '$' + (i + 1)).join(',')})`, args), /admin only/); }
      await t.as(n); await t.fails(t.rpc('admin_calendar_delete', [1]), /admin only/);
      await t.as(n); await t.fails(t.rpc('admin_calendar_confirm', [1]), /admin only/);
    }
    for (const n of [2, 1]) {
      await t.as(n);
      await t.rows('select * from admin_calendar_list()');
      await t.rows('select * from admin_calendar_log_list(10)');
      assert.equal(await t.rpc('admin_calendar_impact', ['2027-03-15', '2027-03-19']), 0);
      const id = await t.rpc('admin_calendar_save', [null, 'ferie', `Pont fictif ${n}`, '2027-03-17', '2027-03-17']);
      await t.rpc('admin_calendar_delete', [id]);
      await t.sup();
    }
    // la table et le journal restent fermés en accès direct
    await t.as(2);
    await t.fails(t.db.query('select * from absence_calendar'), /permission denied/);
    await t.as(2);
    await t.fails(t.db.query('select * from absence_calendar_log'), /permission denied/);
    await t.sup();
    for (const f of ['admin_calendar_save(bigint, text, text, date, date)', 'admin_calendar_delete(bigint)', 'admin_calendar_confirm(bigint)', 'admin_calendar_list()', 'admin_calendar_log_list(int)', 'admin_calendar_impact(date, date)'])
      assert.equal((await t.rows(`select has_function_privilege('anon', 'public.${f}', 'execute') a`))[0].a, false, f);
  } finally { await t.db.close(); }
});

test('5. validations de admin_calendar_save : intitulé, dates, durées, doublon exact, type', async () => {
  const t = await mk();
  try {
    await t.as(2);
    const s = (kind, label, a, b, id = null) => t.rpc('admin_calendar_save', [id, kind, label, a, b]);
    await t.fails(s('ferie', 'x', '2027-03-17', '2027-03-17'), /2 à 120/);
    await t.as(2); await t.fails(s('ferie', 'x'.repeat(121), '2027-03-17', '2027-03-17'), /2 à 120/);
    await t.as(2); await t.fails(s('ferie', '   ', '2027-03-17', '2027-03-17'), /2 à 120/);
    await t.as(2); await t.fails(s('ferie', 'Pont', '2027-03-18', '2027-03-17'), /Vérifiez les dates/);
    await t.as(2); await t.fails(s('ferie', 'Pont', null, null), /Vérifiez les dates/);
    await t.as(2); await t.fails(s('autre', 'Pont', '2027-03-17', '2027-03-17'), /Type inconnu/);
    await t.as(2); await t.fails(s('ferie', 'Long', '2027-03-01', '2027-04-01'), /31 jours/);
    await t.as(2); await s('ferie', 'Trente et un jours', '2027-03-01', '2027-03-31');
    await t.as(2); await s('presence_obligatoire', 'Cent vingt et un jours', '2027-03-01', '2027-06-29');
    await t.as(2); await t.fails(s('presence_obligatoire', 'Trop long', '2027-03-01', '2027-06-30'), /120 jours/);
    await t.as(2); await t.fails(s('evenement', 'Trop long', '2027-03-01', '2027-06-30'), /120 jours/);
    await t.as(2); await t.fails(s('vacances_scolaires', 'Trop long', '2027-03-01', '2027-06-30'), /120 jours/);
    // doublon exact refusé, même type + intitulé + dates ; un autre type ou d'autres dates passent
    await t.as(2); const id = await s('evenement', 'Retraite fictive', '2027-05-03', '2027-05-04');
    await t.as(2); await t.fails(s('evenement', 'Retraite fictive', '2027-05-03', '2027-05-04'), /existe déjà/);
    await t.as(2); await t.fails(s('evenement', '  Retraite fictive ', '2027-05-03', '2027-05-04'), /existe déjà/);
    await t.as(2); await s('presence_obligatoire', 'Retraite fictive', '2027-05-03', '2027-05-04');
    await t.as(2); await s('evenement', 'Retraite fictive', '2027-05-03', '2027-05-05');
    // l'entrée s'enregistre sans changement sur elle-même (pas de faux doublon), et une autre ne peut pas la copier
    await t.as(2); assert.equal(await s('evenement', 'Retraite fictive', '2027-05-03', '2027-05-04', id), id);
    await t.as(2); await t.fails(s('evenement', 'Retraite fictive', '2027-05-03', '2027-05-04', 999999), /introuvable|existe déjà/);
    await t.as(2); await s('evenement', 'Retraite fictive', '2027-05-03', '2027-05-06');
    await t.as(2); await t.fails(s('evenement', 'Retraite fictive', '2027-05-03', '2027-05-06', id), /existe déjà/);
    await t.as(2); await t.fails(s('evenement', 'Retraite fictive', '2027-05-03', '2027-05-04', 999999), /introuvable|existe déjà/);
  } finally { await t.db.close(); }
});

test('6. journal, auteur, modification, confirmation d\'une période importée', async () => {
  const t = await mk();
  try {
    const id = await t.save(2, 'ferie', 'Pont fictif', '2027-05-14');
    await t.save(1, 'ferie', 'Pont fictif corrigé', '2027-05-14', '2027-05-15', id);
    const r = (await t.rows('select * from absence_calendar where id = $1', [id]))[0];
    assert.equal(r.created_by, uid(2));
    assert.equal(r.updated_by, uid(1));
    assert.ok(r.updated_at);
    assert.equal(r.label, 'Pont fictif corrigé');
    // période importée à confirmer
    await t.sup();
    await t.rpc('calendar_import_school_holidays', [JSON.stringify([{ ext_id: 'openholidays:essai', label: 'Vacances scolaires VD : essai', start_date: '2027-10-09', end_date: '2027-10-24' }])]);
    await t.as(2);
    const list = await t.rows('select * from admin_calendar_list()');
    const imp = list.find((x) => x.source === 'openholidays');
    assert.equal(imp.to_confirm, true);
    assert.equal(imp.created_by_name, null);
    const mine = list.find((x) => x.id == id);
    assert.equal(mine.created_by_name, 'Calendrier 2');
    assert.equal(mine.updated_by_name, 'Calendrier 1');
    await t.rpc('admin_calendar_confirm', [imp.id]);
    await t.rpc('admin_calendar_confirm', [imp.id]); // deuxième confirmation : sans effet, non journalisée
    assert.equal((await t.rows('select * from admin_calendar_list()')).find((x) => x.id == imp.id).to_confirm, false);
    await t.rpc('admin_calendar_delete', [id]);
    await t.rpc('admin_calendar_delete', [id]); // déjà supprimée : sans effet
    const log = await t.rows('select * from admin_calendar_log_list(30)');
    assert.deepEqual(log.map((x) => x.action), ['delete', 'confirm', 'update', 'create']);
    assert.equal(log[0].actor_name, 'Calendrier 2');
    assert.equal(log[2].actor_name, 'Calendrier 1');
    assert.equal(log[0].label, 'Pont fictif corrigé');
    assert.equal((await t.rows('select * from admin_calendar_log_list(1)')).length, 1);
    assert.equal((await t.rows('select * from admin_calendar_log_list(-5)')).length, 1, 'limite bornée à 1 au moins');
    // journal en ajout seul, même pour le propriétaire
    await t.sup();
    await t.fails(t.db.query("update absence_calendar_log set label = 'x'"), /ajout seul/);
    await t.fails(t.db.query('delete from absence_calendar_log'), /ajout seul/);
    assert.equal((await t.rows('select count(*)::int n from absence_calendar_log'))[0].n, 4);
  } finally { await t.db.close(); }
});

test('7. admin_calendar_impact : nombre seulement, hors brouillons, refusées et annulées, jours ouvrables seulement', async () => {
  const t = await mk();
  try {
    const mkAbs = async (n, a, b) => { await t.as(n); const id = (await t.rpc('absence_request', ['vacances', null, a, b])).id; await t.sup(); return id; };
    const idReq = await mkAbs(4, '2027-03-16', '2027-03-17');        // en demande : compté
    const idApp = await mkAbs(6, '2027-03-15', '2027-03-26');         // validée : comptée
    const idDraft = await mkAbs(7, '2027-03-16', '2027-03-16');       // brouillon : exclu
    const idRej = await mkAbs(8, '2027-03-16', '2027-03-16');         // refusée : exclue
    const idCan = await mkAbs(9, '2027-03-16', '2027-03-16');         // annulée : exclue
    const idOut = await mkAbs(10, '2027-03-22', '2027-03-23');        // hors plage : exclue
    const idWe = await mkAbs(11, '2027-03-20', '2027-03-21');         // week-end seulement : exclue
    const idHol = await mkAbs(12, '2027-03-19', '2027-03-19');        // vendredi : compté
    await t.db.query("update absences set status = 'requested' where id in ($1, $2)", [idReq, idHol]);
    await t.db.query("update absences set status = 'approved' where id = $1", [idApp]);
    await t.db.query("update absences set status = 'rejected' where id = $1", [idRej]);
    await t.db.query("update absences set status = 'cancelled' where id = $1", [idCan]);
    await t.db.query("update absences set status = 'requested' where id in ($1, $2)", [idOut, idWe]);
    assert.ok(idDraft);
    await t.as(2);
    assert.equal(await t.rpc('admin_calendar_impact', ['2027-03-15', '2027-03-19']), 3);
    assert.equal(await t.rpc('admin_calendar_impact', ['2027-03-17', '2027-03-17']), 2);
    assert.equal(await t.rpc('admin_calendar_impact', ['2027-03-20', '2027-03-21']), 0, 'une plage de week-end ne touche personne');
    assert.equal(typeof await t.rpc('admin_calendar_impact', ['2027-03-15', '2027-03-19']), 'number');
    await t.fails(t.rpc('admin_calendar_impact', ['2027-03-19', '2027-03-15']), /Vérifiez les dates/);
    // un jour férié calculé n'est pas un « jour ouvrable » : Vendredi saint 2027 = 26.03.2027
    await t.as(2);
    assert.equal(await t.rpc('admin_calendar_impact', ['2027-03-26', '2027-03-26']), 0, 'le 26.03.2027 est déjà un férié calculé : aucun jour ouvrable ne change');
  } finally { await t.db.close(); }
});

test('8. absence_calendar (planning) renvoie les nouveaux types sans changement de signature', async () => {
  const t = await mk();
  try {
    await t.save(2, 'ferie', 'Pont fictif', '2027-05-14');
    await t.save(2, 'presence_obligatoire', 'Journée de service fictive', '2027-05-20', '2027-05-21');
    await t.as(4);
    const r = await t.rows("select * from absence_calendar('2027-05-01'::date, '2027-05-31'::date)");
    assert.deepEqual(r.map((x) => x.kind), ['ferie', 'presence_obligatoire']);
    assert.deepEqual(Object.keys(r[0]), ['id', 'kind', 'label', 'start_date', 'end_date']);
    // un membre ordinaire lit l'agenda, mais pas l'administration
    await t.fails(t.rows('select * from admin_calendar_list()'), /admin only/);
  } finally { await t.db.close(); }
});
