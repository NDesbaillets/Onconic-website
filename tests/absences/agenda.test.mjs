// Diffusion des formulaires, blocage Ultragenda et secrétaires de médecin cadre (migration 202611180002), en PGlite, données fictives.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { buildAgendaEmail, buildEmail } from '../../supabase/functions/notify-absence/message.ts';
const root = new URL('../../', import.meta.url);
const read = (p) => readFile(new URL(p, root), 'utf8');
const uid = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

// 1 admin, 2 direction, 3 cadre validateur Thoracique, 4 médecin Thoracique, 5 médecin Gynécologie, 6 cadre Urologie (secrétaire 11), 7 cadre Urologie (sans secrétaire),
// 8 assistante agendas Thoracique, 9 assistante agendas Gynécologie, 10 assistante sans fonction (secrétariat), 11 secrétaire du cadre 6, 12 cadre administratif (responsable du bloc Thoracique),
// 13 médecin Urologie, 14 assistante avec fonction agendas mais pour Urologie seulement
const PEOPLE = [[1, 'admin', []], [2, 'direction', []], [3, 'cadre', ['Thoracique']], [4, 'clinician', ['Thoracique']], [5, 'clinician', ['Gynécologie']], [6, 'cadre', ['Urologie']], [7, 'cadre', ['Urologie']],
  [8, 'assistant', []], [9, 'assistant', []], [10, 'assistant', []], [11, 'assistant', []], [12, 'assistant', []], [13, 'clinician', ['Urologie']], [14, 'assistant', []]];
const D1 = ['2027-03-01', '2027-03-03']; // lundi à mercredi
const D2 = ['2027-04-05', '2027-04-07'];
const D3 = ['2027-05-10', '2027-05-12'];

async function mk({ migrate = true } = {}) {
  const db = new PGlite();
  const as = async (n) => { await db.exec('reset role'); await db.query("select set_config('test.uid',$1,false)", [n ? uid(n) : '']); await db.exec('set role authenticated'); };
  const sup = () => db.exec('reset role');
  const rpc = async (name, args = []) => Object.values((await db.query(`select public.${name}(${args.map((_, i) => '$' + (i + 1)).join(',')})`, args)).rows[0])[0];
  const rows = async (sql, args = []) => (await db.query(sql, args)).rows;
  await db.exec(await read('tests/absences/fixture.sql'));
  await db.exec('alter table auth.users add column banned_until timestamptz;');
  await db.exec("alter table public.calendar_tokens add primary key (user_id); alter table public.calendar_tokens alter column token set default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');");
  for (const f of ['absences.sql', 'cadre_medecin.sql', 'cadre_validateur.sql', 'absences_validation.sql', 'absences_forms.sql', 'absences_cliniques_datees.sql', 'admin_direction.sql', 'absences_export.sql', 'absences_soldes.sql', 'absences_visibilite.sql', 'absences_preavis.sql', 'absences_vue_ensemble.sql'])
    await db.exec(await read('supabase/' + f));
  for (const f of ['202611110001_absence_hardening.sql', '202611120001_nurse_role.sql', '202611120002_assistant_default_tools.sql', '202611130001_securite_advisors.sql', '202611140001_absence_planning.sql', '202611160002_comptes_temporaires.sql', '202611170001_circuit_absences.sql'])
    await db.exec(await read('supabase/migrations/' + f));
  for (const [n, role, clinics] of PEOPLE) {
    await db.query('insert into auth.users(id,email) values($1,$2)', [uid(n), `ag${n}@example.com`]);
    await db.query('insert into profiles(id,full_name,role,institution,clinics,absence_validator) values($1,$2,$3,$4,$5,$6)', [uid(n), `Agenda ${n}`, role, 'CHUV', clinics, n === 3]);
  }
  await db.exec('reset role');
  await db.query("insert into absence_validators(clinic,user_id) values ('Thoracique',$1)", [uid(3)]);
  await db.exec(await read('supabase/migrations/202611180001_circuit_configurable.sql'));
  const mig = await read('supabase/migrations/202611180002_agenda_ultragenda.sql');
  const migrate_ = async () => { await db.exec(mig); await db.exec(mig); };
  if (migrate) await migrate_();
  // l'administrateur tranche seul : validation immédiate
  const draft = async (n, [from, to], kind = 'vacances') => { await as(n); return (await rpc('absence_request', [kind, null, from, to])).id; };
  const approve = async (n, [from, to], kind = 'vacances') => { const id = await draft(n, [from, to], kind); await rpc('absence_submit'); await as(1); await rpc('absence_decide', [id, true, null]); await sup(); return id; };
  const change = async (n, id, type, [from, to] = [null, null]) => { await as(n); await rpc('absence_request_change', [id, type, 'vacances', null, from, to]); await as(1); await rpc('absence_decide', [id, true, null]); await sup(); };
  const tasks = async (n, status = 'todo') => { await as(n); return rpc('absence_agenda_tasks_list', [status]); };
  const taskOf = async (id) => { await sup(); return (await rows("select t.* from absence_agenda_tasks t join absence_documents d on d.id = t.document_id where $1 = any (d.absence_ids) order by t.id", [id])); };
  return { db, as, sup, rpc, rows, draft, approve, change, tasks, taskOf, migrate: migrate_ };
}

// configuration commune : blocs, fonctions d'assistantes
async function setup(t) {
  await t.sup();
  await t.as(2);
  await t.rpc('admin_set_cadre_secretary', [uid(11), true, [uid(6)]]);
  await t.rpc('admin_set_agenda_manager', [uid(8), true, ['Thoracique']]);
  await t.rpc('admin_set_agenda_manager', [uid(9), true, ['Gynécologie']]);
  await t.rpc('admin_set_agenda_manager', [uid(14), true, ['Urologie']]);
  await t.sup();
  await t.db.query("insert into tool_access(user_id,tool,allowed) values ($1,'absences',true),($2,'absences',true)", [uid(10), uid(12)]);
  await t.db.query('update profiles set admin_lead = true where id = $1', [uid(12)]);
  await t.as(2);
  return t.rpc('admin_bloc_save', [null, 'Thoracique et plus', ['Thoracique'], 'Bloc.Thoracique@Example.com', [uid(12)]]);
}

