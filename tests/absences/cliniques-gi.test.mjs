// Migration 202611180003 : « Lower GI » et « Upper GI » deviennent « GI tube » et « GI solide » (PGlite, données fictives).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
const root = new URL('../../', import.meta.url);
const read = (p) => readFile(new URL(p, root), 'utf8');
const uid = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

test('cliniques GI : conversion des données, dédoublonnage, validation', async (t) => {
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

    // Tables des autres modules (schémas réduits aux colonnes de cliniques) et tables de la phase suivante du circuit
    await db.exec(`
      alter table public.events add column clinics text[] not null default '{}';
      alter table public.profiles add column agenda_clinics text[] not null default '{}';
      create table public.key_trials (id int primary key, clinic text, diagnosis text);
      create table public.letters (id int primary key, clinic text, diagnosis text);
      create table public.medletter_templates (id int primary key, clinic text);
      create table public.protocols (id int primary key, clinic text);
      create table public.trainings (id int primary key, pathology text not null,
        clinic text not null constraint trainings_clinic_check check (clinic in ('Sénologie', 'Lower GI', 'Upper GI', 'ORL', 'ION', 'UTOH')));
      create table public.oncoodle_polls (id int primary key, audience jsonb not null default '{}');
      create table public.absence_circuit_assignments (clinic text not null references public.absence_clinic_settings (clinic) on update cascade on delete cascade,
        slot text not null, user_id uuid, primary key (clinic, slot));
      create table public.absence_blocs (bloc text primary key, clinics text[] not null);
      create function public.events_block() returns trigger language plpgsql as $$ begin raise exception 'déclencheur actif'; end $$;
      create trigger events_block before update on public.events for each row execute function public.events_block();
    `);

    // 1 admin, 2 médecin Lower GI, 3 médecin Upper GI, 4 médecin Lower + Upper + ORL, 5 cadre validateur Upper GI, 6 cadre validateur Lower + Upper, 7 CDC
    const people = [[1, 'admin', []], [2, 'clinician', ['Lower GI']], [3, 'clinician', ['Upper GI']], [4, 'clinician', ['Lower GI', 'Upper GI', 'ORL']], [5, 'cadre', []], [6, 'cadre', []], [7, 'cdc', []]];
    for (const [n, role, clinics] of people) {
      await db.query('insert into auth.users(id,email) values($1,$2)', [uid(n), `gi${n}@example.com`]);
      await db.query('insert into profiles(id,full_name,role,institution,clinics) values($1,$2,$3,$4,$5)', [uid(n), `GI ${n}`, role, 'CHUV', clinics]);
    }
    await db.query("update profiles set cdc_clinics=$2, agenda_clinics=$3 where id=$1", [uid(7), ['Upper GI', 'Sénologie', 'Lower GI'], ['Upper GI', 'ORL']]);
    await db.query('update profiles set absence_validator = true where id = $1', [uid(5)]);
    await db.query("update absence_clinic_settings set max_absent = 3 where clinic = 'Lower GI'");
    await db.query("update absence_clinic_settings set max_absent = 4 where clinic = 'Upper GI'");
    await db.query("insert into absence_validators(clinic,user_id) values ('Upper GI',$1),('Lower GI',$2),('Upper GI',$2),('Thoracique',$2)", [uid(5), uid(6)]);
    await db.query("insert into member_clinic_changes(user_id,valid_from,clinics) values ($1,'2027-01-01','{Upper GI,ORL}')", [uid(3)]);
    await db.query("insert into clinic_requests(user_id,clinics,previous_clinics) values ($1,'{Lower GI,Upper GI}','{Lower GI}')", [uid(2)]);
    await db.query("insert into events(id,title,start_date,end_date,clinics) values (1,'SAMO Workshop Upper GI Tumors 2027','2027-09-03','2027-09-04','{Lower GI,Upper GI}'),(2,'Autre','2027-01-01','2027-01-02','{ORL,Upper GI,Lower GI,Upper GI}'),(3,'Sans','2027-01-01','2027-01-02','{}')");
    await db.query("insert into key_trials values (1,'Lower GI','Cancer colorectal'),(2,'Upper GI','Adénocarcinome du pancréas'),(3,'Upper GI','Carcinome épidermoïde de l''œsophage'),(4,'Upper GI','Cholangiocarcinome'),(5,'Upper GI',null),(6,'ORL','Larynx')");
    await db.query("insert into letters values (1,'Upper GI','Carcinome hépatocellulaire'),(2,'Upper GI','Adénocarcinome gastrique')");
    await db.query("insert into medletter_templates values (1,'Upper GI'),(2,'Lower GI')");
    await db.query("insert into protocols values (1,'Upper GI')");
    await db.query("insert into trainings values (1,'Estomac','Upper GI'),(2,'Pancréas','Upper GI'),(3,'Rectum','Lower GI'),(4,'Larynx','ORL')");
    await db.query(`insert into oncoodle_polls values (1,'{"rules":[{"clinics":["Upper GI","ORL"],"roles":["clinician"]},{"all":true},{"clinics":["Lower GI"],"roles":[]}],"users":[],"exclude":[]}'),(2,'{}')`);
    await db.query("insert into absence_circuit_assignments values ('Lower GI','a',$1),('Upper GI','a',$2),('Upper GI','b',$2),('Thoracique','a',$1)", [uid(5), uid(6)]);
    await db.query("insert into absence_blocs values ('Bloc 3','{Lower GI,Upper GI,ORL}')");
    const histBefore = await one("select count(*) from member_clinic_history where 'Upper GI' = any(clinics) or 'Lower GI' = any(clinics)");
    assert.ok(Number(histBefore) >= 3);

    const mig = await read('supabase/migrations/202611180003_cliniques_gi.sql');
    await db.exec(mig);

    await t.test('première exécution : conversions', async () => {
      const cl = async (n) => (await rows('select clinics from profiles where id=$1', [uid(n)]))[0].clinics;
      assert.deepEqual(await cl(2), ['GI tube']);
      assert.deepEqual(await cl(3), ['GI tube', 'GI solide']);
      assert.deepEqual(await cl(4), ['GI tube', 'GI solide', 'ORL']);
      const p7 = (await rows('select cdc_clinics, agenda_clinics from profiles where id=$1', [uid(7)]))[0];
      assert.deepEqual(p7.cdc_clinics, ['GI tube', 'GI solide', 'Sénologie']);
      assert.deepEqual(p7.agenda_clinics, ['GI tube', 'GI solide', 'ORL']);
      assert.deepEqual((await rows("select clinics from member_clinic_changes where user_id=$1", [uid(3)]))[0].clinics, ['GI tube', 'GI solide', 'ORL']);
      const rq = (await rows('select clinics, previous_clinics from clinic_requests'))[0];
      assert.deepEqual(rq.clinics, ['GI tube', 'GI solide']); assert.deepEqual(rq.previous_clinics, ['GI tube']);
      assert.equal(Number(await one("select count(*) from member_clinic_history where 'Upper GI' = any(clinics) or 'Lower GI' = any(clinics)")), 0);
      // l'historique n'a pas gagné de ligne parasite (déclencheur suspendu)
      assert.equal(Number(await one("select count(*) from member_clinic_history")), Number(await one("select count(distinct (user_id, valid_from, clinics::text)) from member_clinic_history")));
      assert.deepEqual((await rows('select clinics from events order by id')).map((r) => r.clinics), [['GI tube', 'GI solide'], ['ORL', 'GI tube', 'GI solide'], []]);
      assert.equal(await one('select title from events where id=1'), 'SAMO Workshop Upper GI Tumors 2027');
      assert.deepEqual((await rows('select clinics from absence_blocs'))[0].clinics, ['GI tube', 'GI solide', 'ORL']);
    });
    await t.test('colonnes à une seule clinique', async () => {
      assert.deepEqual((await rows('select id, clinic from key_trials order by id')).map((r) => r.clinic), ['GI tube', 'GI solide', 'GI tube', 'GI solide', 'GI tube', 'ORL']);
      assert.deepEqual((await rows('select clinic from letters order by id')).map((r) => r.clinic), ['GI solide', 'GI tube']);
      assert.deepEqual((await rows('select clinic from medletter_templates order by id')).map((r) => r.clinic), ['GI solide', 'GI tube']);
      assert.equal(await one('select clinic from protocols'), 'GI solide');
      assert.deepEqual((await rows('select clinic from trainings order by id')).map((r) => r.clinic), ['GI tube', 'GI solide', 'GI tube', 'ORL']);
    });
    await t.test('contrainte de formation recréée', async () => {
      await db.query("insert into trainings values (5,'Foie','GI solide')");
      await assert.rejects(db.query("insert into trainings values (6,'Foie','Upper GI')"), /trainings_clinic_check/);
      await assert.rejects(db.query("insert into trainings values (7,'Colon','Lower GI')"), /trainings_clinic_check/);
    });
    await t.test('réglages et validateurs', async () => {
      const s = await rows('select clinic, pos, max_absent from absence_clinic_settings order by pos');
      assert.deepEqual(s.map((r) => r.clinic), ['Sénologie', 'Gynécologie', 'Urologie', 'Thoracique', 'Neuro-oncologie', 'Mélanome', 'GI tube', 'GI solide', 'ORL', 'Sarcomes', 'Rad-Inter', 'ION', 'UTOH', 'Plateforme', 'Administration'].filter((c) => s.some((r) => r.clinic === c)));
      const gt = s.find((r) => r.clinic === 'GI tube'), gs = s.find((r) => r.clinic === 'GI solide');
      assert.deepEqual([gt.pos, gt.max_absent, gs.pos, gs.max_absent], [7, 3, 8, 4]);
      assert.ok(!s.some((r) => /Lower|Upper/.test(r.clinic)));
      const v = (await rows("select clinic, user_id from absence_validators order by clinic, user_id")).map((r) => `${r.clinic}:${r.user_id.slice(-1)}`);
      assert.deepEqual(v, ['GI solide:5', 'GI solide:6', 'GI tube:5', 'GI tube:6', 'Thoracique:6']);
      const a = (await rows('select clinic, slot from absence_circuit_assignments order by clinic, slot')).map((r) => `${r.clinic}:${r.slot}`);
      assert.deepEqual(a, ['GI solide:a', 'GI solide:b', 'GI tube:a', 'GI tube:b', 'Thoracique:a']);
      assert.ok(await one("select user_id from absence_circuit_assignments where clinic='GI tube' and slot='a'"));
    });
    await t.test('audience Oncoodle', async () => {
      const aud = (await rows('select audience from oncoodle_polls order by id')).map((r) => r.audience);
      assert.deepEqual(aud[0].rules, [{ clinics: ['GI tube', 'GI solide', 'ORL'], roles: ['clinician'] }, { all: true }, { clinics: ['GI tube'], roles: [] }]);
      assert.deepEqual(aud[1], {});
    });
    await t.test('déclencheurs réactivés', async () => {
      assert.equal(await one("select tgenabled from pg_trigger where tgname='events_block'"), 'O');
      assert.equal(await one("select tgenabled from pg_trigger where tgname='clinic_history_record'"), 'O');
      await assert.rejects(db.query("update events set title='x' where id=3"), /déclencheur actif/);
    });

    await t.test('seconde exécution : aucun changement', async () => {
      const snap = async () => JSON.stringify([await rows('select * from profiles order by id'), await rows('select * from absence_validators order by 1,2'), await rows('select * from absence_clinic_settings order by clinic'),
        await rows('select * from events order by id'), await rows('select * from key_trials order by id'), await rows('select * from trainings order by id'), await rows('select * from member_clinic_history order by id'),
        await rows('select * from oncoodle_polls order by id'), await rows('select * from absence_circuit_assignments order by 1,2')]);
      const before = await snap();
      await db.exec(mig);
      assert.equal(await snap(), before);
      assert.equal(Number(await one("select count(*) from onconic_migrations where version='202611180003'")), 1);
    });

    await t.test('validation : nouveaux noms acceptés, anciens refusés', async () => {
      await as(1);
      assert.deepEqual(await one('select admin_set_clinics($1, $2)', [uid(2), ['GI solide', 'GI tube']]), ['GI solide', 'GI tube']);
      await assert.rejects(db.query('select admin_set_clinics($1, $2)', [uid(2), ['Upper GI']]), /Clinique inconnue : Upper GI/);
      await assert.rejects(db.query('select admin_set_clinics($1, $2)', [uid(2), ['Lower GI']]), /Clinique inconnue : Lower GI/);
      assert.deepEqual(await one('select admin_set_cdc_clinics($1, $2)', [uid(7), ['GI tube', 'GI solide']]), ['GI solide', 'GI tube']);
      await assert.rejects(db.query('select admin_set_cdc_clinics($1, $2)', [uid(7), ['Upper GI']]), /Clinique inconnue : Upper GI/);
      await assert.rejects(db.query('select admin_set_cdc_clinics($1, $2)', [uid(7), ['Lower GI']]), /Clinique inconnue : Lower GI/);
      assert.ok(await one("select admin_set_absence_validators('GI solide', $1)", [[uid(5)]]));
      await assert.rejects(db.query("select admin_set_absence_validators('Upper GI', $1)", [[uid(5)]]), /Clinique inconnue/);
      await assert.rejects(db.query("select admin_set_absence_threshold('Lower GI', 2)"), /Clinique inconnue/);
      await as(3);
      assert.deepEqual(await one('select my_set_clinics($1)', [['GI tube']]), ['GI tube']);
      await assert.rejects(db.query('select my_set_clinics($1)', [['Upper GI']]), /Clinique inconnue : Upper GI/);
      await as(0);
      await assert.rejects(db.query('select admin_set_cdc_clinics($1, $2)', [uid(7), ['GI tube']]), /admin only|permission/);
    });
  } finally { await db.close(); }
});
