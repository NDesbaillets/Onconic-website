// Lecture des fériés ajoutés à la main (migration 202611270004), PGlite, données fictives.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
const root = new URL('../../', import.meta.url);
const read = (p) => readFile(new URL(p, root), 'utf8');
const uid = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

// 1 admin, 2 direction, 3 cadre, 4 médecin assistant, 5 assistante, 6 infirmier·ère (hors CHUV), 7 pharmacien·ne (hors CHUV), 8 CDC,
// 9 compte en attente (member), 10 compte sans profil
const PEOPLE = [[1, 'admin', 'CHUV'], [2, 'direction', 'CHUV'], [3, 'cadre', 'CHUV'], [4, 'clinician', 'CHUV'], [5, 'assistant', 'CHUV'], [6, 'nurse', 'Autre'], [7, 'pharmacist', 'Autre'], [8, 'cdc', 'CHUV'], [9, 'member', 'Autre']];

async function mk() {
  const db = new PGlite();
  const as = async (n) => { await db.exec('reset role'); await db.query("select set_config('test.uid',$1,false)", [n ? uid(n) : '']); await db.exec('set role authenticated'); };
  const sup = () => db.exec('reset role');
  const rows = async (sql, args = []) => (await db.query(sql, args)).rows;
  const day = (x) => (x instanceof Date ? x.toISOString().slice(0, 10) : String(x).slice(0, 10));
  const feries = async (a, b) => (await rows('select day, label from public.calendar_feries($1::date, $2::date)', [a, b])).map((r) => [day(r.day), r.label]);
  const fails = async (p, re) => { await assert.rejects(p, re); await sup(); };
  await db.exec(await read('tests/absences/fixture.sql'));
  await db.exec('alter table auth.users add column banned_until timestamptz;');
  await db.exec("alter table public.calendar_tokens add primary key (user_id); alter table public.calendar_tokens alter column token set default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');");
  await db.exec('alter table public.events add column if not exists to_confirm boolean not null default false;');
  for (const f of ['absences.sql', 'cadre_medecin.sql', 'cadre_validateur.sql', 'absences_validation.sql', 'absences_forms.sql', 'absences_cliniques_datees.sql', 'admin_direction.sql', 'absences_export.sql', 'absences_soldes.sql', 'absences_visibilite.sql', 'absences_preavis.sql', 'absences_vue_ensemble.sql', 'agenda_commun.sql'])
    await db.exec(await read('supabase/' + f));
  for (const f of ['202611110001_absence_hardening.sql', '202611120001_nurse_role.sql', '202611120002_assistant_default_tools.sql', '202611130001_securite_advisors.sql', '202611140001_absence_planning.sql', '202611160002_comptes_temporaires.sql', '202611170001_circuit_absences.sql'])
    await db.exec(await read('supabase/migrations/' + f));
  for (const [n, role, inst] of PEOPLE) {
    await db.query('insert into auth.users(id,email) values($1,$2)', [uid(n), `fer${n}@example.com`]);
    await db.query('insert into profiles(id,full_name,role,institution,clinics) values($1,$2,$3,$4,$5)', [uid(n), `Fériés ${n}`, role, inst, role === 'member' ? [] : ['Thoracique']]);
  }
  await db.query('insert into auth.users(id,email) values($1,$2)', [uid(10), 'fer10@example.com']);
  for (const f of ['202611180001_circuit_configurable.sql', '202611180002_agenda_ultragenda.sql', '202611230001_cliniques_hemato_tournus.sql', '202611230002_absences_suivi_cheffe.sql', '202611270001_absences_historique_numero.sql', '202611270002_creation_membres_direction.sql'])
    await db.exec(await read('supabase/migrations/' + f));
  await db.exec(await read('supabase/migrations/202611270003_calendrier_direction.sql'));
  const mine = await read('supabase/migrations/202611270004_feries_lecture.sql');
  await db.exec(mine); await db.exec(mine); // réexécutable (deux fois de suite)
  const add = (kind, label, a, b = a) => db.query('insert into absence_calendar(kind,label,start_date,end_date) values ($1,$2,$3,$4)', [kind, label, a, b]);
  return { db, as, sup, rows, feries, fails, add };
}