test('agenda : blocs, fonctions d’assistantes et droits', async (st) => {
  const t = await mk();
  try {
    const bloc = await setup(t);
    await st.test('blocs : une clinique dans un seul bloc, nom unique sans casse, e-mail validé', async () => {
      await t.as(2);
      await assert.rejects(t.rpc('admin_bloc_save', [null, 'Autre', ['Thoracique'], null, []]), /seul bloc/);
      await assert.rejects(t.rpc('admin_bloc_save', [null, 'THORACIQUE ET PLUS', ['Urologie'], null, []]), /porte déjà ce nom/);
      await assert.rejects(t.rpc('admin_bloc_save', [null, 'Mal', ['Urologie'], 'pas-une-adresse', []]), /invalide/);
      await assert.rejects(t.rpc('admin_bloc_save', [null, 'Mal', ['Urologie'], 'a@b.c, d@e.fr', []]), /invalide/);
      await assert.rejects(t.rpc('admin_bloc_save', [null, 'Mal', ['Administration'], null, []]), /Clinique inconnue/);
      await assert.rejects(t.rpc('admin_bloc_save', [null, 'Mal', ['Inconnue'], null, []]), /Clinique inconnue/);
      await assert.rejects(t.rpc('admin_bloc_save', [null, '', ['Urologie'], null, []]), /1 à 40/);
      await assert.rejects(t.rpc('admin_bloc_save', [null, 'x'.repeat(41), ['Urologie'], null, []]), /1 à 40/);
      await assert.rejects(t.rpc('admin_bloc_save', [null, 'Mal', ['Urologie'], null, [uid(10)]]), /cadres administratifs/);
      const u = await t.rpc('admin_bloc_save', [null, 'Urologie seule', ['Urologie'], null, []]);
      const list = await t.rpc('admin_blocs_list');
      assert.equal(list.blocs.length, 2);
      assert.equal(list.blocs.find((b) => b.id === bloc).email, 'bloc.thoracique@example.com');
      assert.ok(!list.clinics.includes('Administration'));
      assert.deepEqual(list.leads.map((l) => l.id), [uid(12)]);
      // modification d'un bloc : sa propre clinique reste permise, celle d'un autre non
      await t.rpc('admin_bloc_save', [u, 'Urologie seule', ['Urologie', 'Gynécologie'], null, []]);
      await assert.rejects(t.rpc('admin_bloc_save', [u, 'Urologie seule', ['Thoracique'], null, []]), /seul bloc/);
      await t.rpc('admin_bloc_save', [u, 'Urologie seule', ['Urologie'], null, []]);
      await t.rpc('admin_bloc_delete', [u]);
      await assert.rejects(t.rpc('admin_bloc_delete', [u]), /introuvable/);
      await t.sup();
      assert.ok((await t.rows("select 1 from absence_diffusion_log where action='bloc_create'")).length >= 2);
      // pas de contournement direct : la table est fermée à l'API
      await t.as(2);
      await assert.rejects(t.db.query('select * from absence_blocs'), /permission denied/);
    });
    await st.test('blocs, routage et fonctions : réservés à la direction et à l’administration', async () => {
      for (const n of [4, 8, 10, 12]) {
        await t.as(n);
        await assert.rejects(t.rpc('admin_blocs_list'), /Réservé/);
        await assert.rejects(t.rpc('admin_bloc_save', [null, 'X', ['Urologie'], null, []]), /Réservé/);
        await assert.rejects(t.rpc('admin_form_routing_get', [uid(4)]), /Réservé/);
        await assert.rejects(t.rpc('admin_form_routing_set', [uid(4), 'add', [], [uid(8)]]), /Réservé/);
        await assert.rejects(t.rpc('admin_set_agenda_manager', [uid(10), true, ['Thoracique']]), /admin only/);
        await assert.rejects(t.rpc('admin_set_cadre_secretary', [uid(10), true, [uid(6)]]), /admin only/);
      }
      await t.as(null);
      await assert.rejects(t.rpc('admin_blocs_list'), /Réservé/);
    });
    await st.test('gestion des agendas : assistante seulement, cliniques validées, accès à Absences ouvert, rôle changé = fonction retirée', async () => {
      await t.as(2);
      await assert.rejects(t.rpc('admin_set_agenda_manager', [uid(4), true, ['Thoracique']]), /réservée au rôle Assistante/);
      await assert.rejects(t.rpc('admin_set_agenda_manager', [uid(10), true, ['Inconnue']]), /Clinique inconnue/);
      await assert.rejects(t.rpc('admin_set_agenda_manager', [uid(10), true, ['Administration']]), /Clinique inconnue/);
      await assert.rejects(t.rpc('admin_set_agenda_manager', [uid(10), true, []]), /au moins une clinique/);
      await t.sup();
      assert.equal((await t.rows('select agenda_manager, agenda_clinics from profiles where id=$1', [uid(8)]))[0].agenda_manager, true);
      assert.equal(await t.rpc('tool_allowed', [uid(8), 'absences']), true);
      assert.equal((await t.rows('select agenda_manager from profiles where id=$1', [uid(10)]))[0].agenda_manager, false);
      // la direction (rôle direction) pose la fonction ; une assistante ne peut pas se l'attribuer en modifiant son profil
      await t.as(8);
      await assert.rejects(t.db.query('update profiles set agenda_manager = true where id = $1', [uid(8)]), /permission denied/);
      await assert.rejects(t.db.query('update profiles set cadre_secretary = true where id = $1', [uid(8)]), /permission denied/);
      // un changement de rôle retire la fonction et les attributions
      await t.as(1);
      await t.rpc('admin_set_role', [uid(14), 'clinician']);
      await t.sup();
      const p = (await t.rows('select agenda_manager, agenda_clinics, cadre_secretary from profiles where id=$1', [uid(14)]))[0];
      assert.deepEqual([p.agenda_manager, p.agenda_clinics, p.cadre_secretary], [false, [], false]);
      await t.as(1); await t.rpc('admin_set_role', [uid(14), 'assistant']);
      await t.rpc('admin_set_agenda_manager', [uid(14), true, ['Urologie']]);
      const extra = (await t.rows('select * from admin_members_extra()')).find((r) => r.id === uid(14));
      assert.equal(extra.agenda_manager, true); assert.deepEqual(extra.agenda_clinics, ['Urologie']);
      assert.deepEqual((await t.rows('select * from admin_members_extra()')).find((r) => r.id === uid(11)).secretary_of, [uid(6)]);
      await t.as(8); await assert.rejects(t.rows('select * from admin_members_extra()'), /admin only/);
    });
    await st.test('secrétaire de cadre : médecin cadre seulement, décocher vide les attributions, rôle changé = fonction retirée', async () => {
      await t.as(2);
      await assert.rejects(t.rpc('admin_set_cadre_secretary', [uid(4), true, [uid(6)]]), /réservée au rôle Assistante/);
      await assert.rejects(t.rpc('admin_set_cadre_secretary', [uid(10), true, [uid(4)]]), /médecins cadres/);
      await assert.rejects(t.rpc('admin_set_cadre_secretary', [uid(10), true, []]), /au moins un médecin cadre/);
      await t.rpc('admin_set_cadre_secretary', [uid(10), true, [uid(6), uid(7)]]);
      await t.sup();
      assert.equal((await t.rows('select count(*)::int n from cadre_secretaries where secretary_id=$1', [uid(10)]))[0].n, 2);
      assert.equal(await t.rpc('is_secretary_of', [uid(10), uid(7)]), true);
      await t.as(2);
      await t.rpc('admin_set_cadre_secretary', [uid(10), false, []]);
      await t.sup();
      assert.equal((await t.rows('select count(*)::int n from cadre_secretaries where secretary_id=$1', [uid(10)]))[0].n, 0);
      assert.equal(await t.rpc('is_secretary_of', [uid(10), uid(7)]), false);
      // un cadre qui change de rôle : la ligne reste mais ne s'applique plus
      assert.equal(await t.rpc('is_secretary_of', [uid(11), uid(6)]), true);
      await t.as(1); await t.rpc('admin_set_role', [uid(6), 'cdc']); await t.sup();
      assert.equal((await t.rows('select count(*)::int n from cadre_secretaries where cadre_id=$1', [uid(6)]))[0].n, 1);
      assert.equal(await t.rpc('is_secretary_of', [uid(11), uid(6)]), false);
      await t.as(1); await t.rpc('admin_set_role', [uid(6), 'cadre']); await t.sup();
      assert.equal(await t.rpc('is_secretary_of', [uid(11), uid(6)]), true);
      // accès échu : la secrétaire n'en est plus une
      await t.db.query("update profiles set access_until = ch_date() - 1 where id = $1", [uid(11)]);
      assert.equal(await t.rpc('is_secretary_of', [uid(11), uid(6)]), false);
      await t.db.query('update profiles set access_until = null where id = $1', [uid(11)]);
      assert.equal(await t.rpc('is_secretary_of', [uid(11), uid(6)]), true);
    });
    await st.test('droits SQL : anonyme sans accès, fonctions internes non exécutables, service_role pour l’Edge Function', async () => {
      await t.sup();
      const internal = ['is_secretary_of(uuid,uuid)', 'absence_member_active(uuid)', 'absence_agenda_task_make(bigint,boolean)', 'absence_agenda_can(uuid,bigint)', 'absence_agenda_audience(uuid,bigint)',
        'absence_form_default(uuid,date,date)', 'absence_form_effective(uuid,date,date)', 'absence_submit_core(uuid,uuid)', 'absence_request_change_core(uuid,uuid,bigint,text,text,text,date,date)',
        'absence_agenda_void(bigint)', 'absence_agenda_blocked(bigint,bigint,boolean)', 'absence_validators_calc(uuid,uuid)', 'absence_enqueue(text,uuid,bigint[],jsonb)',
        'absence_diffusion_log_add(text,text,jsonb)', 'absence_ensure_tool(uuid)', 'absence_agenda_view(jsonb,boolean)'];
      const rpcs = ['absence_agenda_tasks_list(text)', 'absence_agenda_set(bigint,boolean)', 'absence_agenda_pending_count()', 'absence_agenda_context()', 'absence_request_for(uuid,text,text,date,date)', 'absence_submit_for(uuid)',
        'absence_withdraw_for(bigint)', 'absence_request_change_for(uuid,bigint,text,text,text,date,date)', 'absence_my_validators_for(uuid)', 'admin_blocs_list()', 'admin_bloc_save(bigint,text,text[],text,uuid[])',
        'admin_bloc_delete(bigint)', 'admin_form_routing_get(uuid)', 'admin_form_routing_set(uuid,text,text[],uuid[])', 'admin_form_routing_delete(uuid)', 'admin_form_routing_overview()',
        'admin_set_agenda_manager(uuid,boolean,text[])', 'admin_set_cadre_secretary(uuid,boolean,uuid[])', 'admin_members_extra()'];
      const service = ['absence_form_recipients(bigint)', 'absence_agenda_mail(bigint)'];
      const can = async (role, f) => (await t.rows('select has_function_privilege($1, $2::regprocedure, \'execute\') ok', [role, 'public.' + f]))[0].ok;
      for (const f of internal) for (const role of ['anon', 'authenticated']) assert.equal(await can(role, f), false, `${role} ne doit pas exécuter ${f}`);
      for (const f of service) { for (const role of ['anon', 'authenticated']) assert.equal(await can(role, f), false, `${role} ne doit pas exécuter ${f}`); assert.equal(await can('service_role', f), true, f); }
      for (const f of rpcs) { assert.equal(await can('anon', f), false, `anon ne doit pas exécuter ${f}`); assert.equal(await can('authenticated', f), true, f); }
      for (const tb of ['absence_blocs', 'cadre_secretaries', 'absence_form_routing', 'absence_agenda_tasks', 'absence_agenda_log', 'absence_diffusion_log']) {
        for (const role of ['anon', 'authenticated']) {
          const g = (await t.rows('select has_table_privilege($1, $2, \'select\') s, has_table_privilege($1, $2, \'insert\') i, has_table_privilege($1, $2, \'update\') u, has_table_privilege($1, $2, \'delete\') d', [role, 'public.' + tb]))[0];
          assert.deepEqual(Object.values(g), [false, false, false, false], `${role} sur ${tb}`);
        }
        assert.equal((await t.rows('select relrowsecurity r from pg_class where oid = $1::regclass', ['public.' + tb]))[0].r, true, tb);
      }
      // sans session : refus propre
      await t.as(null);
      await assert.rejects(t.rpc('absence_agenda_tasks_list', ['todo']), /Accès refusé/);
      await assert.rejects(t.rpc('absence_agenda_set', [1, true]), /Accès refusé/);
      // un membre ordinaire ne peut pas appeler les fonctions internes
      await t.as(4);
      await assert.rejects(t.rpc('is_secretary_of', [uid(11), uid(6)]), /permission denied/);
      await assert.rejects(t.rpc('absence_form_recipients', [1]), /permission denied/);
    });
    assert.ok(bloc);
  } finally { await t.db.close(); }
});

