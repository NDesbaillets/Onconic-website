import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, read, uid } from './oncoodle-db.mjs';
import { wants as wantsAbsence } from '../../supabase/functions/notify-absence/prefs.ts';
import { wants as wantsEvent } from '../../supabase/functions/notify-event-join/prefs.ts';

const OWN = ['approved', 'rejected', 'change_approved', 'change_rejected', 'direction_change'];

test('réglages de notifications : types proposés, enregistrement et droits (PostgreSQL)', async (t) => {
  const db = await makeDb();
  const superuser = () => db.exec('reset role');
  const as = async (n) => { await superuser(); await db.query("select set_config('test.uid',$1,false)", [n ? uid(n) : '']); await db.exec('set role authenticated'); };
  const rpc = async (name, args = []) => Object.values((await db.query(`select public.${name}(${args.map((_, i) => '$' + (i + 1)).join(',')})`, args)).rows[0])[0];
  const kinds = async () => (await rpc('my_notification_prefs')).kinds;
  const names = async () => (await kinds()).map((k) => k.kind);
  try {
    const migration = await read('supabase/migrations/202611140002_notification_prefs.sql');
    await db.exec(migration); await db.exec(migration); // réexécutable
    await db.query('update profiles set absence_validator=false where id=$1', [uid(6)]);

    await t.test('types proposés selon le rôle, les outils et la désignation de valideur', async () => {
      await as(3); assert.deepEqual(await names(), [...OWN, 'event_join'], 'médecin assistant : ses absences et les congrès');
      await as(5); assert.deepEqual(await names(), ['to_validate', 'to_validate_change', 'reminder', ...OWN, 'event_join'], 'médecin cadre valideur');
      await as(6); assert.deepEqual(await names(), [...OWN, 'event_join'], 'médecin cadre non valideur : pas de demandes à valider');
      await as(2); assert.deepEqual(await names(), ['to_direction', 'to_opinion', 'reminder', ...OWN, 'event_join'], 'direction');
      await as(1); assert.deepEqual((await names()).sort(), ['to_validate', 'to_validate_change', 'to_direction', 'to_opinion', 'reminder', ...OWN, 'event_join'].sort(), 'admin : tout');
      await as(7); assert.deepEqual(await names(), [], 'infirmier·ère : ni Absences ni Congrès par défaut');
      await as(8); assert.deepEqual(await names(), [], 'assistante médicale : ni Absences ni Congrès par défaut');
      await as(9); assert.deepEqual(await names(), [], 'compte en attente');
    });

    await t.test('tout est activé par défaut ; pas d\'e-mail pour les congrès', async () => {
      await as(5);
      const k = await kinds();
      assert.ok(k.filter((x) => x.kind !== 'event_join').every((x) => x.email === true && x.push === true));
      assert.deepEqual(k.find((x) => x.kind === 'event_join'), { kind: 'event_join', email: null, push: true });
    });

    await t.test('enregistrement par type et par canal, persistant, indépendant entre membres', async () => {
      await as(5);
      let k = (await rpc('my_set_notification_pref', ['to_validate', 'email', false])).kinds;
      assert.deepEqual(k.find((x) => x.kind === 'to_validate'), { kind: 'to_validate', email: false, push: true });
      await rpc('my_set_notification_pref', ['reminder', 'push', false]);
      await rpc('my_set_notification_pref', ['to_validate', 'email', false]); // idempotent
      k = await kinds();
      assert.equal(k.find((x) => x.kind === 'reminder').push, false);
      assert.equal(k.find((x) => x.kind === 'to_validate_change').email, true, 'les autres types ne bougent pas');
      await superuser();
      assert.deepEqual((await db.query('select notif_prefs from profiles where id=$1', [uid(5)])).rows[0].notif_prefs, { to_validate: { email: false }, reminder: { push: false } });
      assert.deepEqual((await db.query('select notif_prefs from profiles where id=$1', [uid(2)])).rows[0].notif_prefs, {}, 'un autre membre n\'est pas touché');
      await as(5); await rpc('my_set_notification_pref', ['to_validate', 'email', true]);
      assert.equal((await kinds()).find((x) => x.kind === 'to_validate').email, true);
    });

    await t.test('validations : type indisponible, canal inconnu, congrès sans e-mail, valeur manquante', async () => {
      await as(7); await assert.rejects(rpc('my_set_notification_pref', ['to_validate', 'email', false]), /non disponible/);
      await as(3); await assert.rejects(rpc('my_set_notification_pref', ['to_validate', 'email', false]), /non disponible/, 'un médecin non valideur ne règle pas les demandes à valider');
      await assert.rejects(rpc('my_set_notification_pref', ['approved', 'sms', false]), /Canal inconnu/);
      await assert.rejects(rpc('my_set_notification_pref', ['event_join', 'email', false]), /pas par e-mail/);
      await assert.rejects(rpc('my_set_notification_pref', ['n_importe_quoi', 'email', false]), /non disponible/);
      await assert.rejects(db.query("select public.my_set_notification_pref('approved','email',null)"), /Valeur manquante/);
    });

    await t.test('remise à zéro : tout réactivé', async () => {
      await as(5);
      await rpc('my_set_notification_pref', ['to_validate', 'email', false]);
      await rpc('my_set_notification_pref', ['approved', 'push', false]);
      const k = (await rpc('my_reset_notification_prefs')).kinds;
      assert.ok(k.every((x) => x.email !== false && x.push !== false));
      await superuser();
      assert.deepEqual((await db.query('select notif_prefs from profiles where id=$1', [uid(5)])).rows[0].notif_prefs, {});
    });

    await t.test('droits : pas d\'écriture directe, rien pour l\'anonyme, fonctions internes fermées', async () => {
      await as(5);
      await assert.rejects(db.query("update profiles set notif_prefs='{\"to_validate\":{\"email\":false}}' where id=$1", [uid(5)]), /permission denied/);
      await assert.rejects(rpc('notification_kinds_for', [uid(5)]), /permission denied/);
      await superuser();
      assert.equal((await db.query("select has_column_privilege('authenticated','public.profiles','notif_prefs','UPDATE') as ok")).rows[0].ok, false);
      await db.query("select set_config('test.uid','',false)"); await db.exec('set role authenticated');
      await assert.rejects(rpc('my_notification_prefs'), /Connexion requise/);
      await assert.rejects(rpc('my_set_notification_pref', ['approved', 'email', false]), /Connexion requise/);
      await superuser(); await db.exec('set role anon');
      await assert.rejects(db.query('select public.my_notification_prefs()'), /permission denied/);
    });
  } finally { await db.close(); }
});

