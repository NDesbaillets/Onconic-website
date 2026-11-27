// Migration 202611270002 : création de membres permanents par la direction et l'administrateur (PGlite, données fictives).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
const root = new URL('../../', import.meta.url);
const read = (p) => readFile(new URL(p, root), 'utf8');
const uid = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const DOCTORS = ['clinician', 'cdc', 'cadre'];
const MEMBER_ROLES = ['clinician', 'cdc', 'cadre', 'assistant', 'nurse', 'pharmacist'];

test('création de membres : droits, profil posé, refus d\'écrasement, journal, migration réexécutable', async (t) => {
  const db = new PGlite();
  const as = async (n, role = 'authenticated') => { await db.exec('reset role'); await db.query("select set_config('test.uid',$1,false)", [n ? uid(n) : '']); await db.exec(`set role ${role}`); };
  const one = async (sql, args = []) => Object.values((await db.query(sql, args)).rows[0])[0];
  const apply = (actor, user, role, extra = {}) => db.query('select member_create_apply($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [uid(actor), uid(user), role, extra.first ?? 'Prénom', extra.last ?? 'Nom', extra.inst ?? 'CHUV', extra.clinics ?? [], extra.cdc ?? [], extra.mode ?? 'password']);
  const profile = async (n) => { await db.exec('reset role'); return (await db.query('select * from profiles where id=$1', [uid(n)])).rows[0]; };
  try {
    await db.exec(await read('tests/absences/fixture.sql'));
    await db.exec('alter table auth.users add column banned_until timestamptz;');
    await db.exec("alter table public.calendar_tokens add primary key (user_id); alter table public.calendar_tokens alter column token set default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');");
    for (const f of ['absences.sql', 'cadre_medecin.sql', 'cadre_validateur.sql', 'absences_validation.sql', 'absences_forms.sql', 'absences_cliniques_datees.sql', 'admin_direction.sql', 'absences_export.sql', 'absences_soldes.sql', 'absences_visibilite.sql', 'absences_preavis.sql', 'absences_vue_ensemble.sql'])
      await db.exec(await read('supabase/' + f));
    for (const f of ['202611110001_absence_hardening.sql', '202611120001_nurse_role.sql', '202611120002_assistant_default_tools.sql', '202611130001_securite_advisors.sql', '202611140001_absence_planning.sql', '202611160002_comptes_temporaires.sql', '202611170001_circuit_absences.sql'])
      await db.exec(await read('supabase/migrations/' + f));
    // 1 admin, 2 direction, 3 assistante cadre administratif, 4 médecin, 5 en attente, 6 direction à fin d'accès échue, 7 cadre validateur Thoracique,
    // 8 médecin Thoracique, 10 à 29 : comptes à créer
    const people = [[1, 'admin'], [2, 'direction'], [3, 'assistant'], [4, 'clinician'], [5, 'member'], [6, 'direction'], [7, 'cadre'], [8, 'clinician']];
    for (let n = 10; n < 30; n++) people.push([n, 'member']);
    for (const [n, role] of people) {
      await db.query('insert into auth.users(id,email) values($1,$2)', [uid(n), `cm${n}@example.com`]);
      await db.query('insert into profiles(id,full_name,role,institution,clinics,absence_validator) values($1,$2,$3,$4,$5,$6)', [uid(n), `Test ${n}`, role, 'CHUV', n === 7 || n === 8 ? ['Thoracique'] : [], n === 7]);
    }
    await db.query("insert into absence_validators(clinic,user_id) values ('Thoracique',$1)", [uid(7)]);
    for (const f of ['202611180001_circuit_configurable.sql', '202611180002_agenda_ultragenda.sql', '202611230001_cliniques_hemato_tournus.sql', '202611230002_absences_suivi_cheffe.sql', '202611270001_absences_historique_numero.sql'])
      await db.exec(await read('supabase/migrations/' + f));
    const mig = await read('supabase/migrations/202611270002_creation_membres_direction.sql');
    await db.exec(mig); await db.exec(mig); // réexécutable (deux fois de suite)
    await db.query('update profiles set admin_lead = true where id=$1', [uid(3)]);
    await db.query('update profiles set access_until = ch_date() - 1 where id=$1', [uid(6)]);
    // une demande en attente d'un autre membre (Thoracique), validée par le cadre 7
    await as(8);
    await db.query("select absence_request('vacances', null, '2027-01-04', '2027-01-05')");
    await db.query('select absence_submit()');
    await db.exec('reset role');
    const pendingBefore = (await db.query("select id, status from absences where user_id=$1", [uid(8)])).rows;
    assert.equal(pendingBefore[0].status, 'requested');

    await t.test('journal : « member_create » accepté, les autres actions aussi, le reste refusé', async () => {
      await db.exec('reset role');
      await db.query("insert into temp_account_log(actor, target, action) values ($1,$1,'member_create'), ($1,$1,'create')", [uid(1)]);
      await assert.rejects(db.query("insert into temp_account_log(actor, target, action) values ($1,$1,'autre')", [uid(1)]), /check/);
      await db.exec('delete from temp_account_log');
      assert.equal(await one("select count(*)::int from pg_constraint where conrelid='public.temp_account_log'::regclass and contype='c'"), 1, 'une seule contrainte, pas de doublon');
    });

    await t.test('member_create_allowed : matrice des rôles', async () => {
      const matrix = async (n) => { await as(n); const out = {}; for (const r of [...MEMBER_ROLES, 'direction', 'admin', 'member', 'inconnu']) out[r] = await one('select member_create_allowed($1)', [r]); return out; };
      const adminRow = await matrix(1);
      for (const r of [...MEMBER_ROLES, 'direction']) assert.equal(adminRow[r], true, 'admin crée ' + r);
      for (const r of ['admin', 'member', 'inconnu']) assert.equal(adminRow[r], false, 'admin ne crée pas ' + r);
      const dirRow = await matrix(2);
      for (const r of MEMBER_ROLES) assert.equal(dirRow[r], true, 'direction crée ' + r);
      for (const r of ['direction', 'admin', 'member', 'inconnu']) assert.equal(dirRow[r], false, 'direction ne crée pas ' + r);
      for (const [n, label] of [[3, 'assistante cadre administratif'], [4, 'médecin'], [5, 'membre en attente'], [6, 'direction à fin d\'accès échue']]) {
        for (const [r, v] of Object.entries(await matrix(n))) assert.equal(v, false, `${label} ne crée pas ${r}`);
      }
      await as(null);
      assert.equal(await one("select member_create_allowed('nurse')"), false, 'sans session');
      await as(null, 'anon');
      await assert.rejects(db.query("select member_create_allowed('nurse')"), /permission denied/);
    });

    await t.test('member_create_apply : fermée aux rôles applicatifs', async () => {
      for (const [n, role] of [[1, 'authenticated'], [2, 'authenticated'], [null, 'anon']]) {
        await as(n, role);
        await assert.rejects(apply(1, 10, 'nurse'), /permission denied/, `${role} ${n}`);
      }
      assert.equal((await profile(10)).role, 'member');
    });

    await t.test('profil posé par rôle : cliniques seulement pour les médecins', async () => {
      await db.query("insert into tool_access(user_id, tool, allowed) values ($1,'congres',false)", [uid(11)]);
      await as(null, 'service_role');
      await apply(2, 11, 'clinician', { first: ' Alice ', last: 'Martin', clinics: ['Thoracique', 'ION', 'ION'], cdc: ['ORL'] });
      let p = await profile(11);
      assert.deepEqual([p.role, p.first_name, p.last_name, p.full_name, p.institution, p.created_by, p.access_until, p.admin_lead], ['clinician', 'Alice', 'Martin', 'Alice Martin', 'CHUV', uid(2), null, false]);
      assert.deepEqual(p.clinics, ['ION', 'Thoracique']);
      assert.deepEqual(p.cdc_clinics, [], 'médecin assistant : pas de cliniques de gestion');
      assert.equal(await one('select count(*)::int from tool_access where user_id=$1', [uid(11)]), 0, 'accès par défaut du rôle');

      await as(null, 'service_role');
      await apply(1, 12, 'cdc', { clinics: ['Urologie'], cdc: ['Urologie', 'Sénologie'] });
      p = await profile(12);
      assert.deepEqual([p.role, p.clinics, p.cdc_clinics], ['cdc', ['Urologie'], ['Sénologie', 'Urologie']]);
      await as(null, 'service_role');
      await apply(2, 13, 'cadre', { clinics: ['ORL', 'Plateforme'], cdc: ['ORL'] });
      p = await profile(13);
      assert.deepEqual([p.role, p.clinics, p.cdc_clinics, p.absence_validator], ['cadre', ['ORL', 'Plateforme'], ['ORL'], false]);
      for (const [n, role] of [[14, 'assistant'], [15, 'nurse'], [16, 'pharmacist']]) {
        await as(null, 'service_role');
        await apply(2, n, role, { clinics: ['ORL'], cdc: ['ORL'] });
        p = await profile(n);
        assert.deepEqual([p.role, p.clinics, p.cdc_clinics, p.admin_lead], [role, [], [], false], role);
      }
      await as(null, 'service_role');
      await apply(1, 17, 'direction');
      assert.equal((await profile(17)).role, 'direction');
      await as(null, 'service_role');
      await apply(2, 18, 'pharmacist', { inst: 'Hors CHUV' });
      assert.equal((await profile(18)).institution, null);
      await as(null, 'service_role');
      await apply(2, 19, 'nurse', { inst: '' });
      assert.equal((await profile(19)).institution, 'CHUV', 'défaut CHUV');
    });

    await t.test('rôles admin et direction : refusés à la direction, admin jamais créé', async () => {
      await as(null, 'service_role');
      await assert.rejects(apply(2, 20, 'admin'), /refusée/);
      await assert.rejects(apply(2, 20, 'direction'), /refusée/);
      await assert.rejects(apply(1, 20, 'admin'), /refusée/);
      await assert.rejects(apply(1, 20, 'member'), /refusée/);
      await assert.rejects(apply(1, 20, 'inconnu'), /refusée/);
      assert.equal((await profile(20)).role, 'member');
    });

    await t.test('auteur sans droit : assistante cadre administratif, médecin, en attente, fin d\'accès échue, inconnu', async () => {
      await as(null, 'service_role');
      for (const actor of [3, 4, 5, 6]) await assert.rejects(apply(actor, 21, 'nurse'), /refusée/, 'auteur ' + actor);
      await assert.rejects(apply(999, 21, 'nurse'), /refusée/, 'auteur inconnu');
      assert.equal((await profile(21)).role, 'member');
    });

    await t.test('refus d\'écraser un membre existant, de se créer soi-même et de créer un compte absent', async () => {
      await as(null, 'service_role');
      await assert.rejects(apply(2, 4, 'nurse'), /déjà un rôle/);
      await assert.rejects(apply(2, 11, 'nurse'), /déjà un rôle/, 'compte créé plus tôt');
      await assert.rejects(apply(2, 2, 'nurse'), /refusée/);
      await assert.rejects(apply(2, 777, 'nurse'), /introuvable/);
      assert.equal((await profile(4)).role, 'clinician');
      assert.equal((await profile(11)).role, 'clinician');
    });

    await t.test('entrées invalides : clinique inconnue, Plateforme en gestion Key trials, institution, nom, mode', async () => {
      await as(null, 'service_role');
      await assert.rejects(apply(2, 22, 'clinician', { clinics: ['Nulle part'] }), /Clinique inconnue/);
      await assert.rejects(apply(2, 22, 'clinician', { clinics: ['Administration'] }), /Clinique inconnue/);
      await assert.rejects(apply(2, 22, 'cdc', { cdc: ['Plateforme'] }), /Clinique inconnue/);
      await assert.rejects(apply(2, 22, 'cdc', { cdc: ['Nulle part'] }), /Clinique inconnue/);
      await assert.rejects(apply(2, 22, 'nurse', { inst: 'Ailleurs' }), /Institution inconnue/);
      await assert.rejects(apply(2, 22, 'nurse', { first: '  ' }), /nécessaires/);
      await assert.rejects(apply(2, 22, 'nurse', { mode: 'autre' }), /Mode inconnu/);
      const p = await profile(22);
      assert.deepEqual([p.role, p.first_name], ['member', null], 'rien n\'est écrit en cas de refus');
    });

    await t.test('journal : acteur, cible, rôle et mode, sans nom ni e-mail', async () => {
      await db.exec('reset role');
      const rows = (await db.query("select actor, target, action, detail from temp_account_log where action='member_create' order by id")).rows;
      assert.equal(rows.length, 9);
      const first = rows[0];
      assert.deepEqual([first.actor, first.target, first.detail], [uid(2), uid(11), { role: 'clinician', mode: 'password' }]);
      for (const r of rows) {
        assert.deepEqual(Object.keys(r.detail).sort(), ['mode', 'role']);
        assert.ok(!JSON.stringify(r).includes('example.com') && !/Alice|Martin/.test(JSON.stringify(r)));
      }
      await as(2);
      await assert.rejects(db.query('select * from temp_account_log'), /permission denied/);
    });

    await t.test('clinique récente (Hématologie) acceptée ; cadre et CDC créés avec cliniques par la direction ; clinics_initialized', async () => {
      await as(null, 'service_role');
      await apply(2, 23, 'cadre', { clinics: ['Hématologie', 'Thoracique'], cdc: ['Hématologie'] });
      await apply(2, 24, 'cdc', { clinics: ['Tournus / Autre'], cdc: ['Tournus / Autre'] });
      await apply(2, 25, 'clinician', { clinics: [] });
      await apply(2, 26, 'nurse');
      let p = await profile(23);
      assert.deepEqual([p.role, p.clinics, p.cdc_clinics, p.clinics_initialized], ['cadre', ['Hématologie', 'Thoracique'], ['Hématologie'], true]);
      p = await profile(24);
      assert.deepEqual([p.role, p.clinics, p.cdc_clinics, p.clinics_initialized], ['cdc', ['Tournus / Autre'], ['Tournus / Autre'], true]);
      p = await profile(25);
      assert.deepEqual([p.clinics, p.clinics_initialized], [[], false], 'sans cliniques : le médecin choisit à sa première connexion');
      assert.equal((await profile(26)).clinics_initialized, false);
      // choix initial libre pour le médecin sans cliniques, refusé une fois initialisé
      await as(25);
      assert.equal((await one('select my_clinics()')).initial, true);
      await db.query("select my_set_clinics($1)", [['ORL']]);
      assert.deepEqual((await profile(25)).clinics, ['ORL']);
      await as(23);
      assert.equal((await one('select my_clinics()')).initial, false);
    });

    await t.test('absence_reroute et absence_recheck : sans effet de bord sur la demande en attente d\'un autre membre', async () => {
      await db.exec('reset role');
      const after = (await db.query("select id, status from absences where user_id=$1", [uid(8)])).rows;
      assert.deepEqual(after, pendingBefore, 'toujours en attente, non décidée');
      assert.equal(await one("select count(*)::int from absence_approvals where absence_id=$1 and decision='pending'", [after[0].id]) > 0, true, 'le validateur Thoracique reste sollicité');
      // la création d'un cadre validateur potentiel de la même clinique ne retire pas le validateur actuel
      assert.equal(await one("select count(*)::int from absence_approvals where absence_id=$1 and validator_id=$2", [after[0].id, uid(7)]) , 1);
    });

    await t.test('member_create_check : matrice d\'autorisation, cliniques et institution invalides', async () => {
      const chk = (role, cl = [], cdc = [], inst = 'CHUV') => db.query('select member_create_check($1,$2,$3,$4)', [role, cl, cdc, inst]);
      await as(2);
      await chk('cadre', ['Hématologie'], ['ORL']);
      await chk('nurse');
      await assert.rejects(chk('direction'), /refusée/);
      await assert.rejects(chk('admin'), /refusée/);
      await assert.rejects(chk('clinician', ['Nulle part']), (e) => e.code === 'OC002');
      await assert.rejects(chk('cdc', [], ['Plateforme']), (e) => e.code === 'OC002');
      await assert.rejects(chk('nurse', [], [], 'Ailleurs'), (e) => e.code === 'OC001');
      await as(1); await chk('direction');
      for (const n of [3, 4, 5, 6]) { await as(n); await assert.rejects(chk('nurse'), /refusée/, 'appelant ' + n); }
      await as(null, 'anon'); await assert.rejects(chk('nurse'), /permission denied/);
      await as(2); await assert.rejects(db.query("select member_create_validate('nurse','CHUV','{}','{}')"), /permission denied/);
    });

    await t.test('comptes temporaires inchangés : un membre créé n\'apparaît pas dans temp_accounts', async () => {
      await as(1);
      assert.equal((await db.query('select id from temp_accounts() where id=$1', [uid(14)])).rows.length, 0);
      await as(3);
      assert.equal(await one('select can_manage_temps()'), true);
      await as(2);
      await assert.rejects(db.query('select temp_account_set_until($1, ch_date()+5)', [uid(14)]), /pas un compte temporaire/);
    });
  } finally { await db.close(); }
});