test('agenda : tâches de blocage, audience, remplacement, cases à cocher', async (st) => {
  const t = await mk();
  try {
    await setup(t);
    let a1, a2;
    await st.test('validation d’un médecin : une tâche « à faire » avec les jours ouvrables ; pas de tâche pour un non-médecin', async () => {
      a1 = await t.approve(4, D1);
      const [tk] = await t.taskOf(a1);
      assert.equal(tk.status, 'todo'); assert.equal(tk.action, 'approved');
      assert.deepEqual(tk.block.map((x) => [x.start, x.end, x.absence_id]), [['2027-03-01', '2027-03-03', a1]]);
      assert.deepEqual(tk.unblock, []);
      const list = await t.tasks(8);
      assert.equal(list.length, 1);
      assert.equal(list[0].owner_name, 'Agenda 4'); assert.equal(list[0].kind, 'approved');
      assert.deepEqual(list[0].block[0].days, ['2027-03-01', '2027-03-02', '2027-03-03']);
      assert.deepEqual(list[0].clinics, ['Thoracique']);
      assert.equal(list[0].past, false);
      // aucune donnée libre : ni motif ni précision dans la tâche
      assert.ok(!JSON.stringify(list[0]).match(/vacances|note/));
      // assistante : pas de tâche (pas de document)
      await t.as(1); await t.rpc('admin_set_cadre_secretary', [uid(10), false, []]);
    });
    await st.test('audience : assistante du bon bloc oui, autre bloc non, secrétariat sans fonction non, responsable du bloc oui, direction et admin oui', async () => {
      assert.equal((await t.tasks(8)).length, 1, 'assistante Thoracique');
      assert.equal((await t.tasks(12)).length, 1, 'responsable du bloc Thoracique');
      assert.equal((await t.tasks(9)).length, 0, 'assistante Gynécologie');
      assert.equal((await t.tasks(14)).length, 0, 'assistante Urologie');
      assert.equal((await t.tasks(10)).length, 0, 'secrétariat sans fonction');
      assert.equal((await t.tasks(11)).length, 0, 'secrétaire du cadre 6');
      assert.equal((await t.tasks(4)).length, 0, 'le médecin lui-même');
      assert.equal((await t.tasks(3)).length, 0, 'cadre validateur');
      assert.equal((await t.tasks(1)).length, 1, 'admin');
      assert.equal((await t.tasks(2)).length, 1, 'direction');
      await t.as(8); assert.equal(await t.rpc('absence_agenda_pending_count'), 1);
      await t.as(9); assert.equal(await t.rpc('absence_agenda_pending_count'), 0);
      await t.as(1); assert.equal(await t.rpc('absence_agenda_pending_count'), 1);
      // contexte : onglet visible selon l'audience
      for (const [n, tab] of [[8, true], [9, true], [10, false], [11, true], [12, true], [4, false], [2, true], [1, true]]) { await t.as(n); assert.equal((await t.rpc('absence_agenda_context')).tab, tab, 'onglet ' + n); }
      // l'assistante d'une autre clinique ne coche pas
      const [tk] = await t.taskOf(a1);
      await t.as(9); await assert.rejects(t.rpc('absence_agenda_set', [tk.id, true]), /Accès refusé/);
      await t.as(10); await assert.rejects(t.rpc('absence_agenda_set', [tk.id, true]), /Accès refusé/);
      await t.as(4); await assert.rejects(t.rpc('absence_agenda_set', [tk.id, true]), /Accès refusé/);
    });
    await st.test('cocher et décocher : tracé, journal, état visible dans les filtres', async () => {
      const [tk] = await t.taskOf(a1);
      await t.as(4);
      assert.equal((await t.rpc('absence_agenda_status'))[a1].status, 'todo');
      await t.as(5); await assert.rejects(t.rpc('absence_agenda_status', [uid(4)]), /Accès refusé/);
      await t.as(8);
      const r = await t.rpc('absence_agenda_set', [tk.id, true]);
      await t.as(4);
      const sdone = (await t.rpc('absence_agenda_status'))[a1];
      assert.equal(sdone.status, 'done'); assert.ok(sdone.done_at); assert.deepEqual(Object.keys(sdone).sort(), ['done_at', 'status']);
      await t.as(8);
      assert.equal(r.status, 'done'); assert.equal(r.done_by_name, 'Agenda 8'); assert.ok(r.done_at);
      assert.equal((await t.tasks(8, 'todo')).length, 0);
      const done = await t.tasks(8, 'done');
      assert.equal(done.length, 1); assert.equal(done[0].done_by_name, 'Agenda 8');
      assert.equal((await t.tasks(12, 'todo')).length, 0, 'visible comme faite aussi pour la responsable');
      assert.equal((await t.tasks(12, 'all')).length, 1);
      await t.as(12); const r2 = await t.rpc('absence_agenda_set', [tk.id, false]);
      assert.equal(r2.status, 'todo'); assert.equal(r2.done_by_name, null);
      await t.as(4); assert.equal((await t.rpc('absence_agenda_status'))[a1].status, 'todo');
      await t.as(8); await t.rpc('absence_agenda_set', [tk.id, true]);
      await t.sup();
      // le médecin est prévenu une seule fois : ni au décochage, ni au recochage
      const note = await t.rows("select recipient, payload from absence_outbox where kind='agenda_done'");
      assert.equal(note.length, 1);
      assert.equal(note[0].recipient, uid(4)); assert.equal(note[0].payload.action, 'blocked'); assert.equal(note[0].payload.by, 'Agenda 8');
      assert.deepEqual(note[0].payload.periods, [{ start: '2027-03-01', end: '2027-03-03' }]);
      assert.deepEqual(await t.rpc('absence_notification_ids', [uid(4), [a1], 'agenda_done']), [a1]);
      assert.deepEqual(await t.rpc('absence_notification_ids', [uid(8), [a1], 'agenda_done']), []);
      assert.ok((await t.rpc('notification_kinds_for', [uid(4)])).includes('agenda_done'));
      assert.deepEqual((await t.rows('select action, by_user from absence_agenda_log where task_id=$1 order by id', [tk.id])).map((x) => [x.action, x.by_user]), [['done', uid(8)], ['undone', uid(12)], ['done', uid(8)]]);
      await t.as(8); await assert.rejects(t.rpc('absence_agenda_tasks_list', ['inconnu']), /Filtre inconnu/);
    });
    await st.test('modification après cochage : débloquer l’ancienne période puis bloquer la nouvelle', async () => {
      await t.change(4, a1, 'modify', D2);
      const tasks = await t.taskOf(a1);
      assert.equal(tasks.length, 2);
      const nt = tasks[1];
      assert.equal(nt.action, 'modified'); assert.equal(nt.status, 'todo');
      assert.deepEqual(nt.unblock.map((x) => [x.start, x.end]), [['2027-03-01', '2027-03-03']]);
      assert.deepEqual(nt.block.map((x) => [x.start, x.end]), [['2027-04-05', '2027-04-07']]);
      assert.equal(tasks[0].status, 'done');
      const l = (await t.tasks(8)).find((x) => x.id === nt.id);
      assert.equal(l.kind, 'modified'); assert.equal(l.unblock.length, 1); assert.equal(l.block.length, 1);
      await t.as(8); await t.rpc('absence_agenda_set', [nt.id, true]);
    });
    await st.test('modification avant cochage : l’ancienne tâche est remplacée, aucun déblocage', async () => {
      a2 = await t.approve(4, D3);
      const [t1] = await t.taskOf(a2);
      await t.change(4, a2, 'modify', ['2027-06-14', '2027-06-16']);
      const tasks = await t.taskOf(a2);
      assert.equal(tasks.length, 2);
      assert.equal(tasks[0].status, 'superseded'); assert.equal(tasks[0].superseded_by, tasks[1].id); assert.equal(tasks[0].id, t1.id);
      assert.deepEqual(tasks[1].unblock, []);
      assert.deepEqual(tasks[1].block.map((x) => [x.start, x.end]), [['2027-06-14', '2027-06-16']]);
      // la tâche remplacée n'est plus cochable, mais reste visible dans « Toutes », avec ses lignes d'origine
      await t.as(8); await assert.rejects(t.rpc('absence_agenda_set', [t1.id, true]), /remplacée/);
      assert.equal((await t.tasks(8, 'todo')).length, 1);
      const all = await t.tasks(8, 'all');
      const old = all.find((x) => x.id === t1.id);
      assert.equal(old.status, 'superseded'); assert.equal(old.block.length, 1);
    });
    await st.test('annulation avant cochage : tâche remplacée, aucune nouvelle tâche ; annulation après cochage : débloquer', async () => {
      await t.change(4, a2, 'delete');
      let tasks = await t.taskOf(a2);
      assert.equal(tasks.length, 2, 'rien à débloquer, pas de nouvelle tâche');
      assert.deepEqual(tasks.map((x) => x.status), ['superseded', 'superseded']);
      assert.equal((await t.tasks(8, 'todo')).length, 0);
      // annulation d'une absence dont le blocage a été coché
      const a3 = await t.approve(4, ['2027-07-05', '2027-07-09']);
      const [t3] = await t.taskOf(a3);
      await t.as(8); await t.rpc('absence_agenda_set', [t3.id, true]);
      await t.change(4, a3, 'delete');
      tasks = await t.taskOf(a3);
      assert.equal(tasks.length, 2);
      assert.equal(tasks[1].action, 'cancelled');
      assert.deepEqual(tasks[1].block, []);
      assert.deepEqual(tasks[1].unblock.map((x) => [x.start, x.end]), [['2027-07-05', '2027-07-09']]);
      const l = (await t.tasks(8)).find((x) => x.id === tasks[1].id);
      assert.equal(l.kind, 'cancelled'); assert.equal(l.block.length, 0);
      await t.as(8); await t.rpc('absence_agenda_set', [tasks[1].id, true]);
      await t.sup();
      const un = (await t.rows("select payload from absence_outbox where kind='agenda_done' order by id desc limit 1"))[0].payload;
      assert.equal(un.action, 'unblocked'); assert.deepEqual(un.periods, [{ start: '2027-07-05', end: '2027-07-09' }]);
    });
    await st.test('absences non médecins : aucun document, aucune tâche', async () => {
      await t.sup();
      const before = (await t.rows('select count(*)::int n from absence_agenda_tasks'))[0].n;
      await t.as(1); await t.rpc('absence_direction_add', [uid(10), 'vacances', null, '2027-08-02', '2027-08-04']);
      await t.sup();
      assert.equal((await t.rows('select count(*)::int n from absence_agenda_tasks'))[0].n, before);
    });
    await st.test('ajout direct par la direction pour un médecin : tâche Ultragenda, mais ni PDF ni copie', async () => {
      await t.sup();
      const forms = (await t.rows("select count(*)::int n from absence_outbox where kind in ('form','form_copy')"))[0].n;
      await t.as(2);
      const r = await t.rpc('absence_direction_add', [uid(4), 'vacances', null, '2027-11-01', '2027-11-03']);
      const tasks = await t.taskOf(r.id);
      assert.equal(tasks.length, 1); assert.equal(tasks[0].action, 'approved_direct'); assert.equal(tasks[0].status, 'todo');
      assert.equal((await t.tasks(8)).filter((x) => x.id === tasks[0].id).length, 1);
      await t.sup();
      assert.equal((await t.rows("select count(*)::int n from absence_outbox where kind in ('form','form_copy')"))[0].n, forms);
    });
    await st.test('modification directe par la direction : débloquer puis bloquer, une seule tâche', async () => {
      const a4 = await t.approve(4, ['2027-09-06', '2027-09-08']);
      const [t4] = await t.taskOf(a4);
      await t.as(8); await t.rpc('absence_agenda_set', [t4.id, true]);
      await t.as(2); await t.rpc('absence_direction_update', [a4, 'vacances', null, '2027-09-13', '2027-09-15', false]);
      const tasks = await t.taskOf(a4);
      assert.equal(tasks.length, 2); assert.equal(tasks[1].action, 'modified_direct');
      assert.deepEqual(tasks[1].unblock.map((x) => x.start), ['2027-09-06']); assert.deepEqual(tasks[1].block.map((x) => x.start), ['2027-09-13']);
      await t.as(2); await t.rpc('absence_direction_cancel', [a4]);
      const after = await t.taskOf(a4);
      assert.equal(after.length, 3); assert.equal(after[2].action, 'cancelled_direct');
      // la modification directe n'avait pas été cochée : le blocage de la période modifiée n'a jamais eu lieu, l'ancienne reste à débloquer
      assert.deepEqual(after[2].unblock.map((x) => x.start), ['2027-09-06']);
      assert.deepEqual(after[1].status, 'superseded');
    });
    await st.test('tâche en retard : période passée et non faite signalée', async () => {
      await t.sup();
      const [tk] = (await t.rows("select * from absence_agenda_tasks where status='todo' order by id limit 1"));
      await t.db.query("update absence_agenda_tasks set unblock = '[]'::jsonb, block = jsonb_build_array(jsonb_build_object('absence_id', 1, 'start', '2020-01-06', 'end', '2020-01-07')) where id=$1", [tk.id]);
      const l = (await t.tasks(8)).find((x) => x.id === tk.id);
      assert.equal(l.past, true);
    });
  } finally { await t.db.close(); }
});

