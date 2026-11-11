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
