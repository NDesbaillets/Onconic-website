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
test('peer_rejected : objet, étape, lien À valider, aucun commentaire dans le mail',()=>{
 for(const lang of ['fr','en']) {
  const m=buildEmail({lang,kind:'peer_rejected',owner:'Alice Fictive',by:'Bob Fictif',stepLabel:'Validation de la cheffe de service',absences:[absence],validators:[],approvers:[],comment:'SECRET_COMMENTAIRE'});
  assert.match(m.subject,lang==='fr'?/^Onconic · Absence refusée : Alice Fictive$/:/Alice Fictive/);
  assert.match(m.text,/Bob Fictif/); assert.match(m.text,/Validation de la cheffe de service/); assert.match(m.text,/#todo/);
  assert.doesNotMatch(m.text+m.html+JSON.stringify(m.push),/SECRET/);
 }
 const fr=buildEmail({lang:'fr',kind:'peer_rejected',owner:'Alice Fictive',by:'Bob Fictif',stepLabel:'Étape X',absences:[absence],validators:[],approvers:[]});
 assert.match(fr.text,/Bob Fictif a refusé la demande d'absence de Alice Fictive \(Étape X\)\./);
});
test('to_opinion avec step_label : avis demandé au lieu du pré-avis de la direction',()=>{
 const a=buildEmail({lang:'fr',kind:'to_opinion',owner:'Test',stepLabel:'Avis de la cheffe de service',absences:[{...absence,change_type:null}],validators:[],approvers:[]});
 assert.match(a.subject,/Avis demandé : Avis de la cheffe de service/); assert.doesNotMatch(a.text,/pré-avis/);
 const b=buildEmail({lang:'fr',kind:'to_opinion',owner:'Test',absences:[{...absence,change_type:null}],validators:[],approvers:[]});
 assert.match(b.subject,/pré-avis/);
});
test('à valider : au plus 10 noms, puis « et n autres »',()=>{
 const noms=Array.from({length:37},(_,i)=>`Validateur ${i+1}`);
 const fr=buildEmail({lang:'fr',kind:'to_validate',owner:'Test',absences:[{...absence,change_type:null}],validators:noms,approvers:[]});
 assert.match(fr.text,/Validateur 10 et 27 autres\./); assert.doesNotMatch(fr.text,/Validateur 11\b/);
 const en=buildEmail({lang:'en',kind:'to_validate_change',owner:'Test',absences:[absence],validators:noms,approvers:[]});
 assert.match(en.text,/Validateur 10 and 27 more\./);
 const few=buildEmail({lang:'fr',kind:'to_validate',owner:'Test',absences:[{...absence,change_type:null}],validators:noms.slice(0,2),approvers:[]});
 assert.match(few.text,/Validateur 1, Validateur 2\./);
});
