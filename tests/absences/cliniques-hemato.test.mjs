// Migration 202611230001 : cliniques « Hématologie » et « Tournus / Autre » (PGlite, données fictives).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
const root = new URL('../../', import.meta.url);
const read = (p) => readFile(new URL(p, root), 'utf8');
const uid = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const HEMA = 'Hématologie', TOUR = 'Tournus / Autre';

test('cliniques Hématologie et Tournus / Autre : réglages, contraintes, validations', async (t) => {
  const db = new PGlite();
  const as = async (n) => { await db.exec('reset role'); await db.query("select set_config('test.uid',$1,false)", [n ? uid(n) : '']); await db.exec('set role authenticated'); };
  const rows = async (sql, args = []) => (await db.query(sql, args)).rows;
  const one = async (sql, args = []) => Object.values((await db.query(sql, args)).rows[0])[0];
  try {
    await db.exec(await read('tests/absences/fixture.sql'));
    await db.exec('alter table auth.users add column banned_until timestamptz;');
    await db.exec("alter table public.calendar_tokens add primary key (user_id); alter table public.calendar_tokens alter column token set default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');");
    for (const f of ['absences.sql', 'cadre_medecin.sql', 'cadre_validateur.sql', 'absences_validation.sql', 'absences_forms.sql', 'absences_cliniques_datees.sql', 'admin_direction.sql', 'absences_export.sql', 'absences_soldes.sql', 'absences_visibilite.sql', 'absences_preavis.sql', 'absences_vue_ensemble.sql'])
      await db.exec(await read('supabase/' + f));
    for (const f of ['202611110001_absence_hardening.sql', '202611120001_nurse_role.sql', '202611120002_assistant_default_tools.sql', '202611130001_securite_advisors.sql'])
      await db.exec(await read('supabase/migrations/' + f));
    await db.exec(`
      alter table public.events add column clinics text[] not null default '{}';
      alter table public.profiles add column agenda_clinics text[] not null default '{}';
      create table public.trainings (id int primary key, pathology text not null,
        clinic text not null constraint trainings_clinic_check check (clinic in ('Sénologie', 'Lower GI', 'Upper GI', 'ORL', 'ION', 'UTOH')));
      create table public.autre_liste (id int primary key, clinic text constraint autre_liste_clinic_check check (clinic in ('Sénologie', 'ION', 'UTOH')));
      create table public.sans_rapport (id int primary key, clinic text constraint sans_rapport_check check (clinic <> ''));
      create table public.oncoodle_polls (id int primary key, audience jsonb not null default '{}');
      create table public.absence_circuits (id bigint generated always as identity primary key, name text);
      create table public.absence_circuit_assignments (circuit_id bigint not null references public.absence_circuits (id),
        target_type text not null check (target_type in ('member','role','clinic')), target text not null, primary key (target_type, target));
    `);
    // 1 admin, 2 direction, 3 médecin, 4 CDC, 5 cadre
    const people = [[1, 'admin'], [2, 'direction'], [3, 'clinician'], [4, 'cdc'], [5, 'cadre']];
    for (const [n, role] of people) {
      await db.query('insert into auth.users(id,email) values($1,$2)', [uid(n), `he${n}@example.com`]);
      await db.query('insert into profiles(id,full_name,role,institution,clinics) values($1,$2,$3,$4,$5)', [uid(n), `Hémato ${n}`, role, 'CHUV', []]);
    }
    await db.exec(await read('supabase/migrations/202611180003_cliniques_gi.sql'));
    await db.query("insert into trainings values (1,'Estomac','GI tube'),(2,'Larynx','ORL')");
    const before = (await rows('select clinic, pos from absence_clinic_settings order by pos')).map((r) => `${r.pos}:${r.clinic}`);
    assert.equal(before[before.length - 2], '14:Plateforme');
    assert.equal(before[before.length - 1], '15:Administration');
    await db.query("update absence_clinic_settings set max_absent = 5 where clinic = 'ION'");

    const mig = await read('supabase/migrations/202611230001_cliniques_hemato_tournus.sql');
    await db.exec(mig);

    await t.test('réglages : deux cliniques ajoutées, Plateforme et Administration décalées', async () => {
      const s = await rows('select clinic, pos, max_absent from absence_clinic_settings order by pos');
      assert.deepEqual(s.map((r) => r.clinic), ['Sénologie', 'Gynécologie', 'Urologie', 'Thoracique', 'Neuro-oncologie', 'Mélanome', 'GI tube', 'GI solide', 'ORL', 'Sarcomes', 'Rad-Inter', 'ION', 'UTOH', HEMA, TOUR, 'Plateforme', 'Administration']);
      assert.deepEqual(s.map((r) => r.pos), Array.from({ length: 17 }, (_, i) => i + 1));
      assert.equal(s.find((r) => r.clinic === HEMA).max_absent, 2);
      assert.equal(s.find((r) => r.clinic === 'ION').max_absent, 5);
    });
    await t.test('contraintes recréées (celle de formation et toute autre liste de cliniques)', async () => {
      await db.query(`insert into trainings values (3,'Lymphome','${HEMA}'),(4,'Divers','${TOUR}')`);
      await db.query(`insert into autre_liste values (1,'${HEMA}'),(2,'${TOUR}')`);
      await assert.rejects(db.query("insert into trainings values (5,'x','Inconnue')"), /trainings_clinic_check/);
      await assert.rejects(db.query("insert into trainings values (6,'x','Lower GI')"), /trainings_clinic_check/);
      await assert.rejects(db.query("insert into autre_liste values (3,'Inconnue')"), /autre_liste_clinic_check/);
      assert.equal(Number(await one("select count(*) from pg_constraint where conname = 'sans_rapport_check'")), 1);
      assert.equal(Number(await one("select count(*) from pg_constraint where conname = 'trainings_clinic_check'")), 1);
    });
    await t.test('validations : admin_set_cdc_clinics, admin_set_clinics, my_set_clinics', async () => {
      await as(1);
      assert.deepEqual(await one('select admin_set_cdc_clinics($1, $2)', [uid(4), [TOUR, HEMA, 'ORL']]), [HEMA, 'ORL', TOUR]);
      await assert.rejects(db.query('select admin_set_cdc_clinics($1, $2)', [uid(4), ['Inconnue']]), /Clinique inconnue : Inconnue/);
      assert.deepEqual(await one('select admin_set_clinics($1, $2)', [uid(3), [HEMA, TOUR]]), [HEMA, TOUR]);
      await assert.rejects(db.query('select admin_set_clinics($1, $2)', [uid(3), ['Administration']]), /Clinique inconnue/);
      await as(3);
      assert.deepEqual(await one('select my_set_clinics($1)', [[TOUR]]), [TOUR]);
      await as(0);
      await assert.rejects(db.query('select admin_set_cdc_clinics($1, $2)', [uid(4), [HEMA]]), /admin only|permission/);
      await as(3);
      await assert.rejects(db.query('select admin_set_cdc_clinics($1, $2)', [uid(4), [HEMA]]), /admin only/);
    });
    await t.test('seconde exécution : aucun changement', async () => {
      await db.exec('reset role');
      const snap = async () => JSON.stringify([await rows('select * from absence_clinic_settings order by clinic'), await rows('select conname, pg_get_constraintdef(oid) d from pg_constraint where connamespace = \'public\'::regnamespace and contype = \'c\' order by 1')]);
      const b = await snap();
      await db.exec(mig);
      assert.equal(await snap(), b);
      assert.equal(Number(await one("select count(*) from onconic_migrations where version='202611230001'")), 1);
      assert.equal(Number(await one("select count(*) from pg_constraint where conname = 'trainings_clinic_check' and pg_get_constraintdef(oid) like '%Tournus%'")), 1);
    });
    await t.test('droits de admin_set_cdc_clinics inchangés', async () => {
      await db.exec('reset role');
      assert.equal(await one("select has_function_privilege('anon', 'public.admin_set_cdc_clinics(uuid, text[])', 'execute')"), false);
      assert.equal(await one("select has_function_privilege('authenticated', 'public.admin_set_cdc_clinics(uuid, text[])', 'execute')"), true);
    });
  } finally { await db.close(); }
});
