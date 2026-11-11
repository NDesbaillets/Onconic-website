// Exécute le vrai handler avec Auth, SMTP et base simulés ; aucun serveur distant.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const calls=[];
const secret='fictif-'.repeat(8);
let documentAllowed=false;
globalThis.absenceAdmin={
 auth:{getUser:async(token)=>{calls.push('auth');return {data:{user:token==='valid-user'?{id:'owner'}:null}};}},
 rpc:async(name,args)=>{
  calls.push(name);
  if(name==='absence_outbox_claim')return {data:[]};
  if(name==='absence_document_access')return {data:documentAllowed};
  if(name==='absence_document_data')return {data:{document_id:12,generated_at:'2026-11-11T11:00:00Z',role:'clinician',owner:'Test',absences:[],signers:[]}};
  return {data:null};
 },storage:{from:()=>({download:async()=>({data:null})})}
};
globalThis.Deno={env:{get:(key)=>key==='ABSENCE_WORKER_TOKEN'?secret:'fictif'},serve:(handler)=>{globalThis.absenceHandler=handler;}};
let source=await readFile(new URL('../../supabase/functions/notify-absence/index.ts',import.meta.url),'utf8');
source=source.replace('import nodemailer from "npm:nodemailer@6.9.16";','const nodemailer = { createTransport: () => ({}) };')
 .replace('import { createClient } from "npm:@supabase/supabase-js@2.57.4";','const createClient = () => globalThis.absenceAdmin;')
 .replace('import webpush from "npm:web-push@3.6.7";','const webpush = {};')
 .replace(/import \{ buildAbsenceForm, FILE_LABEL, type FormData, stamp \} from "\.\/form.ts";/,'const buildAbsenceForm = async () => new Uint8Array([37,80,68,70]); const FILE_LABEL = {clinician:"Test"}; const stamp = (x) => x;')
 .replace('"./message.ts"',JSON.stringify(new URL('../../supabase/functions/notify-absence/message.ts',import.meta.url).href))
 .replace('"./delivery.ts"',JSON.stringify(new URL('../../supabase/functions/notify-absence/delivery.ts',import.meta.url).href));
const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
const request=(headers={},body={})=>globalThis.absenceHandler(new Request('https://example.invalid/notify-absence',{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)}));
test('endpoint : aucune session et secret incorrect rejetés',async()=>{
 calls.length=0;
 assert.equal((await request()).status,401); assert.equal(calls.length,0);
 assert.equal((await request({'x-absence-worker':'incorrect'})).status,401);
 assert.equal((await request({authorization:'Bearer invalid'})).status,401);
});
test('endpoint : worker autorisé à expédier, jamais à télécharger',async()=>{
 calls.length=0;
 const response=await request({'x-absence-worker':secret});assert.equal(response.status,200);
 assert.ok(calls.includes('absence_outbox_claim'));assert.ok(!calls.includes('auth'));
 assert.equal((await request({'x-absence-worker':secret},{action:'form',document_id:12})).status,403);
});
test('endpoint : télécharger une version exige la permission SQL',async()=>{
 documentAllowed=false;
 assert.equal((await request({authorization:'Bearer valid-user'},{action:'form',document_id:12})).status,403);
 documentAllowed=true;
 const response=await request({authorization:'Bearer valid-user'},{action:'form',document_id:12});assert.equal(response.status,200);
 const result=await response.json();assert.match(result.file,/D12/);assert.ok(result.pdf);
});