test('1. droits : anonyme, compte sans uid, sans profil et en attente refusés ; chaque rôle de membre accepté, outil Absences ou non', async () => {
  const t = await mk();
  try {
    await t.add('ferie', 'Pont fictif', '2027-05-14');
    assert.equal((await t.rows("select has_function_privilege('anon', 'public.calendar_feries(date, date)', 'execute') a, has_function_privilege('authenticated', 'public.calendar_feries(date, date)', 'execute') b"))[0].a, false);
    await t.sup(); await t.db.exec('set role anon');
    await t.fails(t.feries('2027-01-01', '2027-12-31'), /permission denied/);
    await t.as(null);
    await t.fails(t.feries('2027-01-01', '2027-12-31'), /Connexion requise/);
    for (const n of [9, 10]) { await t.as(n); await t.fails(t.feries('2027-01-01', '2027-12-31'), /réservé aux membres/); }
    for (const [n, role, inst] of PEOPLE.filter((p) => p[1] !== 'member')) {
      await t.as(n);
      assert.deepEqual(await t.feries('2027-01-01', '2027-12-31'), [['2027-05-14', 'Pont fictif']], role);
      await t.sup();
      if (inst !== 'CHUV') assert.equal((await t.rows("select public.tool_allowed($1::uuid, 'absences') ok", [uid(n)]))[0].ok, false, `${role} sans l'outil Absences`);
    }
    // la table reste fermée en accès direct
    await t.as(6); await t.fails(t.db.query('select * from absence_calendar'), /permission denied/);
    assert.equal((await t.rows("select count(*)::int n from onconic_migrations where version = '202611270004'").catch(() => [{ n: 1 }]))[0].n, 1);
    const f = (await t.rows("select prosecdef, provolatile, proconfig from pg_proc where proname = 'calendar_feries'"))[0];
    assert.equal(f.prosecdef, true); assert.equal(f.provolatile, 's');
    assert.ok(f.proconfig.some((c) => c.startsWith('search_path=')));
  } finally { await t.db.close(); }
});

test('2. seuls les fériés manuels sont renvoyés, plages dépliées, bornes incluses, aucun autre type', async () => {
  const t = await mk();
  try {
    await t.add('ferie', 'Pont fictif', '2027-05-14');
    await t.add('ferie', 'Fermeture fictive', '2027-07-09', '2027-07-12');
    await t.add('evenement', 'Retraite fictive', '2027-05-17', '2027-05-18');
    await t.add('presence_obligatoire', 'Journée fictive', '2027-05-19');
    await t.add('vacances_scolaires', 'Vacances fictives', '2027-07-01', '2027-07-31');
    await t.as(4);
    assert.deepEqual(await t.feries('2027-01-01', '2027-12-31'), [['2027-05-14', 'Pont fictif'], ['2027-07-09', 'Fermeture fictive'], ['2027-07-10', 'Fermeture fictive'], ['2027-07-11', 'Fermeture fictive'], ['2027-07-12', 'Fermeture fictive']]);
    // fenêtre qui coupe la plage : seuls les jours dans la fenêtre, bornes incluses
    assert.deepEqual((await t.feries('2027-07-10', '2027-07-11')).map((x) => x[0]), ['2027-07-10', '2027-07-11']);
    assert.deepEqual((await t.feries('2027-07-12', '2027-07-12')).map((x) => x[0]), ['2027-07-12']);
    assert.deepEqual(await t.feries('2027-07-13', '2027-08-30'), []);
    // les fériés vaudois calculés ne sont pas renvoyés (la page les calcule)
    assert.deepEqual(await t.feries('2027-12-24', '2027-12-26'), []);
    // seules deux colonnes, ni auteur ni identifiant
    const cols = (await t.rows('select * from public.calendar_feries($1::date, $2::date)', ['2027-05-14', '2027-05-14']));
    assert.deepEqual(Object.keys(cols[0]), ['day', 'label']);
    await t.sup();
  } finally { await t.db.close(); }
});

test('3. plage à cheval sur deux années, plage trop longue, dates invalides, suppression reflétée', async () => {
  const t = await mk();
  try {
    await t.add('ferie', 'Fin d\'année fictive', '2027-12-29', '2028-01-04');
    await t.add('ferie', 'Autre fictif', '2028-01-03');
    await t.as(5);
    assert.deepEqual((await t.feries('2027-12-20', '2028-01-10')).map((x) => x.join(' ')), [
      '2027-12-29 Fin d\'année fictive', '2027-12-30 Fin d\'année fictive', '2027-12-31 Fin d\'année fictive', '2028-01-01 Fin d\'année fictive', '2028-01-02 Fin d\'année fictive',
      '2028-01-03 Autre fictif', '2028-01-03 Fin d\'année fictive', '2028-01-04 Fin d\'année fictive']);
    // 800 jours exactement : accepté ; 801 : refusé
    await t.feries('2027-01-01', '2029-03-11');
    await t.fails(t.feries('2027-01-01', '2029-03-12'), /800 jours/);
    await t.as(5); await t.fails(t.feries('2027-01-10', '2027-01-01'), /Vérifiez les dates/);
    await t.as(5); await t.fails(t.feries(null, '2027-01-01'), /Vérifiez les dates/);
    await t.as(5); await t.fails(t.feries('2027-01-01', null), /Vérifiez les dates/);
    // suppression d'une entrée : reflétée au prochain appel
    await t.sup();
    await t.db.exec("delete from absence_calendar where label = 'Autre fictif'");
    await t.as(5);
    assert.equal((await t.feries('2028-01-03', '2028-01-03')).length, 1);
    await t.sup();
    await t.db.exec('delete from absence_calendar');
    await t.as(5);
    assert.deepEqual(await t.feries('2027-12-20', '2028-01-10'), []);
    await t.sup();
  } finally { await t.db.close(); }
});
