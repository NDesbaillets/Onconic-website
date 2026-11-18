// Exécute le vrai gestionnaire de notify-absence avec base, e-mail et push simulés : les réglages de notifications sont respectés.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const secret = 'fictif-'.repeat(8);
const sent = [], skipped = [], done = [], pushes = [];
let rows = [], profile = {}, formsTo = '';
const chain = (data) => { const o = { select: () => o, in: () => o, eq: () => o, order: () => o, maybeSingle: async () => ({ data }), then: (ok, ko) => Promise.resolve({ data, error: null }).then(ok, ko) }; return o; };
globalThis.prefsAdmin = {
  auth: { getUser: async () => ({ data: { user: null } }), admin: { getUserById: async (id) => ({ data: { user: { email: `${id}@example.invalid` } } }) } },
  rpc: async (name, args) => {
    if (name === 'absence_purge' || name === 'absence_worker_verify') return { data: null };
    if (name === 'absence_outbox_claim') return { data: rows };
    if (name === 'absence_notification_ids') return { data: [1] };
    if (name === 'member_name') return { data: 'Test Membre' };
    if (name === 'absence_outbox_skip') { skipped.push(args.p_id); return { data: null }; }
    if (name === 'absence_outbox_done') { done.push([args.p_id, args.p_error]); return { data: null }; }
    return { data: null };
  },
  from: (table) => {
    if (table === 'absences') return chain([{ id: 1, user_id: 'owner', kind: 'vacances', start_date: '2026-12-01', end_date: '2026-12-02', change_type: null, change_kind: null, change_start: null, change_end: null }]);
    if (table === 'profiles') return chain(profile);
    if (table === 'push_subscriptions') return chain([{ id: 1, endpoint: 'https://push.example.invalid/1', p256dh: 'a', auth: 'b' }]);
    if (table === 'push_config') return chain({ vapid_public: 'x', vapid_private: 'y' });
    return chain([]);
  },
  storage: { from: () => ({ download: async () => ({ data: null }) }) },
};
globalThis.Deno = { env: { get: (k) => (k === 'ABSENCE_WORKER_TOKEN' ? secret : k === 'ABSENCE_FORMS_TO' ? formsTo : k === 'SMTP_PASSWORD' ? 'fictif' : 'fictif') }, serve: (h) => { globalThis.prefsHandler = h; } };
globalThis.prefsMail = { createTransport: () => ({ sendMail: async (m) => { sent.push(m); } }) };
globalThis.prefsPush = { setVapidDetails: () => {}, generateVAPIDKeys: () => ({ publicKey: 'p', privateKey: 'q' }), sendNotification: async () => { pushes.push(1); } };

let source = await readFile(new URL('../../supabase/functions/notify-absence/index.ts', import.meta.url), 'utf8');
const dir = (f) => JSON.stringify(new URL('../../supabase/functions/notify-absence/' + f, import.meta.url).href);
source = source.replace('import nodemailer from "npm:nodemailer@6.9.16";', 'const nodemailer = globalThis.prefsMail;')
  .replace('import { createClient } from "npm:@supabase/supabase-js@2.57.4";', 'const createClient = () => globalThis.prefsAdmin;')
  .replace('import webpush from "npm:web-push@3.6.7";', 'const webpush = globalThis.prefsPush;')
  .replace(/import \{ buildAbsenceForm, FILE_LABEL, type FormData, stamp \} from "\.\/form.ts";/, 'const buildAbsenceForm = async () => new Uint8Array([37, 80, 68, 70]); const FILE_LABEL = { clinician: "Test" }; const stamp = (x) => x;')
  .replace('"./message.ts"', dir('message.ts')).replace('"./delivery.ts"', dir('delivery.ts')).replace('"./prefs.ts"', dir('prefs.ts'));
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));

const run = async (claimed, prof, forms = '') => {
  sent.length = skipped.length = done.length = pushes.length = 0;
  rows = claimed; profile = prof; formsTo = forms;
  const r = await globalThis.prefsHandler(new Request('https://example.invalid/notify-absence', { method: 'POST', headers: { 'content-type': 'application/json', 'x-absence-worker': secret }, body: '{}' }));
  assert.equal(r.status, 200);
  return r.json();
};
const row = (id, kind, recipient, payload = {}) => ({ id, kind, recipient, absence_ids: [1], payload });
const validator = (notif_prefs, extra = {}) => ({ lang: 'fr', notify_events: false, role: 'cadre', notif_prefs, ...extra });

test('sans réglage : e-mail envoyé comme avant', async () => {
  await run([row(1, 'to_validate', 'val1')], validator({}));
  assert.equal(sent.length, 1); assert.equal(sent[0].to, 'val1@example.invalid'); assert.deepEqual(done, [[1, null]]); assert.deepEqual(skipped, []);
  await run([row(2, 'to_validate', 'val1')], validator(null));
  assert.equal(sent.length, 1, 'colonne vide : même comportement');
});