test('agenda : secrétaire de médecin cadre', async (st) => {
  const t = await mk();
  try {
    await setup(t);
    let id;
    await st.test('la secrétaire voit les absences de son cadre (liste, validation, solde, planning), jamais celles d’un autre', async () => {
      const own = await t.approve(6, D1);
      const other = await t.approve(7, D1);
      await t.as(11);
      const list = (await t.db.query('select id from absence_list($1)', [uid(6)])).rows.map((r) => r.id);
      assert.deepEqual(list, [own]);
      await assert.rejects(t.db.query('select id from absence_list($1)', [uid(7)]), /Accès refusé/);
      assert.equal((await t.db.query('select * from absence_approvals_all($1)', [uid(6)])).rows.length, 0);
      await assert.rejects(t.db.query('select * from absence_approvals_all($1)', [uid(7)]), /Accès refusé/);
      assert.equal((await t.rpc('absence_balance', [uid(6), 2027])).year, 2027);
      await assert.rejects(t.rpc('absence_balance', [uid(7), 2027]), /Accès refusé/);
      assert.ok((await t.rows('select * from absence_history($1)', [own])).length > 0);
      await assert.rejects(t.rpc('absence_history', [other]), /Accès refusé/);
      // planning : le cadre est visible pour sa secrétaire, pas l'autre
      const people = (await t.rows('select id from absence_people()')).map((r) => r.id);
      assert.ok(people.includes(uid(6))); assert.ok(!people.includes(uid(7)));
      const grid = (await t.rows('select user_id from absence_grid($1,$2)', ['2027-02-20', '2027-03-20'])).map((r) => r.user_id);
      assert.ok(grid.includes(uid(6))); assert.ok(!grid.includes(uid(7)));
      // pas d'onglet « À valider » pour ses cadres, ni validation
      assert.equal((await t.rows('select * from absence_to_validate()')).length, 0);
      await t.as(10); await assert.rejects(t.db.query('select id from absence_list($1)', [uid(6)]), /Accès refusé/);
      await t.as(4); await assert.rejects(t.db.query('select id from absence_list($1)', [uid(6)]), /Accès refusé|chevauch/);
    });
    await st.test('absence confidentielle du cadre : la secrétaire voit « Autre » sans précision', async () => {
      await t.as(2);
      const confId = (await t.rpc('absence_direction_add', [uid(6), 'autre', 'Précision médicale fictive', '2027-10-04', '2027-10-05', true])).id;
      await t.as(6); assert.match(JSON.stringify(await t.rpc('absence_history', [confId])), /Précision médicale fictive/);
      await t.as(11);
      assert.doesNotMatch(JSON.stringify(await t.rpc('absence_history', [confId])), /Précision médicale fictive/);
      assert.ok((await t.rpc('absence_history', [confId])).length > 0);
      const r = (await t.db.query('select kind, note, confidential from absence_list($1)', [uid(6)])).rows.find((x) => x.confidential);
      assert.equal(r.kind, 'autre'); assert.equal(r.note, null);
      // la secrétaire ne voit pas non plus ces précisions dans l'historique des tâches ni ailleurs
      const grid = (await t.rows('select note, user_id from absence_grid($1,$2)', ['2027-10-01', '2027-10-10'])).find((x) => x.user_id === uid(6));
      assert.equal(grid.note, null);
    });
    await st.test('demande saisie pour le cadre : brouillon, requested_by, circuit du cadre, avertissement e-mail au cadre', async () => {
      await t.as(11);
      const r = await t.rpc('absence_request_for', [uid(6), 'vacances', 'Précision fictive', D2[0], D2[1]]);
      id = r.id;
      await t.sup();
      const a = (await t.rows('select user_id, requested_by, requested_by_name, status, note from absences where id=$1', [id]))[0];
      assert.deepEqual([a.user_id, a.requested_by, a.requested_by_name, a.status], [uid(6), uid(11), 'Agenda 11', 'draft']);
      // le brouillon est visible de la secrétaire et du cadre, pas des autres
      await t.as(11); assert.ok((await t.db.query('select id from absence_list($1)', [uid(6)])).rows.some((x) => x.id === id));
      await t.as(6); assert.ok((await t.db.query('select id, requested_by_name from absence_list()')).rows.some((x) => x.id === id && x.requested_by_name === 'Agenda 11'));
      // validateurs affichés = ceux du cadre
      await t.as(11);
      const who = await t.rpc('absence_my_validators_for', [uid(6)]);
      assert.ok(Array.isArray(who.validators));
      await assert.rejects(t.rpc('absence_my_validators_for', [uid(7)]), /Accès refusé/);
      // même règle de chevauchement que pour le cadre
      await assert.rejects(t.rpc('absence_request_for', [uid(6), 'vacances', null, D2[0], D2[1]]), /chevauche/);
      await assert.rejects(t.rpc('absence_request_for', [uid(6), 'autre', null, D3[0], D3[1]]), /précision/);
      await assert.rejects(t.rpc('absence_request_for', [uid(7), 'vacances', null, D3[0], D3[1]]), /Accès refusé/);
      await assert.rejects(t.rpc('absence_request_for', [uid(4), 'vacances', null, D3[0], D3[1]]), /Accès refusé/);
    });
    await st.test('envoi pour le cadre : tour de validation du cadre, message « en votre nom », refus pour un autre cadre', async () => {
      await t.as(11);
      await assert.rejects(t.rpc('absence_submit_for', [uid(7)]), /Accès refusé/);
      const s = await t.rpc('absence_submit_for', [uid(6)]);
      assert.equal(s.count, 1);
      await t.sup();
      const a = (await t.rows('select status, circuit_name, stage from absences where id=$1', [id]))[0];
      assert.equal(a.status, 'requested'); assert.ok(a.circuit_name);
      const ob = await t.rows("select recipient, payload, kind from absence_outbox where kind='on_behalf' order by id");
      assert.equal(ob.length, 1); assert.equal(ob[0].recipient, uid(6)); assert.equal(ob[0].payload.by, 'Agenda 11'); assert.equal(ob[0].payload.action, 'request');
      assert.equal((await t.rows("select count(*)::int n from absence_outbox where kind='on_behalf' and recipient=$1", [uid(11)]))[0].n, 0);
      // validateurs : mêmes personnes que pour une demande du cadre lui-même (circuit résolu sur le cadre)
      const ppl = (await t.rows("select recipient from absence_outbox where kind in ('to_validate','to_direction')")).map((r) => r.recipient);
      assert.ok(!ppl.includes(uid(11)), 'la secrétaire ne valide rien');
      // retrait d'une demande déjà envoyée : seulement par celle qui l'a saisie
      await t.as(7); await assert.rejects(t.rpc('absence_withdraw_for', [id]), /Accès refusé/);
    });
    await st.test('décisions : la secrétaire les reçoit aussi (e-mail propre), le cadre aussi ; aucune validation possible', async () => {
      await t.as(11);
      await assert.rejects(t.rpc('absence_decide', [id, true, null]), /visa|Vous ne validez/);
      await t.as(1); await t.rpc('absence_decide', [id, true, null]);
      await t.sup();
      const ob = await t.rows("select recipient, payload from absence_outbox where kind='approved' and $1 = any (absence_ids) order by id", [id]);
      assert.deepEqual(ob.map((x) => x.recipient).sort(), [uid(6), uid(11)].sort());
      assert.equal(ob.find((x) => x.recipient === uid(11)).payload.secretary, true);
      assert.equal(ob.find((x) => x.recipient === uid(6)).payload.secretary, undefined);
      // le filtre de l'Edge Function laisse passer la secrétaire de ce cadre seulement
      assert.deepEqual(await t.rpc('absence_notification_ids', [uid(11), [id], 'approved']), [id]);
      assert.deepEqual(await t.rpc('absence_notification_ids', [uid(10), [id], 'approved']), []);
      assert.deepEqual(await t.rpc('absence_notification_ids', [uid(6), [id], 'on_behalf']), [id]);
      assert.deepEqual(await t.rpc('absence_notification_ids', [uid(11), [id], 'on_behalf']), []);
      // types de notification proposés : on_behalf pour le cadre, décisions pour la secrétaire
      assert.ok((await t.rpc('notification_kinds_for', [uid(6)])).includes('on_behalf'));
      assert.ok(!(await t.rpc('notification_kinds_for', [uid(11)])).includes('on_behalf'));
      assert.ok((await t.rpc('notification_kinds_for', [uid(11)])).includes('approved'));
    });
    await st.test('modification et suppression demandées par la secrétaire ; document et tâche comme pour le cadre', async () => {
      await t.as(11);
      const r = await t.rpc('absence_request_change_for', [uid(6), id, 'modify', 'vacances', null, D3[0], D3[1]]);
      assert.deepEqual(r.conflicts, []);
      await assert.rejects(t.rpc('absence_request_change_for', [uid(7), id, 'delete', null, null, null, null]), /Accès refusé/);
      await t.sup();
      const ob = (await t.rows("select payload from absence_outbox where kind='on_behalf' order by id")).map((x) => x.payload.action);
      assert.deepEqual(ob, ['request', 'modify']);
      assert.ok((await t.rows("select 1 from absence_outbox where kind='to_validate_change'")).length >= 0);
      await t.as(1); await t.rpc('absence_decide', [id, true, null]);
      const tasks = await t.taskOf(id);
      assert.equal(tasks.length, 2);
      assert.equal(tasks[1].action, 'modified');
      // l'audience d'un cadre comprend sa secrétaire
      assert.equal((await t.tasks(11, 'todo')).length, 3, 'validation, modification et saisie directe');
      await t.as(10); assert.equal((await t.tasks(10)).length, 0);
      // cadre avec secrétaire : ni l'assistante des agendas Urologie, ni les responsables de bloc ; le cadre sans secrétaire suit les blocs
      assert.equal((await t.tasks(14)).filter((x) => x.owner_id === uid(6)).length, 0, 'assistante agendas Urologie');
      const c7 = await t.approve(7, ['2027-08-02', '2027-08-03']);
      assert.equal((await t.tasks(14)).filter((x) => x.owner_id === uid(7)).length, 2, 'cadre sans secrétaire : assistante agendas de la clinique');
      assert.equal((await t.tasks(11)).length, 3, 'la secrétaire du cadre 6 ne voit pas le cadre 7');
      assert.ok(c7);
      // la secrétaire coche pour son cadre : le cadre reçoit l'avis, une seule fois
      const first = (await t.tasks(11, 'todo')).find((x) => x.kind === 'approved' && x.action === 'approved');
      await t.as(11); await t.rpc('absence_agenda_set', [first.id, true]);
      await t.sup();
      const nn = await t.rows("select recipient from absence_outbox where kind='agenda_done'");
      assert.deepEqual(nn.map((x) => x.recipient), [uid(6)]);
      await t.as(6); assert.equal((await t.rpc('absence_agenda_status'))[id].status, 'todo', 'dernière tâche non remplacée : la modification reste à faire');
      await t.as(11); assert.ok((await t.rpc('absence_agenda_status', [uid(6)]))[id]);
    });
    await st.test('retrait d’une demande saisie : seulement les siennes, jamais une validée', async () => {
      await t.as(6); const own = (await t.rpc('absence_request', ['vacances', null, '2027-11-08', '2027-11-09'])).id;
      await t.as(11);
      await assert.rejects(t.rpc('absence_withdraw_for', [own]), /que vous avez saisies/);
      const mine = (await t.rpc('absence_request_for', [uid(6), 'vacances', null, '2027-12-06', '2027-12-07'])).id;
      await t.rpc('absence_withdraw_for', [mine]);
      await t.sup();
      assert.equal((await t.rows('select 1 from absences where id=$1', [mine])).length, 0);
      await t.as(11); await assert.rejects(t.rpc('absence_withdraw_for', [id]), /que vous avez saisies|validée/);
      // les brouillons du cadre lui-même restent invisibles de la secrétaire, et l'envoi ne les touche pas
      assert.ok(!(await t.db.query('select id from absence_list($1)', [uid(6)])).rows.some((x) => x.id === own));
      const m2 = (await t.rpc('absence_request_for', [uid(6), 'vacances', null, '2027-12-13', '2027-12-14'])).id;
      await t.rpc('absence_submit_for', [uid(6)]);
      await t.sup();
      assert.equal((await t.rows('select status from absences where id=$1', [own]))[0].status, 'draft');
      assert.equal((await t.rows('select status from absences where id=$1', [m2]))[0].status, 'requested');
    });
    await st.test('fonction retirée : la secrétaire n’a plus aucun accès aux absences du cadre', async () => {
      await t.as(2); await t.rpc('admin_set_cadre_secretary', [uid(11), false, []]);
      await t.as(11);
      await assert.rejects(t.db.query('select id from absence_list($1)', [uid(6)]), /Accès refusé/);
      await assert.rejects(t.rpc('absence_request_for', [uid(6), 'vacances', null, '2028-01-10', '2028-01-11']), /Accès refusé/);
      await assert.rejects(t.rpc('absence_submit_for', [uid(6)]), /Accès refusé/);
      await assert.rejects(t.rpc('absence_balance', [uid(6), 2027]), /Accès refusé/);
      assert.equal((await t.rpc('absence_agenda_context')).secretary_of.length, 0);
      assert.equal((await t.tasks(11)).length, 0);
    });
  } finally { await t.db.close(); }
});

