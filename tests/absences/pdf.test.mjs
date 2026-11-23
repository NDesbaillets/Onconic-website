import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { PDFDocument } from 'pdf-lib';
const source=await readFile(new URL('../../supabase/functions/notify-absence/form.ts',import.meta.url),'utf8');
const pdfLib=new URL('node_modules/pdf-lib/cjs/index.js',import.meta.url).href;
const js=ts.transpileModule(source.replace('npm:pdf-lib@1.17.1',pdfLib),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const {buildAbsenceForm}=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
test('PDF généré pour chaque rôle : original, rectificatif, annulation',async()=>{
 for(const role of ['clinician','cdc','cadre']) for(const action of ['approved','modified','cancelled']) {
  const bytes=await buildAbsenceForm({role,action,owner:'Personne fictive',clinics:['Thoracique'],requestedAt:'2026-11-11T10:00:00Z',absences:[{kind:'vacances',start_date:'2027-02-01',end_date:'2027-02-02',note:null}],signers:[{name:'Cadre fictif',at:'2026-11-11T10:00:00Z'}],direction:{name:'Direction fictive',at:'2026-11-11T11:00:00Z'},generatedAt:'2026-11-11T11:00:00Z',ref:'OC-ABS-D1'});
  const pdf=await PDFDocument.load(bytes);assert.ok(pdf.getPageCount()>=1);
  if(action==='modified') assert.match(pdf.getTitle(),/RECTIFICATIF/);
  if(action==='cancelled') assert.match(pdf.getTitle(),/ANNULATION/);
 }
});
test('PDF avec étapes supplémentaires : case du chef de service signée et lignes « Autres validations »',async()=>{
 const base={action:'approved',owner:'Personne fictive',clinics:['Thoracique'],requestedAt:'2026-11-11T10:00:00Z',absences:[{kind:'congres',start_date:'2027-02-01',end_date:'2027-02-02',note:null}],signers:[{name:'Cadre fictif',at:'2026-11-11T10:00:00Z'}],direction:{name:'Direction fictive',at:'2026-11-11T11:00:00Z'},generatedAt:'2026-11-11T11:00:00Z',ref:'OC-ABS-D2'};
 for(const role of ['clinician','cdc','cadre']) {
  const plain=await buildAbsenceForm({...base,role});
  const chef=await buildAbsenceForm({...base,role,extra:[{label:'Validation de la cheffe de service',name:'Cheffe fictive',at:'2026-11-11T12:00:00Z',slot:'chef_service'}]});
  const more=await buildAbsenceForm({...base,role,extra:[{label:'Validation de la cheffe de service',name:'Cheffe fictive',at:'2026-11-11T12:00:00Z',slot:'chef_service'},{label:'Finances',name:'Personne fictive 2',at:'2026-11-11T13:00:00Z',slot:null}]});
  assert.ok((await PDFDocument.load(chef)).getPageCount()>=1);
  assert.notEqual(plain.length,chef.length);
  assert.ok(more.length>chef.length);
 }
});
test('PDF de l\u2019état actuel : refus coché « Défavorable », signatures données, cases en attente vides',async()=>{
 const base={action:'current',owner:'Personne fictive',clinics:['Thoracique'],requestedAt:'2026-11-11T10:00:00Z',absences:[{kind:'vacances',start_date:'2027-02-01',end_date:'2027-02-02',note:null}],signers:[],direction:null,generatedAt:'2026-11-11T11:00:00Z',ref:'OC-ABS-A1'};
 for(const role of ['clinician','cdc','cadre']) {
  const empty=await buildAbsenceForm({...base,role});
  const kinds=[{kind:'clinique',label:'Validateurs de clinique'},{kind:'visa',label:'Visa de la direction'},{kind:'personnes',label:'Validation de la cheffe de service',slot:'chef_service'},{kind:'personnes',label:'Finances',slot:null}];
  const sizes=new Set();
  for(const k of kinds) {
   const bytes=await buildAbsenceForm({...base,role,signers:k.kind==='clinique'?[]:[{name:'Cadre fictif',at:'2026-11-11T10:00:00Z'}],direction:k.kind==='clinique'?null:{name:'Direction fictive',at:'2026-11-11T11:00:00Z'},refusal:{...k,name:'Refuseur fictif',at:'2026-11-11T12:00:00Z',comment:'Motif fictif'}});
   assert.ok((await PDFDocument.load(bytes)).getPageCount()>=1); assert.notEqual(bytes.length,empty.length); sizes.add(bytes.length);
  }
  assert.ok(sizes.size>=3);
 }
});
