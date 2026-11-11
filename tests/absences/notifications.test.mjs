import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEmail, buildFormEmail } from '../../supabase/functions/notify-absence/message.ts';
import { externalAbsence, sendSharedOnce, workerAuthorized } from '../../supabase/functions/notify-absence/delivery.ts';
const absence = {id:1,kind:'autre',start_date:'2026-12-01',end_date:'2026-12-02',note:'SECRET_FICTIF',change_type:'modify',change_kind:'vacances',change_note:'SECRET_CHANGEMENT',change_start:'2026-12-10',change_end:'2026-12-11'};
test('visa direction : ancienne et nouvelle périodes dans les deux langues, aucun texte libre',()=>{
 for(const lang of ['fr','en']) {
  const m=buildEmail({lang,kind:'to_direction',owner:'Test',absences:[absence],validators:[],approvers:[],comment:'SECRET_COMMENTAIRE'});
  assert.match(m.text,/01\.12\.2026/); assert.match(m.text,/10\.12\.2026/);
  assert.doesNotMatch(m.text+m.html+JSON.stringify(m.push),/SECRET/);
 }
});
test('redaction de toutes les notes, aucune mutation de la donnée source',()=>{
 assert.equal(externalAbsence(absence).note,null); assert.equal(externalAbsence(absence).change_note,null); assert.equal(absence.note,'SECRET_FICTIF');
});
test('échec SMTP : le deuxième message pour la boîte commune réessaie, succès dédupliqué',async()=>{
 const sent=new Set(); let attempts=0;
 await assert.rejects(sendSharedOnce(sent,'key',async()=>{attempts++;throw Error('SMTP');}));
 assert.equal(sent.size,0);
 await sendSharedOnce(sent,'key',async()=>{attempts++;});
 await sendSharedOnce(sent,'key',async()=>{attempts++;});
 assert.equal(attempts,2);
});
test('worker : jeton absent, trop court ou erroné rejeté',async()=>{
 const secret='x'.repeat(48);
 assert.equal(await workerAuthorized(null,secret),false);
 assert.equal(await workerAuthorized('short','short'),false);
 assert.equal(await workerAuthorized('y'.repeat(48),secret),false);
 assert.equal(await workerAuthorized(secret,secret),true);
});
test('formulaire rectificatif et annulation explicitement identifiés',()=>{
 for(const action of ['modified','cancelled']) {
  const m=buildFormEmail({owner:'Test',roleLabel:'Médecin',absences:[{...absence,note:null}],signers:[],file:'test.pdf',action},x=>x);
  assert.match(m.subject,action==='modified'?/Rectificatif/:/Annulation/);
 }
});
test('les motifs de refus restent dans l’application et jamais dans le mail',()=>{
 for(const kind of ['rejected','change_rejected','to_validate_change','to_opinion']) {
  const m=buildEmail({lang:'fr',kind,owner:'Test',absences:[absence],validators:[],approvers:[],comment:'SECRET_COMMENTAIRE'});
  assert.doesNotMatch(m.text+m.html+JSON.stringify(m.push),/SECRET/);
 }
});