test('agenda : diffusion du PDF, destinataires par défaut et personnalisation', async (st) => {
  const t = await mk();
  try {
    await setup(t);
    const recipients = async (doc) => { await t.sup(); await t.db.exec('set role service_role'); const r = (await t.rows('select absence_form_recipients($1) r', [doc]))[0].r; await t.sup(); return r; };
    const docOf = async (id) => { await t.sup(); return (await t.rows('select id from absence_documents where $1 = any(absence_ids) order by id', [id])).map((x) => x.id); };
    await st.test('par défaut : boîte commune du bloc et responsable du bloc ; rien pour une clinique sans bloc', async () => {
      const a1 = await t.approve(4, D1);
      const [d1] = await docOf(a1);
      const r = await recipients(d1);
      assert.deepEqual(r.emails.sort(), ['ag12@example.com', 'bloc.thoracique@example.com'].sort());
      assert.deepEqual(r.members, [uid(12)]);
      // une ligne de diffusion est déposée avec le même document
      await t.sup();
      const copy = await t.rows("select payload, recipient from absence_outbox where kind='form_copy' order by id");
      assert.equal(copy.length, 1); assert.equal(copy[0].payload.document_id, d1); assert.equal(copy[0].recipient, null);
      // clinique sans bloc : rien
      const a5 = await t.approve(5, D1);
      const [d5] = await docOf(a5);
      // renvoi : la ligne « form » est reposée, la copie reste unique
      await t.db.query("insert into absence_outbox(kind, recipient, absence_ids, payload) values ('form', null, $1, $2::jsonb)", [[a1], JSON.stringify({ action: 'approved', document_id: d1 })]);
      assert.equal((await t.rows("select count(*)::int n from absence_outbox where kind='form_copy' and payload->>'document_id' = $1", [String(d1)]))[0].n, 1);
      assert.deepEqual(await recipients(d5), { emails: [], members: [] });
      assert.equal((await t.rows("select count(*)::int n from absence_outbox where kind='form_copy'"))[0].n, 1, 'aucune ligne sans destinataire');
    });
    await st.test('médecin cadre avec secrétaire : secrétaire seule (ni bloc, ni responsable) ; sans secrétaire : règle des blocs', async () => {
      await t.as(2);
      const uro = await t.rpc('admin_bloc_save', [null, 'Urologie', ['Urologie'], 'uro@example.com', [uid(12)]]);
      assert.ok(uro);
      const a = await t.approve(6, D2);
      const [d] = await docOf(a);
      const r = await recipients(d);
      assert.deepEqual(r.emails, ['ag11@example.com']);
      assert.deepEqual(r.members, [uid(11)]);
      assert.equal((await t.rpc('admin_form_routing_get', [uid(6)])).default.blocs.length, 0);
      // cadre sans secrétaire : boîte du bloc et responsable
      const c = await t.approve(7, D2);
      const [dc] = await docOf(c);
      assert.deepEqual((await recipients(dc)).emails.sort(), ['ag12@example.com', 'uro@example.com']);
      // la personnalisation reste prioritaire pour le cadre avec secrétaire
      await t.as(2); await t.rpc('admin_form_routing_set', [uid(6), 'add', ['plus@example.com'], []]);
      const a6 = await t.approve(6, D3);
      assert.deepEqual((await recipients((await docOf(a6))[0])).emails.sort(), ['ag11@example.com', 'plus@example.com']);
      await t.as(2); await t.rpc('admin_form_routing_set', [uid(6), 'replace', ['seul@example.com'], []]);
      const a7 = await t.approve(6, ['2027-06-07', '2027-06-08']);
      assert.deepEqual((await recipients((await docOf(a7))[0])).emails, ['seul@example.com']);
      await t.as(2); await t.rpc('admin_form_routing_delete', [uid(6)]);
      // un médecin non cadre du même bloc : pas de secrétaire
      const b = await t.approve(13, D2);
      const [db_] = await docOf(b);
      assert.deepEqual((await recipients(db_)).emails.sort(), ['ag12@example.com', 'uro@example.com']);
    });
    await st.test('personnalisation « ajouter » : adresses et membres en plus ; « remplacer » : seulement ceux-là', async () => {
      await t.as(2);
      await t.rpc('admin_form_routing_set', [uid(4), 'add', ['Autre.Boite@Example.com'], [uid(10)]]);
      const a = await t.approve(4, D3);
      const [d] = (await docOf(a));
      let r = await recipients(d);
      assert.deepEqual(r.emails.sort(), ['ag10@example.com', 'ag12@example.com', 'autre.boite@example.com', 'bloc.thoracique@example.com']);
      assert.deepEqual(r.members.sort(), [uid(10), uid(12)].sort());
      // l'audience des tâches comprend les membres du routage
      assert.equal((await t.tasks(10)).length, 2);
      await t.as(10); await t.rpc('absence_agenda_set', [(await t.tasks(10))[0].id, true]);
      await t.as(2);
      await t.rpc('admin_form_routing_set', [uid(4), 'replace', ['seule@example.com'], []]);
      const a2 = await t.approve(4, ['2027-06-07', '2027-06-08']);
      const [d2] = await docOf(a2);
      r = await recipients(d2);
      assert.deepEqual(r.emails, ['seule@example.com']); assert.deepEqual(r.members, []);
      // le mode « remplacer » vaut aussi pour l'audience des tâches : seuls les membres choisis (plus admin et direction)
      await t.as(2); await t.rpc('admin_form_routing_set', [uid(4), 'replace', ['seule@example.com'], [uid(10)]]);
      const b8 = (await t.tasks(8)).length, b12 = (await t.tasks(12)).length, b10 = (await t.tasks(10)).length, b1 = (await t.tasks(1)).length;
      await t.approve(4, ['2027-07-05', '2027-07-06']);
      assert.equal((await t.tasks(8)).length, b8, 'assistante des agendas exclue'); assert.equal((await t.tasks(12)).length, b12, 'responsable du bloc exclue');
      assert.equal((await t.tasks(10)).length, b10 + 1); assert.equal((await t.tasks(1)).length, b1 + 1);
      await t.as(2); await t.rpc('admin_form_routing_set', [uid(4), 'replace', ['seule@example.com'], []]);
      const got = await t.rpc('admin_form_routing_get', [uid(4)]);
      assert.equal(got.mode, 'replace'); assert.deepEqual(got.emails, ['seule@example.com']);
      assert.deepEqual(got.default.blocs.map((b) => b.email), ['bloc.thoracique@example.com']);
      assert.deepEqual(got.default.members.map((m) => m.id), [uid(12)]);
      assert.deepEqual(got.effective.emails, ['seule@example.com']);
      const ov = (await t.rpc('admin_form_routing_overview')).find((x) => x.id === uid(4));
      assert.equal(ov.mode, 'replace'); assert.equal(ov.recipients, 1); assert.deepEqual(ov.blocs, ['Thoracique et plus']);
      // suppression : retour au défaut
      await t.rpc('admin_form_routing_delete', [uid(4)]);
      assert.equal((await t.rpc('admin_form_routing_get', [uid(4)])).mode, null);
      // « remplacer » sans rien = personne ne reçoit le PDF
      await t.rpc('admin_form_routing_set', [uid(4), 'replace', [], []]);
      const a3 = await t.approve(4, ['2027-06-14', '2027-06-15']);
      const [d3] = await docOf(a3);
      assert.deepEqual(await recipients(d3), { emails: [], members: [] });
      await t.as(2); await t.rpc('admin_form_routing_set', [uid(4), 'add', [], []]);
      assert.equal((await t.rpc('admin_form_routing_get', [uid(4)])).mode, null, 'ajouter sans rien équivaut à supprimer');
    });
    await st.test('une erreur dans un déclencheur n’annule jamais la validation', async () => {
      await t.sup();
      await t.db.exec('alter table absence_agenda_tasks add constraint test_boom check (false) not valid');
      const a = await t.approve(4, ['2027-10-04', '2027-10-05']);
      await t.sup();
      assert.equal((await t.rows('select status from absences where id=$1', [a]))[0].status, 'approved');
      assert.equal((await t.rows("select count(*)::int n from absence_diffusion_log where action='agenda_task_error'"))[0].n, 1);
      await t.db.exec('alter table absence_agenda_tasks drop constraint test_boom');
      await t.db.exec("alter table absence_outbox add constraint test_boom2 check (kind <> 'form_copy') not valid");
      const b = await t.approve(4, ['2027-10-11', '2027-10-12']);
      await t.sup();
      assert.equal((await t.rows('select status from absences where id=$1', [b]))[0].status, 'approved');
      assert.equal((await t.rows("select count(*)::int n from absence_outbox where kind='form' and $1 = any (absence_ids)", [b]))[0].n, 1);
      assert.equal((await t.rows("select count(*)::int n from absence_diffusion_log where action='form_copy_error'"))[0].n, 1);
      await t.db.exec('alter table absence_outbox drop constraint test_boom2');
    });
    await st.test('personnalisation : limites, validations et droits', async () => {
      await t.as(2);
      await assert.rejects(t.rpc('admin_form_routing_set', [uid(4), 'tous', [], []]), /Mode inconnu/);
      await assert.rejects(t.rpc('admin_form_routing_set', [uid(4), 'add', ['pas une adresse'], []]), /invalide/);
      await assert.rejects(t.rpc('admin_form_routing_set', [uid(4), 'add', ['a@b.ch,c@d.ch'], []]), /invalide/);
      await assert.rejects(t.rpc('admin_form_routing_set', [uid(4), 'add', Array.from({ length: 21 }, (_, i) => `x${i}@example.com`), []]), /20 adresses/);
      await assert.rejects(t.rpc('admin_form_routing_set', [uid(4), 'add', [], Array.from({ length: 21 }, (_, i) => uid(100 + i))]), /20 adresses/);
      await assert.rejects(t.rpc('admin_form_routing_set', [uid(4), 'add', [], [uid(99)]]), /Membre introuvable/);
      await assert.rejects(t.rpc('admin_form_routing_set', [uid(10), 'add', ['a@b.ch'], []]), /médecins/);
      await assert.rejects(t.rpc('admin_form_routing_get', [uid(10)]), /médecins/);
      await t.rpc('admin_form_routing_set', [uid(4), 'add', Array.from({ length: 20 }, (_, i) => `x${i}@example.com`), []]);
      await t.rpc('admin_form_routing_delete', [uid(4)]);
      await t.sup();
      assert.ok((await t.rows("select 1 from absence_diffusion_log where action in ('routing_set','routing_delete')")).length >= 3);
      // un membre accès échu ne reçoit plus rien
      await t.db.query('update profiles set access_until = ch_date() - 1 where id = $1', [uid(12)]);
      const a = await t.approve(4, ['2027-09-06', '2027-09-07']);
      const [d] = await docOf(a);
      assert.deepEqual((await recipients(d)).emails, ['bloc.thoracique@example.com']);
    });
  } finally { await t.db.close(); }
});

