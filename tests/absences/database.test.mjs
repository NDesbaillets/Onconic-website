import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
const root=new URL('../../',import.meta.url);
const read=(p)=>readFile(new URL(p,root),'utf8');
const uid=(n)=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
const migration='supabase/migrations/202611110001_absence_hardening.sql';
test('PostgreSQL : migrations, permissions et parcours complets',async(t)=>{
 const db=new PGlite();
 const superuser=()=>db.exec('reset role');
 const as=async(n)=>{await superuser();await db.query("select set_config('test.uid',$1,false)",[n?uid(n):'']);await db.exec('set role authenticated');};
 const scalar=async(sql,args=[])=>Object.values((await db.query(sql,args)).rows[0])[0];
 const rpc=async(name,args=[])=>{
 const setof=['absence_list','absence_outbox_claim'].includes(name);
 const call=`public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')})`;
 const result=await db.query(setof ? `select to_jsonb(r) as data from ${call} r` : `select ${call}`,args);
 return setof ? result.rows.map(r=>r.data) : Object.values(result.rows[0])[0];
 };
 try {
  await db.exec(await read('tests/absences/fixture.sql'));
  for(const f of ['absences.sql','cadre_medecin.sql','cadre_validateur.sql','absences_validation.sql','absences_forms.sql','absences_cliniques_datees.sql','admin_direction.sql','absences_export.sql','absences_soldes.sql','absences_visibilite.sql','absences_preavis.sql','absences_vue_ensemble.sql']) {
   try {await db.exec(await read('supabase/'+f));} catch(e){throw Error(`${f}: ${e.message} ${e.where||''}`);}
  }
  // Horloge déterministe et données entièrement fictives.
  await db.exec("create or replace function ch_today() returns date language sql stable as $$ select date '2026-11-11' $$;");
  for(const [n,role,clinics] of [[1,'admin',[]],[2,'direction',[]],[3,'clinician',[]],[4,'clinician',['Thoracique']],[5,'cadre',['Thoracique']],[6,'cadre',['Urologie']],[7,'clinician',['Urologie']],[8,'clinician',[]],[9,'cadre',['Thoracique']],[10,'clinician',[]]]) {
   await db.query('insert into auth.users(id,email) values($1,$2)',[uid(n),`test${n}@example.invalid`]);
   await db.query('insert into profiles(id,full_name,role,clinics,absence_validator) values($1,$2,$3,$4,$5)',[uid(n),`Test ${n}`,role,clinics,role==='cadre']);
  }
  // Reproduire les permissions de profils usuelles ; le durcissement doit aussi retirer un éventuel grant large.
  await db.exec('grant select,update on profiles to authenticated;');
  await db.exec(await read(migration));
  await t.test('droits de profils : colonnes de réglages conservées, affectations et rôle verrouillés',async()=>{
   for(const c of ['first_name','last_name','username','full_name','phone','lang','show_in_events','contactable','notify_events'])
    assert.equal(await scalar("select has_column_privilege('authenticated','public.profiles',$1,'UPDATE')",[c]),true,c);
   for(const c of ['clinics','clinics_initialized','role','cdc_clinics','absence_validator','institution'])
    assert.equal(await scalar("select has_column_privilege('authenticated','public.profiles',$1,'UPDATE')",[c]),false,c);
   assert.equal(await scalar("select has_column_privilege('anon','public.profiles','first_name','UPDATE')"),false);
  });
  await as(1); await rpc('admin_set_absence_validators',['Thoracique',[uid(5)]]); await rpc('admin_set_absence_validators',['Urologie',[uid(6)]]);
  await t.test('sélection initiale immédiate, changements soumis, refus et acceptation',async()=>{
   await as(3); assert.equal((await rpc('my_clinics')).initial,true);
   await rpc('my_set_clinics',[['Thoracique']]); assert.deepEqual((await rpc('my_clinics')).clinics,['Thoracique']);
   await rpc('my_set_clinics',[['Urologie']]); let m=await rpc('my_clinics');
   assert.deepEqual(m.clinics,['Thoracique']); assert.deepEqual(m.pending.clinics,['Urologie']);
   await assert.rejects(rpc('admin_clinic_requests'),/Accès refusé/);
   await assert.rejects(db.query('update profiles set clinics=$1 where id=$2',[['Urologie'],uid(3)]),/permission denied/);
   await as(2); await rpc('admin_clinic_request_decide',[m.pending.id,false,'Affectation inchangée']);
   await as(3); assert.equal((await rpc('my_clinics')).last_request.status,'rejected');
   await rpc('my_set_clinics',[['Urologie']]); m=await rpc('my_clinics');
   await as(1); await rpc('admin_clinic_request_decide',[m.pending.id,true,null]);
   await as(3); assert.deepEqual((await rpc('my_clinics')).clinics,['Urologie']);
  });
  let feb,aug;
  await t.test('rotations futures : chaque cadre ne reçoit que sa partie du lot',async()=>{
   await as(1); await rpc('admin_clinic_change_save',[uid(4),'2027-07-01',['Urologie']]);
   await as(4);
   feb=(await rpc('absence_request',['vacances',null,'2027-02-01','2027-02-02'])).id;
   aug=(await rpc('absence_request',['congres','Formation fictive','2027-08-02','2027-08-03'])).id;
   await rpc('absence_submit');
   await superuser();
   const rows=(await db.query("select recipient,absence_ids from absence_outbox where kind='to_validate' order by recipient")).rows;
   assert.deepEqual(rows.find(r=>r.recipient===uid(5)).absence_ids,[feb]);
   assert.deepEqual(rows.find(r=>r.recipient===uid(6)).absence_ids,[aug]);
   assert.deepEqual(await rpc('absence_notification_ids',[uid(6),[feb,aug],'to_validate']),[aug]);
  });
  let original;
  await t.test('tous les cadres puis visa direction ; document de lot figé',async()=>{
   await as(5); await rpc('absence_decide',[feb,true,null]);
   await as(4); let a=(await rpc('absence_list')).find(a=>a.id===feb); assert.equal(a.status,'requested'); assert.equal(a.stage,2);
   await assert.rejects(rpc('absence_decide',[feb,true,null]),/visa de la direction/);
   await as(2); await rpc('absence_decide',[feb,true,null]);
   await as(6); await rpc('absence_decide',[aug,true,null]);
   await superuser();
   const queued=(await db.query("select payload from absence_outbox where kind='to_direction' order by id desc limit 1")).rows[0].payload;
   assert.equal(queued.absences.length,2,'le regroupement conserve aussi le deuxième instantané');
   assert.deepEqual(await rpc('absence_notification_ids',[uid(2),[feb,aug],'to_direction']),[aug]);
   await as(2); await rpc('absence_decide',[aug,true,null]);
   await superuser(); original=await rpc('absence_form_data',[[feb]]); assert.equal(original.absences.length,2);
   assert.ok(original.document_id); assert.equal(original.absences.find(x=>x.id===aug).note,null);
  });
  await t.test('modification conserve l’original, nouvelle chaîne, rectificatif et historique',async()=>{
   await as(4); await rpc('absence_request_change',[feb,'modify','vacances',null,'2027-02-08','2027-02-09']);
   let a=(await rpc('absence_list')).find(a=>a.id===feb); assert.equal(a.status,'approved'); assert.equal(a.start_date,'2027-02-01');
   await as(5); await rpc('absence_decide',[feb,true,null]);
   await as(2); await rpc('absence_decide',[feb,true,null]);
   await as(4); a=(await rpc('absence_list')).find(a=>a.id===feb); assert.equal(a.start_date,'2027-02-08');
   const history=await rpc('absence_history',[feb]);
   assert.ok(history.some(e=>e.entity==='absence_approvals' && e.action==='DELETE' && e.before_data.decision==='approved'));
   assert.ok(history.some(e=>e.before_data?.start_date==='2027-02-01' && e.after_data?.start_date==='2027-02-08'));
   await superuser();const latest=await rpc('absence_form_data',[[feb]]); assert.equal(latest.action,'modified');
   assert.equal((await rpc('absence_document_data',[original.document_id])).absences.find(a=>a.id===feb).start_date,'2027-02-01');
  });
  await t.test('annulation directe tracée, documents accessibles mais pas à un collègue',async()=>{
   await as(2); await rpc('absence_direction_cancel',[feb]);
   await as(4);const events=await rpc('absence_history',[feb]);
   assert.ok(events.some(e=>e.after_data?.status==='cancelled' && e.actor===uid(2)));
   const docs=await rpc('absence_document_versions',[feb]); assert.equal(docs[0].action,'cancelled_direct');
   await superuser();assert.equal(await rpc('absence_document_access',[uid(7),docs[0].id]),false);
   assert.equal(await rpc('absence_form_access',[uid(4),[aug,999999]]),false);
   await as(7);await assert.rejects(rpc('absence_history',[feb]),/Accès refusé/);
  });
  await t.test('confidentialité planning/liste/exports/documents/agenda',async()=>{
   await as(2); const c=(await rpc('absence_direction_add',[uid(4),'autre','SECRET_MEDICAL','2027-03-01','2027-03-02',true])).id;
   await as(5);assert.equal((await rpc('absence_list',[uid(4)])).find(a=>a.id===c).note,null);
   const grid=(await db.query("select * from absence_grid('2027-03-01','2027-03-02')")).rows;assert.equal(grid.find(a=>a.id===c).note,null);
   const exported=(await db.query("select * from absence_export('2027-03-01','2027-03-02')")).rows;assert.equal(exported.find(a=>a.id===c).note,null);
   await as(2); await rpc('absence_direction_update',[c,'autre','SECRET_MODIF','2027-03-03','2027-03-04',true]);
   await superuser(); const doc=await rpc('absence_form_data',[[c]]);assert.ok(!JSON.stringify(doc).includes('SECRET'));
   await db.query('insert into calendar_tokens(user_id,token) values($1,$2)',[uid(4),'fictif']);
   const feed=(await db.query("select * from absence_calendar_feed('fictif')")).rows;assert.ok(!JSON.stringify(feed).includes('SECRET'));
  });
  await t.test('boîte d’envoi : délai, échec visible et reprise réservée à la direction',async()=>{
   await superuser();await db.exec("update absence_outbox set sent_at=now(); insert into absence_outbox(kind,recipient,absence_ids) values('approved','"+uid(4)+"','{}');");
   const claimed=await rpc('absence_outbox_claim',[30]); assert.equal(claimed.length,1); const id=claimed[0].id;
   await rpc('absence_outbox_done',[id,'SMTP fictif']);assert.equal((await rpc('absence_outbox_claim',[30])).length,0);
   await db.query('update absence_outbox set attempts=5 where id=$1',[id]);
   await as(4);assert.equal((await rpc('absence_notification_status')).failed,1);await assert.rejects(rpc('absence_notification_retry',[id]),/Accès refusé/);
   await as(2);assert.equal((await rpc('absence_notification_failures')).length,1);await rpc('absence_notification_retry',[id]);
   await superuser();assert.equal((await rpc('absence_outbox_claim',[30])).length,1);
  });
  await t.test('deux cadres requis, décision répétée rejetée et refus de changement conserve l’autorisation',async()=>{
   await as(1);await rpc('admin_set_absence_validators',['Thoracique',[uid(5),uid(9)]]);
   await as(4);const id=(await rpc('absence_request',['vacances',null,'2027-04-05','2027-04-06'])).id;await rpc('absence_submit');
   await as(5);await rpc('absence_decide',[id,true,null]);
   await assert.rejects(rpc('absence_decide',[id,true,null]),/déjà donné/);
   await as(4);assert.equal((await rpc('absence_list')).find(a=>a.id===id).stage,1);
   await as(9);await rpc('absence_decide',[id,true,null]);await as(2);await rpc('absence_decide',[id,true,null]);
   await as(4);await rpc('absence_request_change',[id,'modify','vacances',null,'2027-04-12','2027-04-13']);
   await as(5);await rpc('absence_decide',[id,false,'Effectif insuffisant']);
   await as(4);const a=(await rpc('absence_list')).find(a=>a.id===id);assert.equal(a.status,'approved');assert.equal(a.start_date,'2027-04-05');assert.equal(a.change_type,null);
   await superuser();assert.equal((await rpc('absence_form_data',[[id]])).action,'approved');
  });
  await t.test('retrait, refus initial, demande de suppression et notifications obsolètes',async()=>{
   await as(8);await rpc('my_set_clinics',[['Urologie']]);
   const withdrawn=(await rpc('absence_request',['vacances',null,'2027-05-03','2027-05-04'])).id;await rpc('absence_submit');await rpc('absence_withdraw',[withdrawn]);
   await superuser();assert.deepEqual(await rpc('absence_notification_ids',[uid(6),[withdrawn],'to_validate']),[]);
   await as(8);const rejected=(await rpc('absence_request',['vacances',null,'2027-05-10','2027-05-11'])).id;await rpc('absence_submit');
   await as(6);await rpc('absence_decide',[rejected,false,'Non disponible']);
   await as(8);assert.equal((await rpc('absence_list')).find(a=>a.id===rejected).status,'rejected');await rpc('absence_delete_rejected',[rejected]);
   assert.ok((await rpc('absence_history',[rejected])).some(e=>e.action==='DELETE'));
   const id=(await rpc('absence_request',['vacances',null,'2027-06-01','2027-06-02'])).id;await rpc('absence_submit');
   await as(6);await rpc('absence_decide',[id,true,null]);await as(2);await rpc('absence_decide',[id,true,null]);
   await as(8);await rpc('absence_request_change',[id,'delete',null,null,null,null]);assert.equal((await rpc('absence_list')).find(a=>a.id===id).status,'approved');
   await as(6);await rpc('absence_decide',[id,true,null]);await as(2);await rpc('absence_decide',[id,true,null]);
   await as(8);assert.equal((await rpc('absence_list')).find(a=>a.id===id).status,'cancelled');
   await superuser();assert.equal((await rpc('absence_form_data',[[id]])).action,'cancelled');
  });
  await t.test('historique des rotations appliquées conservé',async()=>{
   await superuser();await db.query("insert into member_clinic_changes(user_id,valid_from,clinics) values($1,'2026-11-12','{Urologie}')",[uid(10)]);
   await db.exec("create or replace function ch_today() returns date language sql stable as $$ select date '2026-11-13' $$;");
   await rpc('apply_clinic_changes');
   assert.deepEqual(await rpc('member_clinics',[uid(10),'2026-11-12','2026-11-12']),['Urologie']);
   assert.deepEqual(await rpc('member_clinics',[uid(10),'2026-11-11','2026-11-11']),[]);
  });
  await t.test('migration réexécutable sans perte de versions ni permissions internes',async()=>{
   await superuser();const count=await scalar('select count(*)::int from absence_documents');await db.exec(await read(migration));
   assert.equal(await scalar('select count(*)::int from absence_documents'),count);
   assert.equal(await scalar("select has_function_privilege('authenticated','absence_document_data(bigint)','execute')"),false);
   assert.equal(await scalar("select has_function_privilege('anon','my_set_clinics(text[])','execute')"),false);
  });
 } finally {await db.close();}
});
