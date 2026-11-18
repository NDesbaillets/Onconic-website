// Diffusion du PDF (ligne form_copy) : vrai handler, Auth, SMTP et base simulés ; aucun envoi réel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const secret = 'fictif-'.repeat(8);
const sent = []; const outbox = [];
let recipients = { emails: ['bloc@example.com', 'perso@example.com'], members: [] };
let mail = { owner: 'Dr Fictif', action: 'modified', block: [{ start: '2027-04-05', end: '2027-04-07', days: ['2027-04-05', '2027-04-06', '2027-04-07'] }], unblock: [{ start: '2027-03-01', end: '2027-03-03', days: ['2027-03-01'] }] };
let rows = [];
globalThis.absenceAdmin = {
  auth: { getUser: async () => ({ data: { user: null } }) },
  rpc: async (name, args) => {
    if (name === 'absence_purge') return { data: null };
    if (name === 'absence_outbox_claim') return { data: rows };
    if (name === 'absence_form_recipients') return { data: recipients };
    if (name === 'absence_agenda_mail') return { data: mail };
    if (name === 'absence_document_data') return { data: { document_id: args.p_document, generated_at: '2026-11-11T11:00:00Z', role: 'clinician', owner: 'Dr Fictif', action: 'modified', absences: [], signers: [] } };
    if (name === 'absence_outbox_done') outbox.push(['done', args.p_error]);
    if (name === 'absence_outbox_skip') outbox.push(['skip']);
    return { data: null };
  },
  storage: { from: () => ({ download: async () => ({ data: null }) }) },
};
globalThis.Deno = { env: { get: (k) => (k === 'ABSENCE_WORKER_TOKEN' ? secret : 'fictif') }, serve: (h) => { globalThis.absenceHandler = h; } };
globalThis.sendOutcome = null;
let source = await readFile(new URL('../../supabase/functions/notify-absence/index.ts', import.meta.url), 'utf8');
source = source.replace('import nodemailer from "npm:nodemailer@6.9.16";', 'const nodemailer = { createTransport: () => ({ sendMail: async (m) => { if (globalThis.sendOutcome) throw new Error(globalThis.sendOutcome); globalThis.sentMails.push(m); } }) };')
  .replace('import { createClient } from "npm:@supabase/supabase-js@2.57.4";', 'const createClient = () => globalThis.absenceAdmin;')
  .replace('import webpush from "npm:web-push@3.6.7";', 'const webpush = {};')
  .replace(/import \{ buildAbsenceForm, FILE_LABEL, type FormData, stamp \} from "\.\/form.ts";/, 'const buildAbsenceForm = async () => new Uint8Array([37,80,68,70]); const FILE_LABEL = {clinician:"Test"}; const stamp = (x) => x;')
  .replace('"./message.ts"', JSON.stringify(new URL('../../supabase/functions/notify-absence/message.ts', import.meta.url).href))
  .replace('"./delivery.ts"', JSON.stringify(new URL('../../supabase/functions/notify-absence/delivery.ts', import.meta.url).href))
  .replace('"./prefs.ts"', JSON.stringify(new URL('../../supabase/functions/notify-absence/prefs.ts', import.meta.url).href));
globalThis.sentMails = sent;
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
const run = () => globalThis.absenceHandler(new Request('https://example.invalid/notify-absence', { method: 'POST', headers: { 'content-type': 'application/json', 'x-absence-worker': secret }, body: '{}' }));
const row = { id: 1, kind: 'form_copy', recipient: null, absence_ids: [5], payload: { document_id: 12, action: 'modified' } };

test('form_copy : un second e-mail avec le PDF, destinataires en Bcc, expéditeur visible', async () => {
  rows = [row]; sent.length = 0; outbox.length = 0;
  const r = await (await run()).json();
  assert.equal(r.sent, 1);
  assert.equal(sent.length, 1);
  const m = sent[0];
  assert.equal(m.to, 'noreply@onconic.ch'); assert.deepEqual(m.bcc, ['bloc@example.com', 'perso@example.com']);
  assert.match(m.subject, /Absence modifiée de Dr Fictif/); assert.match(m.text, /#agenda/);
  assert.equal(m.attachments[0].contentType, 'application/pdf'); assert.match(m.attachments[0].filename, /D12/);
});
test('form_copy : un seul destinataire en To ; aucun destinataire ou tâche remplacée : rien n’est envoyé', async () => {
  rows = [row]; sent.length = 0; outbox.length = 0; recipients = { emails: ['seul@example.com'], members: [] };
  await run(); assert.equal(sent[0].to, 'seul@example.com'); assert.equal(sent[0].bcc, undefined);
  sent.length = 0; outbox.length = 0; recipients = { emails: [], members: [] };
  await run(); assert.equal(sent.length, 0); assert.deepEqual(outbox, [['skip']]);
  recipients = { emails: ['a@example.com'], members: [] }; mail = null; outbox.length = 0;
  await run(); assert.equal(sent.length, 0); assert.deepEqual(outbox, [['skip']]);
});
test('form_copy : échec SMTP signalé pour la reprise', async () => {
  mail = { owner: 'Dr Fictif', action: 'approved', block: [], unblock: [] }; recipients = { emails: ['a@example.com'], members: [] };
  globalThis.sendOutcome = 'SMTP indisponible : refus pour medecin.x@example.com'; outbox.length = 0;
  const r = await (await run()).json();
  assert.equal(r.failed, 1); assert.match(outbox[0][1], /SMTP indisponible/); assert.doesNotMatch(outbox[0][1], /@|example\.com/); assert.match(outbox[0][1], /\[adresse\]/);
  globalThis.sendOutcome = null;
});