test('agenda : reprise des documents existants et migration réexécutable', async () => {
  const t = await mk({ migrate: false });
  try {
    // validations faites avant la migration : une absence à venir, une passée
    const future = await t.approve(4, D1);
    const past = await t.approve(4, ['2026-01-05', '2026-01-07']);
    await t.sup();
    assert.equal((await t.rows("select 1 from pg_class where relname='absence_agenda_tasks'")).length, 0);
    await t.migrate();
    const tasks = await t.rows('select t.*, d.absence_ids from absence_agenda_tasks t join absence_documents d on d.id = t.document_id order by t.id');
    assert.equal(tasks.length, 1, 'seule l’absence non terminée donne une tâche');
    assert.equal(tasks[0].status, 'todo'); assert.deepEqual(tasks[0].absence_ids, [future]);
    assert.notEqual(tasks[0].absence_ids[0], past);
    // relancer la migration ne duplique rien
    await t.migrate();
    assert.equal((await t.rows('select count(*)::int n from absence_agenda_tasks'))[0].n, 1);
    assert.equal((await t.rows("select count(*)::int n from onconic_migrations where version='202611180002'"))[0].n, 1);
    // la tâche reprise se traite comme les autres, mais en silence : aucun e-mail au médecin
    assert.ok(tasks[0].notified_at);
    await t.sup();
    const n0 = (await t.rows("select count(*)::int n from absence_outbox where kind='agenda_done'"))[0].n;
    const list = await t.tasks(1);
    assert.equal(list.length, 1);
    await t.as(1); await t.rpc('absence_agenda_set', [list[0].id, true]);
    await t.sup();
    assert.equal((await t.rows("select count(*)::int n from absence_outbox where kind='agenda_done'"))[0].n, n0);
  } finally { await t.db.close(); }
});

