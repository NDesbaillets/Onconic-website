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
test('envoi à la cheffe de service : message au demandeur, deux langues, aucun texte libre',()=>{
 for(const lang of ['fr','en']) {
  const m=buildEmail({lang,kind:'escalated',owner:'Test',stepLabel:'Validation de la cheffe de service',absences:[absence],validators:[],approvers:[],comment:'SECRET_COMMENTAIRE'});
  assert.match(m.subject,lang==='fr'?/cheffe de service/:/head of department/);
  assert.match(m.text,/#mine/); assert.doesNotMatch(m.text+m.html+JSON.stringify(m.push),/SECRET/);
 }
});
test('numéro de demande : dans l\'objet pour une seule demande, en liste « N° … » pour plusieurs, jamais sans numéro',()=>{
 const one={...absence,change_type:null,request_no:'2026-0012'};
 const two={...one,id:2,request_no:'2026-0013',start_date:'2026-12-14',end_date:'2026-12-15'};
 for(const lang of ['fr','en']) {
  const m=buildEmail({lang,kind:'to_validate',owner:'Alice Fictive',absences:[one],validators:[],approvers:[]});
  assert.match(m.subject,/^Onconic · \[2026-0012\] /);
  assert.doesNotMatch(m.text,/N° 2026-0012 :/);
  const many=buildEmail({lang,kind:'to_validate',owner:'Alice Fictive',absences:[one,two],validators:[],approvers:[]});
  assert.doesNotMatch(many.subject,/\[2026-/);
  assert.match(many.text,lang==='fr'?/N° 2026-0012 : autre du 01\.12\.2026 au 02\.12\.2026/:/No\. 2026-0012: other from 01\.12\.2026 to 02\.12\.2026/);
  assert.match(many.text,/2026-0013/); assert.match(many.html,/2026-0013/);
 }
 // sans numéro (anciens messages) : objet et lignes inchangés
 const plain=buildEmail({lang:'fr',kind:'to_validate',owner:'Alice Fictive',absences:[{...absence,change_type:null}],validators:[],approvers:[]});
 assert.match(plain.subject,/^Onconic · Alice Fictive demande une absence à valider$/);
 assert.doesNotMatch(plain.text,/N° /);
 // rappel : le numéro reste dans l'objet
 assert.match(buildEmail({lang:'fr',kind:'to_validate',owner:'A',absences:[one],validators:[],approvers:[],reminder:true}).subject,/\[2026-0012\] Rappel/);
 // aucun texte libre ajouté par le numéro
 assert.doesNotMatch(buildEmail({lang:'fr',kind:'to_validate',owner:'A',absences:[one,two],validators:[],approvers:[]}).text,/SECRET/);
 // l'e-mail du formulaire aussi
 const f1=buildFormEmail({owner:'Test',roleLabel:'Médecin',absences:[{...one,note:null}],signers:[],file:'test.pdf'},x=>x);
 assert.match(f1.subject,/\[2026-0012\]/);
 const f2=buildFormEmail({owner:'Test',roleLabel:'Médecin',absences:[{...one,note:null},{...two,note:null}],signers:[],file:'test.pdf'},x=>x);
 assert.doesNotMatch(f2.subject,/\[2026-/); assert.match(f2.text,/N° 2026-0013 : autre du 14\.12\.2026 au 15\.12\.2026/);
 // le numéro traverse la rédaction des textes libres
 assert.equal(externalAbsence(one).request_no,'2026-0012');
});
test('refus : l\'e-mail ne promet plus de suppression automatique',()=>{
 for(const lang of ['fr','en']) {
  const m=buildEmail({lang,kind:'rejected',owner:'Test',by:'Bob Fictif',absences:[{...absence,change_type:null}],validators:[],approvers:[]});
  assert.doesNotMatch(m.text,/14 jours|14 days|disparaît|disappears/);
  assert.match(m.text,lang==='fr'?/historique/:/history/);
 }
});
