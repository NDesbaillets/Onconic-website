// Comptes temporaires et fonction cadre administratif (migration 202611160002), en PGlite, données fictives.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
const root = new URL('../../', import.meta.url);
const read = (p) => readFile(new URL(p, root), 'utf8');
const uid = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

test('comptes temporaires : droits, fin d\'accès, blocage et journal', async (t) => {
  const db = new PGlite();
  const as = async (n) => { await db.exec('reset role'); await db.query("select set_config('test.uid',$1,false)", [n ? uid(n) : '']); await db.exec('set role authenticated'); };
  const one = async (sql, args = []) => Object.values((await db.query(sql, args)).rows[0])[0];
  try {
    await db.exec(await read('tests/absences/fixture.sql'));
    await db.exec('alter table auth.users add column banned_until timestamptz;');
    for (const f of ['absences.sql', 'cadre_medecin.sql', 'cadre_validateur.sql', 'absences_validation.sql', 'absences_forms.sql', 'absences_cliniques_datees.sql', 'admin_direction.sql', 'absences_export.sql', 'absences_soldes.sql', 'absences_visibilite.sql', 'absences_preavis.sql', 'absences_vue_ensemble.sql'])
      await db.exec(await read('supabase/' + f));
    for (const f of ['202611110001_absence_hardening.sql', '202611120001_nurse_role.sql', '202611120002_assistant_default_tools.sql', '202611130001_securite_advisors.sql'])
      await db.exec(await read('supabase/migrations/' + f));
    const mig = await read('supabase/migrations/202611160002_comptes_temporaires.sql');
    await db.exec(mig); await db.exec(mig); // réexécutable
    // 1 admin, 2 direction, 3 assistante cadre admin, 4 assistante, 5 temporaire actif, 6 temporaire échu, 7 médecin
    for (const [n, role] of [[1, 'admin'], [2, 'direction'], [3, 'assistant'], [4, 'assistant'], [5, 'assistant'], [6, 'assistant'], [7, 'clinician']]) {
      await db.query('insert into auth.users(id,email) values($1,$2)', [uid(n), `t${n}@example.invalid`]);
      await db.query('insert into profiles(id,full_name,role,institution) values($1,$2,$3,$4)', [uid(n), `Test ${n}`, role, 'CHUV']);
    }
    await db.query("update profiles set access_until = ch_date() + 10, created_by=$2 where id=$1", [uid(5), uid(2)]);
    await db.query("update profiles set access_until = ch_date() - 1, created_by=$2 where id=$1", [uid(6), uid(2)]);

    await t.test('fonction cadre administratif : posée par la direction, sur une assistante permanente seulement', async () => {
      await as(4); await assert.rejects(db.query('select admin_set_admin_lead($1,true)', [uid(4)]), /admin only/);
      await as(2);
      await assert.rejects(db.query('select admin_set_admin_lead($1,true)', [uid(7)]), /réservée au rôle Assistante/);
      await assert.rejects(db.query('select admin_set_admin_lead($1,true)', [uid(5)]), /temporaire/);
      await db.query('select admin_set_admin_lead($1,true)', [uid(3)]);
      await as(3); assert.equal(await one('select is_admin_lead()'), true); assert.ok((await one('select my_tools()')).includes('temporaires'));
      await as(4); assert.equal(await one('select is_admin_lead()'), false); assert.ok(!(await one('select my_tools()')).includes('temporaires'));
      await as(7); assert.ok(!(await one('select my_tools()')).includes('temporaires'));
      await as(2); assert.ok((await one('select my_tools()')).includes('temporaires'));
    });
    await t.test('la colonne admin_lead et la fin d\'accès ne se modifient pas directement', async () => {
      await as(4);
      await assert.rejects(db.query('update profiles set admin_lead=true where id=$1', [uid(4)]), /permission denied/);
      await assert.rejects(db.query('update profiles set access_until=null where id=$1', [uid(4)]), /permission denied/);
    });
    await t.test('compte échu : plus aucun droit, rôle « en attente »', async () => {
      await as(6);
      assert.equal(await one('select current_role_name()'), 'member');
      assert.deepEqual(await one('select my_tools()'), []);
      await as(5);
      assert.equal(await one('select current_role_name()'), 'assistant');
      assert.ok((await one('select my_tools()')).includes('duree'));
    });
    await t.test('liste : réservée, échus bloqués à la connexion et journalisés', async () => {
      await as(4); await assert.rejects(db.query('select * from temp_accounts()'), /Réservé aux cadres administratifs/);
      await as(3);
      const rows = (await db.query('select id, active from temp_accounts()')).rows;
      assert.deepEqual(rows.map((r) => [r.id, r.active]), [[uid(5), true], [uid(6), false]]);
      await db.exec('reset role');
      assert.ok(await one('select banned_until > now() from auth.users where id=$1', [uid(6)]));
      assert.equal(await one('select banned_until from auth.users where id=$1', [uid(5)]), null);
      assert.equal(await one("select count(*)::int from temp_account_log where action='expire' and target=$1", [uid(6)]), 1);
      await as(3); await db.query('select * from temp_accounts()');
      await db.exec('reset role');
      assert.equal(await one("select count(*)::int from temp_account_log where action='expire'"), 1, 'pas de double journal');
    });
    await t.test('prolonger, terminer : comptes temporaires seulement, un an au plus', async () => {
      await as(3);
      await assert.rejects(db.query('select temp_account_set_until($1, ch_date()+5)', [uid(4)]), /pas un compte temporaire/);
      await assert.rejects(db.query('select temp_account_set_until($1, ch_date()+5)', [uid(3)]), /pas un compte temporaire/);
      await assert.rejects(db.query('select temp_account_set_until($1, ch_date()+400)', [uid(5)]), /trop lointaine/);
      await db.query('select temp_account_set_until($1, ch_date()+30)', [uid(6)]);
      await db.exec('reset role');
      assert.equal(await one('select banned_until from auth.users where id=$1', [uid(6)]), null, 'prolongé : débloqué');
      await as(6); assert.equal(await one('select current_role_name()'), 'assistant');
      await as(3); await db.query('select temp_account_set_until($1, ch_date()-1)', [uid(6)]);
      await as(6); assert.equal(await one('select current_role_name()'), 'member');
      await db.exec('reset role');
      assert.ok(await one('select banned_until > now() from auth.users where id=$1', [uid(6)]));
      assert.deepEqual((await db.query("select action from temp_account_log where actor=$1 order by id", [uid(3)])).rows.map((r) => r.action), ['extend', 'end']);
    });
    await t.test('limite posée par l\'admin sur un compte permanent : hors de portée du cadre, blocage étranger conservé', async () => {
      await as(2); await db.query('select admin_set_access_until($1, ch_date()-1)', [uid(4)]);
      await as(3);
      await assert.rejects(db.query('select temp_account_set_until($1, ch_date()+30)', [uid(4)]), /pas un compte temporaire/);
      assert.ok(!(await db.query('select id from temp_accounts()')).rows.some((r) => r.id === uid(4)));
      await db.exec('reset role');
      await db.query("update auth.users set banned_until = now() + interval '3 days' where id=$1", [uid(7)]);
      await db.query('select temp_account_ban($1,false)', [uid(7)]);
      assert.ok(await one('select banned_until is not null from auth.users where id=$1', [uid(7)]));
    });
    await t.test('journal et fonctions internes inaccessibles aux membres', async () => {
      await as(3);
      await assert.rejects(db.query('select * from temp_account_log'), /permission denied/);
      await assert.rejects(db.query('select temp_account_ban($1,false)', [uid(6)]), /permission denied/);
      await assert.rejects(db.query('select temp_accounts_expire()'), /permission denied/);
    });
    await t.test('administration : limite d\'accès et rôle', async () => {
      await as(2);
      await assert.rejects(db.query('select admin_set_access_until($1, ch_date())', [uid(1)]), /pas limités/);
      await db.query('select admin_set_access_until($1, null)', [uid(5)]);
      assert.equal((await db.query('select * from admin_members_extra() where id=$1', [uid(5)])).rows[0].access_until, null);
      await db.query("select admin_set_role($1,'clinician')", [uid(3)]);
      await db.exec('reset role');
      assert.equal(await one('select admin_lead from profiles where id=$1', [uid(3)]), false, 'changement de rôle : fonction retirée');
    });
  } finally { await db.close(); }
});
