import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, read, uid } from './oncoodle-db.mjs';

// Oncoodle : droits, destinataires, réponses, conflits, clôture, relances. Données entièrement fictives, aucune base distante.
const SETOF = ['oncoodle_people', 'oncoodle_list', 'oncoodle_outbox_claim'];

test('Oncoodle : PostgreSQL', async (t) => {
  const db = await makeDb();
  const superuser = () => db.exec('reset role');
  const as = async (n) => { await superuser(); await db.query("select set_config('test.uid',$1,false)", [n ? uid(n) : '']); await db.exec('set role authenticated'); };
  const service = async () => { await superuser(); await db.query("select set_config('test.uid','',false)"); await db.exec('set role service_role'); };
  const scalar = async (sql, args = []) => Object.values((await db.query(sql, args)).rows[0])[0];
  const rpc = async (name, args = []) => {
    const call = `public.${name}(${args.map((_, i) => '$' + (i + 1)).join(',')})`;
    const r = await db.query(SETOF.includes(name) ? `select to_jsonb(r) as data from ${call} r` : `select ${call}`, args);
    return SETOF.includes(name) ? r.rows.map((x) => x.data) : Object.values(r.rows[0])[0];
  };
  const outbox = async (kind, poll) => { await superuser(); return (await db.query('select recipient, kind, payload, next_attempt_at, skipped_at, sent_at from oncoodle_outbox where kind=$1 and poll_id=$2 order by recipient', [kind, poll])).rows; };
  const D1 = '2026-11-20', D2 = '2026-11-24', D3 = '2026-11-26';
  const slots = [{ day: D1, start: '12:00', end: '13:00' }, { day: D2, start: '12:00', end: '13:00' }, { day: D3 }];

  try {
    await t.test('accès : tous les membres validés, pas les comptes en attente ; tables fermées', async () => {
      for (const n of [1, 2, 3, 5, 7, 8, 10]) { await as(n); assert.ok((await rpc('my_tools')).includes('oncoodle'), `membre ${n}`); }
      await as(9); assert.ok(!(await rpc('my_tools')).includes('oncoodle'));
      await assert.rejects(rpc('oncoodle_people'), /Accès refusé/);
      await assert.rejects(rpc('oncoodle_list'), /Accès refusé/);
      await as(3);
      await assert.rejects(db.query('select * from oncoodle_polls'), /permission denied/);
      await assert.rejects(db.query('select * from oncoodle_outbox'), /permission denied/);
      await assert.rejects(rpc('oncoodle_tick'), /permission denied/);
      await assert.rejects(rpc('oncoodle_outbox_claim', [10]), /permission denied/);
      await assert.rejects(rpc('oncoodle_mail_data', [1, uid(3)]), /permission denied/);
      await superuser(); await db.exec("set role anon");
      await assert.rejects(db.query('select public.oncoodle_pending_count()'), /permission denied/);
    });

    await t.test('annuaire : membres validés seulement', async () => {
      await as(7);
      const p = await rpc('oncoodle_people');
      assert.equal(p.length, 10);
      assert.ok(!p.some((x) => x.id === uid(9)));
      assert.ok(p.find((x) => x.id === uid(7)).is_me);
    });

    await t.test('destinataires : cliniques ET fonctions, individus, exclusions, tous', async () => {
      await as(3);
      const ids = async (a) => (await rpc('oncoodle_audience_preview', [a])).members.map((m) => m.id).sort();
      assert.deepEqual(await ids({ rules: [{ clinics: ['Thoracique'] }] }), [uid(3), uid(4), uid(5), uid(10)]);
      assert.deepEqual(await ids({ rules: [{ clinics: ['Thoracique'], roles: ['clinician'] }] }), [uid(3), uid(4)]);
      assert.deepEqual(await ids({ rules: [{ roles: ['nurse'] }] }), [uid(7)]);
      assert.deepEqual(await ids({ rules: [{ clinics: ['Urologie'] }, { roles: ['nurse', 'assistant'] }] }), [uid(11), uid(6), uid(7), uid(8)].sort());
      assert.deepEqual(await ids({ rules: [{ roles: ['nurse'] }], users: [uid(11)], exclude: [uid(7)] }), [uid(11)]);
      assert.equal((await rpc('oncoodle_audience_preview', [{ rules: [{ all: true }] }])).count, 10);
      const via = (await rpc('oncoodle_audience_preview', [{ rules: [{ clinics: ['Thoracique'], roles: ['cdc'] }], users: [uid(10)] }])).members;
      assert.equal(via[0].via, 'Individuel');
      await assert.rejects(rpc('oncoodle_audience_preview', [{ rules: [{ clinics: ['Inconnue'] }] }]), /Clinique inconnue/);
      await assert.rejects(rpc('oncoodle_audience_preview', [{ rules: [{ roles: ['roi'] }] }]), /Fonction inconnue/);
      await assert.rejects(rpc('oncoodle_audience_preview', [{ rules: [{}] }]), /au moins une clinique ou une fonction/);
      await assert.rejects(rpc('oncoodle_audience_preview', [{ users: ['pas-un-uuid'] }]), /Destinataires invalides/);
      await assert.rejects(rpc('oncoodle_audience_preview', [JSON.stringify('x')]), /Destinataires invalides/);
    });

    let poll;
    await t.test('création : validations et file d\'invitations', async () => {
      await as(3);
      const base = { kind: 'slots', title: 'Colloque thoracique', options: slots, audience: { rules: [{ clinics: ['Thoracique'] }] } };
      await assert.rejects(rpc('oncoodle_create', [{ ...base, title: 'ab' }]), /titre/);
      await assert.rejects(rpc('oncoodle_create', [{ ...base, options: [{ day: '2026-11-10' }, { day: D1 }] }]), /passé/);
      await assert.rejects(rpc('oncoodle_create', [{ ...base, options: [{ day: D1 }] }]), /au moins deux créneaux/);
      await assert.rejects(rpc('oncoodle_create', [{ ...base, options: [{ day: D1, start: '12:00' }, { day: D2 }] }]), /heure de début et une heure de fin/);
      await assert.rejects(rpc('oncoodle_create', [{ ...base, options: [{ day: D1, start: '13:00', end: '12:00' }, { day: D2 }] }]), /heure de fin/);
      await assert.rejects(rpc('oncoodle_create', [{ ...base, options: [{ day: '2026-02-31' }, { day: D2 }] }]), /Date invalide/);
      await assert.rejects(rpc('oncoodle_create', [{ ...base, kind: 'rsvp' }]), /exactement une date/);
      await assert.rejects(rpc('oncoodle_create', [{ ...base, deadline: '2020-01-01T10:00:00Z' }]), /futur/);
      await assert.rejects(rpc('oncoodle_create', [{ ...base, audience: { users: [uid(3)] } }]), /Aucun destinataire/);
      await assert.rejects(rpc('oncoodle_create', [{ ...base, visibility: 'public' }]), /Visibilité/);
      await assert.rejects(rpc('oncoodle_create', [{ ...base, title: 'Titre\nBcc: x@y.z' }]), /une seule ligne/);
      await assert.rejects(rpc('oncoodle_create', [{ ...base, location: 'a\rb' }]), /une seule ligne/);
      poll = await rpc('oncoodle_create', [{ ...base, description: 'Salle 12', required: [uid(5)] }]);
      const inv = await outbox('invite', poll);
      assert.deepEqual(inv.map((r) => r.recipient).sort(), [uid(4), uid(5), uid(10)]);
      await superuser();
      assert.equal(await scalar('select count(*)::int from oncoodle_invitees where poll_id=$1', [poll]), 4);
      assert.equal(await scalar('select required from oncoodle_invitees where poll_id=$1 and user_id=$2', [poll, uid(5)]), true);
      assert.equal(await scalar('select via from oncoodle_invitees where poll_id=$1 and user_id=$2', [poll, uid(3)]), 'Organisateur');
    });

    await t.test('lecture : seuls le créateur et les invités', async () => {
      await as(6); await assert.rejects(rpc('oncoodle_get', [poll]), /introuvable/);
      await assert.rejects(rpc('oncoodle_vote', [poll, [], null]), /introuvable/);
      assert.equal((await rpc('oncoodle_list')).length, 0);
      await as(4);
      const l = await rpc('oncoodle_list'); assert.equal(l.length, 1);
      assert.equal(l[0].needs_answer, true); assert.equal(l[0].invited, true); assert.equal(l[0].n_invited, 4);
      assert.equal(await rpc('oncoodle_pending_count'), 1);
      const g = await rpc('oncoodle_get', [poll]);
      assert.equal(g.poll.is_creator, false); assert.equal(g.options.length, 3); assert.equal(g.poll.audience, null);
      assert.equal(g.options[2].start, null);
    });

    await t.test('réponses : validations, mise à jour, compteurs, commentaire', async () => {
      await as(4);
      const g = await rpc('oncoodle_get', [poll]); const [o1, o2, o3] = g.options.map((o) => o.id);
      await assert.rejects(rpc('oncoodle_vote', [poll, [{ option_id: o1, answer: 'oui' }], null]), /Réponse invalide/);
      await assert.rejects(rpc('oncoodle_vote', [poll, [{ option_id: 999999, answer: 'yes' }], null]), /Créneau inconnu/);
      await assert.rejects(rpc('oncoodle_vote', [poll, JSON.stringify('x'), null]), /Réponses invalides/);
      await assert.rejects(rpc('oncoodle_vote', [poll, [{ option_id: o1, answer: 'yes' }], 'x'.repeat(301)]), /300 caractères/);
      await rpc('oncoodle_vote', [poll, [{ option_id: o1, answer: 'yes' }, { option_id: o2, answer: 'maybe' }, { option_id: o3, answer: 'no' }], 'Plutôt le matin']);
      await rpc('oncoodle_vote', [poll, [{ option_id: o2, answer: 'yes' }], null]);
      await as(5);
      await rpc('oncoodle_vote', [poll, [{ option_id: o1, answer: 'no' }, { option_id: o2, answer: 'yes' }], null]);
      await as(3);
      const c = await rpc('oncoodle_get', [poll]);
      const by = (id) => c.options.find((o) => o.id === id);
      assert.deepEqual([by(o1).yes, by(o1).no, by(o1).req_no], [1, 1, 1]);
      assert.deepEqual([by(o2).yes, by(o2).maybe, by(o2).req_yes], [2, 0, 1]);
      assert.deepEqual(c.counts, { invited: 4, responded: 2 });
      assert.equal(c.invitees.find((i) => i.id === uid(4)).comment, null);
      assert.equal(c.invitees.find((i) => i.id === uid(4)).votes[o2], 'yes');
      await as(4);
      assert.equal(await rpc('oncoodle_pending_count'), 0);
      await rpc('oncoodle_vote', [poll, [{ option_id: o1, answer: null }, { option_id: o2, answer: null }, { option_id: o3, answer: null }], 'x']);
      assert.equal((await rpc('oncoodle_list'))[0].answered, false);
      await rpc('oncoodle_vote', [poll, [{ option_id: o1, answer: 'yes' }], 'Plutôt le matin']);
      await as(3); assert.equal((await rpc('oncoodle_get', [poll])).invitees.find((i) => i.id === uid(4)).comment, 'Plutôt le matin');
    });

    await t.test('conflits : absences validées sans noms, droits de lecture respectés, agenda commun', async () => {
      await superuser();
      await db.query("insert into absences(user_id,kind,start_date,end_date,status) values($1,'vacances',$2,$2,'approved'),($3,'vacances',$2,$2,'requested')", [uid(4), D1, uid(10)]);
      await db.query("insert into absence_calendar(kind,label,start_date,end_date) values('vacances_scolaires','Vacances d''automne',$1,$1),('evenement','Retraite du service',$1,$1)", [D1]);
      await as(3);
      let g = await rpc('oncoodle_get', [poll]);
      assert.equal(g.options[0].absent, 1, 'seule l\'absence validée compte');
      assert.equal(g.options[0].absent_req, 0);
      assert.deepEqual(g.options[0].cal, ['Vacances d\'automne', 'Retraite du service']);
      assert.equal(g.options[1].absent, 0);
      await as(4);
      g = await rpc('oncoodle_get', [poll]);
      assert.equal(g.options[0].mine_absent, 'approved');
      await as(10);
      g = await rpc('oncoodle_get', [poll]);
      assert.equal(g.options[0].mine_absent, 'requested');
      await as(7); // infirmier : pas d'Absences, donc ni comptage ni événements, seulement les vacances scolaires
      // le nurse n'est pas invité : invitons-le à un second sondage
      await as(3);
      const p2 = await rpc('oncoodle_create', [{ kind: 'rsvp', title: 'Repas d\'équipe', options: [{ day: D1, start: '19:00', end: '22:00' }], audience: { rules: [{ roles: ['nurse'] }], users: [uid(4)] } }]);
      await as(7);
      g = await rpc('oncoodle_get', [p2]);
      assert.equal(g.options[0].absent, null); assert.deepEqual(g.options[0].cal, ['Vacances d\'automne']);
      await as(3); await rpc('oncoodle_delete', [p2]);
    });

    await t.test('visibilité « créateur seulement » : les invités ne voient que leur réponse et les totaux', async () => {
      await as(3);
      const p = await rpc('oncoodle_create', [{ kind: 'slots', title: 'Sondage discret', visibility: 'creator', options: slots, audience: { users: [uid(4), uid(5)] } }]);
      await as(4);
      const o = (await rpc('oncoodle_get', [p])).options;
      await rpc('oncoodle_vote', [p, [{ option_id: o[0].id, answer: 'yes' }], null]);
      await as(5);
      const g = await rpc('oncoodle_get', [p]);
      assert.deepEqual(g.invitees, []);
      assert.equal(g.options[0].yes, 1);
      assert.equal(g.me.responded, false);
      await as(3);
      assert.equal((await rpc('oncoodle_get', [p])).invitees.length, 3);
      await rpc('oncoodle_delete', [p]);
    });

    await t.test('échéance : réponses closes une fois dépassée', async () => {
      await as(3);
      const p = await rpc('oncoodle_create', [{ kind: 'slots', title: 'Avec échéance', deadline: new Date(Date.now() + 3600e3).toISOString(), options: slots, audience: { users: [uid(4)] } }]);
      await superuser(); await db.query("update oncoodle_polls set deadline = now() - interval '1 minute' where id=$1", [p]);
      await as(4);
      const g = await rpc('oncoodle_get', [p]);
      assert.equal(g.poll.locked, true);
      await assert.rejects(rpc('oncoodle_vote', [p, [{ option_id: g.options[0].id, answer: 'yes' }], null]), /échéance est passée/);
      assert.equal((await rpc('oncoodle_list'))[0].needs_answer, false);
      await as(3); await rpc('oncoodle_delete', [p]);
    });

    await t.test('modification : réservée au créateur, avertit ceux qui ont répondu, ajoute des destinataires', async () => {
      await as(4); await assert.rejects(rpc('oncoodle_update', [poll, { title: 'Pirate' }]), /introuvable/);
      await as(3);
      await assert.rejects(rpc('oncoodle_update', [poll, { visibility: 'tous' }]), /Visibilité/);
      await assert.rejects(rpc('oncoodle_update', [poll, { remove_options: (await rpc('oncoodle_get', [poll])).options.slice(0, 2).map((o) => o.id) }]), /au moins deux créneaux/);
      const r = await rpc('oncoodle_update', [poll, { title: 'Colloque thoracique (maj)', add_options: [{ day: '2026-11-30', start: '07:30', end: '08:30' }], add_audience: { users: [uid(11)] }, set_required: [{ user_id: uid(10), required: true }] }]);
      assert.deepEqual(r, { added_invitees: 1, options_changed: true });
      const g = await rpc('oncoodle_get', [poll]);
      assert.equal(g.options.length, 4); assert.equal(g.poll.title, 'Colloque thoracique (maj)');
      assert.equal(g.invitees.find((i) => i.id === uid(10)).required, true);
      assert.deepEqual((await outbox('invite', poll)).map((x) => x.recipient).sort(), [uid(10), uid(11), uid(4), uid(5)].sort());
      assert.deepEqual((await outbox('updated', poll)).map((x) => x.recipient).sort(), [uid(4), uid(5)].sort(), 'seulement ceux qui avaient déjà répondu');
      const last = g.options[3].id;
      await rpc('oncoodle_update', [poll, { remove_options: [last], remove_users: [uid(11)] }]);
      assert.equal((await rpc('oncoodle_get', [poll])).invitees.length, 4);
      await assert.rejects(rpc('oncoodle_update', [poll, { deadline: '2020-01-01T00:00:00Z' }]), /futur/);
    });

    await t.test('clôture, rouverture, calendrier commun (direct pour la direction, proposition sinon)', async () => {
      await as(4); await assert.rejects(rpc('oncoodle_close', [poll, null, null, false]), /introuvable/);
      await as(3);
      await assert.rejects(rpc('oncoodle_close', [poll, null, null, false]), /Choisissez le créneau/);
      const g = await rpc('oncoodle_get', [poll]); const final = g.options[1].id;
      await rpc('oncoodle_close', [poll, final, 'Rendez-vous en salle 12', true]);
      assert.deepEqual((await outbox('closed', poll)).map((x) => x.recipient).sort(), [uid(10), uid(4), uid(5)].sort());
      assert.equal((await outbox('calendar_proposal', poll)).length, 1);
      await superuser(); assert.equal(await scalar("select count(*)::int from absence_calendar where label='Colloque thoracique (maj)'"), 0);
      await as(4);
      const c = await rpc('oncoodle_get', [poll]);
      assert.equal(c.poll.status, 'closed'); assert.equal(c.poll.final_option_id, final); assert.equal(c.poll.locked, true);
      await assert.rejects(rpc('oncoodle_vote', [poll, [{ option_id: final, answer: 'yes' }], null]), /plus de réponses/);
      await assert.rejects(rpc('oncoodle_remind', [poll]), /introuvable/);
      await as(3);
      await assert.rejects(rpc('oncoodle_update', [poll, { title: 'Trop tard' }]), /clos ou annulé/);
      await rpc('oncoodle_reopen', [poll]);
      assert.equal((await rpc('oncoodle_get', [poll])).poll.status, 'open');
      // Direction : insertion directe dans l'agenda commun, une seule fois
      await as(2);
      const p = await rpc('oncoodle_create', [{ kind: 'rsvp', title: 'Retraite annuelle', options: [{ day: D3 }], audience: { users: [uid(3)] } }]);
      await rpc('oncoodle_close', [p, null, null, true]);
      await superuser();
      assert.equal(await scalar("select count(*)::int from absence_calendar where kind='evenement' and label='Retraite annuelle' and start_date=$1", [D3]), 1);
      assert.equal((await outbox('calendar_proposal', p)).length, 0);
    });

    await t.test('relances : manuelle limitée à une par 12 h, jamais la nuit, annulation', async () => {
      await as(3);
      const p = await rpc('oncoodle_create', [{ kind: 'slots', title: 'Pour relance', options: slots, audience: { users: [uid(4), uid(5), uid(10)] } }]);
      const o = (await rpc('oncoodle_get', [p])).options;
      await as(4); await rpc('oncoodle_vote', [p, [{ option_id: o[0].id, answer: 'yes' }], null]);
      await as(5); await assert.rejects(rpc('oncoodle_remind', [p]), /introuvable/);
      await as(3);
      assert.equal(await rpc('oncoodle_remind', [p]), 2);
      await assert.rejects(rpc('oncoodle_remind', [p]), /moins de 12 heures/);
      assert.deepEqual((await outbox('reminder', p)).map((r) => r.recipient).sort(), [uid(10), uid(5)].sort());
      await superuser();
      const night = (await db.query("select oncoodle_next_send(timestamptz '2026-11-13 23:30:00+01') as a, oncoodle_next_send(timestamptz '2026-11-13 03:00:00+01') as b, oncoodle_next_send(timestamptz '2026-11-13 10:00:00+01') as c")).rows[0];
      assert.equal(new Date(night.a).toISOString(), '2026-11-14T07:00:00.000Z');
      assert.equal(new Date(night.b).toISOString(), '2026-11-13T07:00:00.000Z');
      assert.equal(new Date(night.c).toISOString(), '2026-11-13T09:00:00.000Z');
      await as(3);
      await rpc('oncoodle_cancel', [p, 'Reporté']);
      assert.ok((await outbox('reminder', p)).every((r) => r.skipped_at), 'les relances en attente sont abandonnées');
      assert.equal((await outbox('cancelled', p)).length, 3);
      await assert.rejects(rpc('oncoodle_cancel', [p, null]), /déjà annulé/);
      await rpc('oncoodle_delete', [p]);
      await assert.rejects(rpc('oncoodle_delete', [p]), /introuvable/);
    });

    await t.test('traitement périodique : relances automatiques une fois, avis d\'échéance, purge', async () => {
      await as(3);
      const a = await rpc('oncoodle_create', [{ kind: 'slots', title: 'Sans échéance', options: slots, audience: { users: [uid(4)] } }]);
      const b = await rpc('oncoodle_create', [{ kind: 'slots', title: 'Échéance proche', deadline: new Date(Date.now() + 36 * 3600e3).toISOString(), options: slots, audience: { users: [uid(4), uid(5)] } }]);
      const c = await rpc('oncoodle_create', [{ kind: 'slots', title: 'Échéance passée', deadline: new Date(Date.now() + 3600e3).toISOString(), options: slots, audience: { users: [uid(4)] } }]);
      const old = await rpc('oncoodle_create', [{ kind: 'slots', title: 'Ancien clos', options: slots, audience: { users: [uid(4)] } }]);
      await rpc('oncoodle_close', [old, (await rpc('oncoodle_get', [old])).options[0].id, null, false]);
      await superuser();
      await db.query("update oncoodle_polls set created_at = now() - interval '4 days' where id=$1", [a]);
      await db.query("update oncoodle_polls set deadline = now() - interval '2 minutes' where id=$1", [c]);
      await db.query("update oncoodle_polls set closed_at = now() - interval '200 days' where id=$1", [old]);
      await service();
      const r1 = await rpc('oncoodle_tick');
      assert.deepEqual(r1, { reminders: 3, deadline_notices: 1, purged: 1 });
      const r2 = await rpc('oncoodle_tick');
      assert.deepEqual(r2, { reminders: 0, deadline_notices: 0, purged: 0 }, 'une seule relance automatique et un seul avis');
      assert.deepEqual((await outbox('deadline', c)).map((x) => x.recipient), [uid(3)]);
      await superuser();
      assert.equal(await scalar('select count(*)::int from oncoodle_polls where id=$1', [old]), 0);
      assert.ok((await outbox('reminder', b)).length === 2 && (await outbox('reminder', a)).length === 1);
      await as(3); for (const x of [a, b, c]) await rpc('oncoodle_delete', [x]);
    });

    await t.test('file d\'envoi, données de message et préférences', async () => {
      await service();
      const claimed = await rpc('oncoodle_outbox_claim', [100]);
      assert.ok(claimed.length > 0 && claimed.every((r) => r.attempts === 1));
      const row = claimed.find((r) => r.kind === 'invite');
      await rpc('oncoodle_outbox_done', [row.id, 'SMTP en panne']);
      await superuser();
      assert.equal(await scalar('select attempts from oncoodle_outbox where id=$1', [row.id]), 1);
      assert.ok(new Date(await scalar('select next_attempt_at from oncoodle_outbox where id=$1', [row.id])) > new Date());
      await service();
      const d = await rpc('oncoodle_mail_data', [poll, uid(4)]);
      assert.equal(d.poll.title, 'Colloque thoracique (maj)'); assert.equal(d.options.length, 3); assert.equal(d.recipient.email, true);
      assert.equal(d.invitee.responded, true);
      assert.equal(await rpc('oncoodle_mail_data', [999999, uid(4)]), null);
      await as(4);
      assert.deepEqual(await rpc('oncoodle_set_prefs', [false]), { email: false });
      await service(); assert.equal((await rpc('oncoodle_mail_data', [poll, uid(4)])).recipient.email, false);
      await as(1); const h = await rpc('oncoodle_worker_health');
      assert.equal(h.scheduled, false); assert.ok(h.pending > 0);
      await as(3); await assert.rejects(rpc('oncoodle_worker_health'), /Accès refusé/);
    });

    await t.test('limites : 10 sondages par 24 h', async () => {
      await as(8);
      const ids = [];
      for (let i = 0; i < 10; i++) ids.push(await rpc('oncoodle_create', [{ kind: 'rsvp', title: `Sondage ${i}`, options: [{ day: D1 }], audience: { users: [uid(3)] } }]));
      await assert.rejects(rpc('oncoodle_create', [{ kind: 'rsvp', title: 'Un de trop', options: [{ day: D1 }], audience: { users: [uid(3)] } }]), /10 sondages/);
      for (const i of ids) await rpc('oncoodle_delete', [i]);
    });
  } finally {
    await db.close();
  }
});