test('envoi : un type ou un canal désactivé n\'est pas envoyé, un rappel suit son type de base', () => {
  for (const wants of [wantsAbsence, wantsEvent]) {
    assert.equal(wants(undefined, 'to_validate', 'email'), true, 'sans réglage, tout est reçu');
    assert.equal(wants(null, 'to_validate', 'push'), true);
    assert.equal(wants({}, 'approved', 'email'), true);
    const p = { to_validate: { email: false }, reminder: { push: false }, to_direction: { email: false, push: false }, event_join: { push: false } };
    assert.equal(wants(p, 'to_validate', 'email'), false);
    assert.equal(wants(p, 'to_validate', 'push'), true, 'l\'autre canal reste actif');
    assert.equal(wants(p, 'to_validate_change', 'email'), true, 'un autre type n\'est pas touché');
    assert.equal(wants(p, 'to_validate', 'push', true), false, 'rappel coupé sur le canal push');
    assert.equal(wants(p, 'to_validate_change', 'email', true), true, 'rappel : e-mail encore actif');
    assert.equal(wants({ to_validate: { push: false } }, 'to_validate', 'push', true), false, 'type de base coupé : pas de rappel');
    assert.equal(wants(p, 'to_direction', 'email'), false); assert.equal(wants(p, 'to_direction', 'push'), false);
    assert.equal(wants(p, 'event_join', 'push'), false);
    assert.equal(wants('texte', 'to_validate', 'email'), true, 'valeur inattendue : comportement par défaut');
    assert.equal(wants([], 'to_validate', 'email'), true);
    assert.equal(wants({ to_validate: 'non' }, 'to_validate', 'email'), true);
  }
});