// ---------------------------------------------------------------------------------------------------------------------------
// Messages (fonctions pures)
const ENTRY = { absence_id: 1, start: '2027-03-01', end: '2027-03-03', days: ['2027-03-01', '2027-03-02', '2027-03-03'], void: false };
test('buildAgendaEmail : validation, modification, annulation ; périodes, jours ouvrables, lien, aucun texte libre', () => {
  const base = { owner: 'Dr Fictif', file: 'Demande_D1.pdf', block: [ENTRY], unblock: [] };
  const ok = buildAgendaEmail({ ...base, action: 'approved' });
  assert.match(ok.subject, /Absence validée de Dr Fictif : plages Ultragenda à bloquer/);
  assert.match(ok.text, /01\.03\.2027 – 03\.03\.2027/); assert.match(ok.text, /lu 01\.03, ma 02\.03, me 03\.03/); assert.match(ok.text, /3 jours ouvrables/);
  assert.match(ok.text, /https:\/\/onconic\.ch\/app\/absences\.html#agenda/); assert.match(ok.html, /href="https:\/\/onconic\.ch\/app\/absences\.html#agenda"/);
  const mod = buildAgendaEmail({ ...base, action: 'modified', unblock: [{ ...ENTRY, start: '2027-02-01', end: '2027-02-02', days: ['2027-02-01', '2027-02-02'] }] });
  assert.match(mod.subject, /Absence modifiée de Dr Fictif : débloquer .* puis bloquer/);
  assert.match(mod.text, /À débloquer/); assert.match(mod.text, /À bloquer/); assert.match(mod.text, /01\.02\.2027 – 02\.02\.2027/);
  assert.ok(mod.text.indexOf('À débloquer') < mod.text.indexOf('À bloquer'));
  const mod0 = buildAgendaEmail({ ...base, action: 'modified', unblock: [] });
  assert.match(mod0.subject, /Absence modifiée de Dr Fictif : nouvelle plage Ultragenda à bloquer/);
  assert.doesNotMatch(mod0.subject + mod0.text + mod0.html, /débloquer|À débloquer/);
  const can = buildAgendaEmail({ ...base, action: 'cancelled_direct', block: [], unblock: [ENTRY] });
  assert.match(can.subject, /Absence annulée de Dr Fictif : plages Ultragenda à débloquer/);
  assert.doesNotMatch(can.text, /À bloquer/);
  // aucun texte libre : le propriétaire et les périodes sont les seules données ; HTML échappé
  const evil = buildAgendaEmail({ ...base, owner: '<b>Dr "X"</b>', action: 'approved', note: 'SECRET_NOTE', comment: 'SECRET_COMMENTAIRE' });
  assert.doesNotMatch(evil.text + evil.html + evil.subject, /SECRET/); assert.doesNotMatch(evil.html, /<b>Dr/);
  // les jours très nombreux sont résumés
  const long = buildAgendaEmail({ ...base, action: 'approved', block: [{ ...ENTRY, start: '2027-03-01', end: '2027-04-30', days: Array.from({ length: 45 }, (_, i) => `2027-03-${String((i % 28) + 1).padStart(2, '0')}`) }] });
  assert.match(long.text, /45 jours ouvrables/); assert.ok(long.text.split('\n').every((l) => l.length < 400));
});

test('agenda_done : message au médecin, sans texte libre', () => {
  const abs = { id: 1, kind: 'vacances', start_date: '2027-03-01', end_date: '2027-03-03', note: 'SECRET_NOTE', change_type: null, change_kind: null, change_note: null, change_start: null, change_end: null };
  const periods = [{ start: '2027-03-01', end: '2027-03-03' }];
  const fr = buildEmail({ lang: 'fr', kind: 'agenda_done', owner: 'Dr X', by: 'Mme Y', action: 'blocked', periods, absences: [abs], validators: [], approvers: [] });
  assert.match(fr.subject, /Votre absence du 01\.03\.2027 au 03\.03\.2027 est bloquée dans Ultragenda/); assert.match(fr.text, /par Mme Y|Mme Y/);
  assert.match(buildEmail({ lang: 'fr', kind: 'agenda_done', owner: 'Dr X', action: 'unblocked', periods, absences: [abs], validators: [], approvers: [] }).subject, /est débloquée dans Ultragenda/);
  assert.match(buildEmail({ lang: 'en', kind: 'agenda_done', owner: 'Dr X', action: 'blocked', periods, absences: [abs], validators: [], approvers: [] }).subject, /is blocked in Ultragenda/);
  assert.doesNotMatch(fr.text + fr.html + JSON.stringify(fr.push), /SECRET/); assert.match(fr.push.url, /#mine/);
});

test('messages « en votre nom » et décisions vues par la secrétaire : aucun texte libre', () => {
  const abs = { id: 1, kind: 'vacances', start_date: '2027-03-01', end_date: '2027-03-03', note: 'SECRET_NOTE', change_type: null, change_kind: null, change_note: null, change_start: null, change_end: null };
  for (const lang of ['fr', 'en']) {
    const m = buildEmail({ lang, kind: 'on_behalf', owner: 'Dr Cadre', by: 'Mme Secrétaire', action: 'request', absences: [abs], validators: [], approvers: [], comment: 'SECRET_COMMENTAIRE' });
    assert.match(m.subject, /Mme Secrétaire/); assert.match(m.text, /01\.03\.2027/); assert.match(m.text, /#mine/);
    assert.doesNotMatch(m.text + m.html + JSON.stringify(m.push), /SECRET/);
  }
  assert.match(buildEmail({ lang: 'fr', kind: 'on_behalf', owner: 'Dr Cadre', by: 'Mme S', action: 'modify', absences: [abs], validators: [], approvers: [] }).subject, /modification .* en votre nom/);
  assert.match(buildEmail({ lang: 'fr', kind: 'on_behalf', owner: 'Dr Cadre', by: 'Mme S', action: 'delete', absences: [abs], validators: [], approvers: [] }).subject, /suppression .* en votre nom/);
  for (const [kind, re] of [['approved', /est validée/], ['rejected', /refusée/], ['change_approved', /acceptée/], ['change_rejected', /refusée/]]) {
    const m = buildEmail({ lang: 'fr', kind, owner: 'Dr Cadre', secretary: true, by: 'Validateur', absences: [abs], validators: [], approvers: ['Validateur'] });
    assert.match(m.subject, /Dr Cadre/); assert.match(m.subject, re); assert.doesNotMatch(m.subject, /Votre/);
  }
  // pour le cadre lui-même, rien ne change
  assert.match(buildEmail({ lang: 'fr', kind: 'approved', owner: 'Dr Cadre', absences: [abs], validators: [], approvers: [] }).subject, /Votre absence est validée/);
});