test('type désactivé par e-mail : rien n\'est envoyé, la ligne est ignorée et non marquée envoyée', async () => {
  await run([row(1, 'to_validate', 'val1')], validator({ to_validate: { email: false } }));
  assert.equal(sent.length, 0); assert.deepEqual(skipped, [1]); assert.deepEqual(done, []);
  await run([row(2, 'to_validate_change', 'val1')], validator({ to_validate: { email: false } }));
  assert.equal(sent.length, 1, 'un autre type reste envoyé');
});

test('rappels : coupés par « reminder » ou par le type de base', async () => {
  await run([row(1, 'to_validate', 'val1', { reminder: true })], validator({ reminder: { email: false } }));
  assert.equal(sent.length, 0); assert.deepEqual(skipped, [1]);
  await run([row(2, 'to_validate', 'val1')], validator({ reminder: { email: false } }));
  assert.equal(sent.length, 1, 'la demande initiale arrive, seuls les rappels sont coupés');
  await run([row(3, 'to_validate', 'val1', { reminder: true })], validator({ to_validate: { email: false } }));
  assert.equal(sent.length, 0, 'type de base coupé : pas de rappel');
  await run([row(4, 'to_validate', 'val1', { reminder: true })], validator({}));
  assert.equal(sent.length, 1);
});

test('notification sur l\'appareil seule : le push part, pas l\'e-mail, la ligne est terminée', async () => {
  await run([row(1, 'to_validate', 'val1')], validator({ to_validate: { email: false } }, { notify_events: true }));
  assert.equal(pushes.length, 1); assert.equal(sent.length, 0); assert.deepEqual(done, [[1, null]]); assert.deepEqual(skipped, []);
  await run([row(2, 'to_validate', 'val1')], validator({ to_validate: { push: false } }, { notify_events: true }));
  assert.equal(pushes.length, 0, 'push coupé'); assert.equal(sent.length, 1, 'e-mail conservé');
  await run([row(3, 'to_validate', 'val1')], validator({ to_validate: { email: false, push: false } }, { notify_events: true }));
  assert.equal(pushes.length + sent.length, 0); assert.deepEqual(skipped, [3]);
});

test('direction : boîte commune servie une fois tant qu\'un destinataire le souhaite', async () => {
  const dirOff = { lang: 'fr', notify_events: false, role: 'direction', notif_prefs: { to_direction: { email: false } } };
  const dirOn = { lang: 'fr', notify_events: false, role: 'direction', notif_prefs: {} };
  // Deux destinataires du même message : l'un a coupé, l'autre non ; la ligne coupée est ignorée, l'autre part vers la boîte commune
  const prefsByRecipient = { d1: dirOff, d2: dirOn };
  globalThis.prefsAdmin.from = ((orig) => (t) => (t === 'profiles' ? { ...chain(null), eq: (_c, id) => chain(prefsByRecipient[id]), select: () => ({ eq: (_c, id) => chain(prefsByRecipient[id]) }) } : orig(t)))(globalThis.prefsAdmin.from);
  await run([row(1, 'to_direction', 'd1'), row(2, 'to_direction', 'd2')], null, 'direction@example.invalid');
  assert.equal(sent.length, 1); assert.deepEqual(sent[0].to, ['direction@example.invalid']); assert.deepEqual(skipped, [1]); assert.deepEqual(done, [[2, null]]);
  // Tous ont coupé : aucun e-mail
  prefsByRecipient.d2 = dirOff;
  await run([row(3, 'to_direction', 'd1'), row(4, 'to_direction', 'd2')], null, 'direction@example.invalid');
  assert.equal(sent.length, 0); assert.deepEqual(skipped, [3, 4]);
});

test('to_opinion : boîte commune pour le pré-avis de la direction, adresse personnelle pour une personne d\'étape', async () => {
  const dir = { lang: 'fr', notify_events: false, role: 'direction', notif_prefs: {} };
  await run([row(1, 'to_opinion', 'd1')], dir, 'direction@example.invalid');
  assert.deepEqual(sent[0].to, ['direction@example.invalid'], 'pré-avis de la direction');
  await run([row(2, 'to_opinion', 'val1', { step_label: 'Avis de la cheffe de service' })], validator({}), 'direction@example.invalid');
  assert.equal(sent[0].to, 'val1@example.invalid', 'personne désignée (non direction)');
  await run([row(3, 'to_opinion', 'd1', { step_label: 'Avis X' })], dir, 'direction@example.invalid');
  assert.equal(sent[0].to, 'd1@example.invalid', 'avis d\'étape à une personne de la direction : adresse personnelle');
});
