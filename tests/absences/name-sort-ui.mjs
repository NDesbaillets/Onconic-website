// Tri des listes de personnes : planning des absences et Membres et accès (réponses simulées, données fictives).
//   NODE_PATH=/opt/node-tools/node_modules node tests/absences/name-sort-ui.mjs
import http from 'node:http';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { console.log('Playwright absent : test de navigateur ignoré.'); process.exit(0); }
const ROOT = new URL('../../', import.meta.url).pathname;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const server = http.createServer(async (req, res) => {
  const file = normalize(join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
  if (!file.startsWith(ROOT)) { res.statusCode = 403; return res.end(); }
  try { res.setHeader('content-type', TYPES[extname(file)] || 'application/octet-stream'); res.end(await readFile(file)); } catch { res.statusCode = 404; res.end('404'); }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const BASE = `http://127.0.0.1:${server.address().port}`;

// Prénom puis nom : par prénom Alice < Bob < Chloé < Moi ; par nom de famille Zoé Abel < Bob Blanc < Chloé de la Cruz < Alice Zed
const ABS_MOCK = `
const P = (id, name, me) => ({ id, name, role: 'clinician', clinics: ['Thoracique'], is_me: !!me });
const people = [P('me', 'Moi Fictif', true), P('a', 'Alice Zed'), P('b', 'Bob Blanc'), P('c', 'Chloé de la Cruz'), P('z', 'Zoé Abel')];
const rpc = async (name, args) => {
  const ok = (data) => ({ data, error: null });
  switch (name) {
    case 'absence_context': return ok({ me: 'me', role: 'clinician', clinics: ['Thoracique'], validates: [], pending: 0 });
    case 'absence_people': return ok(people);
    case 'absence_clinics': return ok([{ clinic: 'Thoracique', max_absent: 2 }]);
    case 'absence_notification_status': return ok({ pending: 0, failed: 0, sent: 0 });
    case 'absence_agenda_context': return { data: null, error: { message: 'absent' } };
    case 'absence_grid': case 'absence_calendar': case 'absence_list': return ok([]);
    default: return ok(null);
  }
};
window.supabase = { createClient: () => ({
  auth: { getSession: async () => ({ data: { session: { user: { id: 'me' } } } }), signOut: async () => ({ error: null }) },
  rpc, functions: { invoke: async () => ({ data: null, error: null }) },
  from: () => { const q = { select: () => q, eq: () => q, single: async () => ({ data: { role: 'clinician' } }), then: (r) => Promise.resolve({ data: [], error: null }).then(r) }; return q; } }) };`;

const MEM_MOCK = `
const mk = (id, first, last, role) => ({ id, first_name: first, last_name: last, full_name: first + ' ' + last, email: first.toLowerCase() + '@example.com', role, institution: 'CHUV',
  created_at: '2026-10-01T10:00:00Z', last_sign_in_at: null, tools: {}, clinics: [], cdc_clinics: [], absence_validator: false, validates: [] });
const rows = [mk('me', 'Admin', 'Fictif', 'admin'), mk('u1', 'Alice', 'Zed', 'clinician'), mk('u2', 'Bob', 'Blanc', 'cadre'), mk('u3', 'Chloé', 'Rey', 'member'), mk('u4', 'Zoé', 'Abel', 'nurse')];
window.supabase = { createClient: () => ({
  auth: { getSession: async () => ({ data: { session: { user: { id: 'me' } } } }), signOut: async () => ({ error: null }) },
  rpc: async (name) => ({ data: name === 'current_role_name' ? 'admin' : name === 'admin_members' ? structuredClone(rows) : (name === 'admin_blocs_list' ? { blocs: [] } : []), error: null }) }) };
window.confirm = () => true;`;


const OC_MOCK = `
const people = [
  { id: 'p1', name: 'Alice Zed', role: 'clinician', clinics: ['Thoracique'] },
  { id: 'p2', name: 'Bob Blanc', role: 'cadre', clinics: ['Thoracique'] },
  { id: 'p3', name: 'Chloé de la Cruz', role: 'nurse', clinics: ['Thoracique'] },
  { id: 'p4', name: 'Zoé Abel', role: 'clinician', clinics: ['Thoracique'] }];
const detail = { poll: { id: 1, kind: 'rsvp', status: 'closed', locked: true, is_creator: false, creator: 'Org Fictif', title: 'Soirée fictive', visibility: 'all', final_option_id: 1, deadline: null, description: '', location: '' },
  counts: { responded: 4, invited: 4 }, me: null,
  options: [{ id: 1, day: '2026-12-01', start: null, end: null, yes: 4, maybe: 0, no: 0 }],
  invitees: people.map((x) => ({ id: x.id, name: x.name, votes: { 1: 'yes' }, required: false, responded: true, comment: '' })) };
const rpc = async (name) => {
  const ok = (data) => ({ data, error: null });
  switch (name) {
    case 'has_tool': return ok(true);
    case 'oncoodle_people': return ok(people);
    case 'oncoodle_get': return ok(detail);
    case 'oncoodle_list': case 'oncoodle_calendar_requests': return ok([]);
    case 'oncoodle_prefs': return ok({ email: true });
    default: return ok(null);
  }
};
window.supabase = { createClient: () => ({
  auth: { getSession: async () => ({ data: { session: { user: { id: 'me' } } } }), signOut: async () => ({ error: null }) },
  rpc, functions: { invoke: async () => ({ data: null, error: null }) },
  from: () => { const q = { select: () => q, eq: () => q, single: async () => ({ data: { role: 'clinician' } }) }; return q; } }) };`;

const AA_MOCK = `
const cadres = [{ id: 'c1', name: 'Alice Zed', role: 'cadre' }, { id: 'c2', name: 'Bob Blanc', role: 'cadre' }, { id: 'c3', name: 'Zoé Abel', role: 'cadre' }];
window.supabase = { createClient: () => ({
  auth: { getSession: async () => ({ data: { session: { user: { id: 'me' } } } }), signOut: async () => ({ error: null }) },
  rpc: async (name) => ({ data: name === 'current_role_name' ? 'admin' : name === 'admin_absence_config' ? { clinics: [{ clinic: 'Thoracique', max_absent: 2, members: 3, validators: [] }], cadres, cadres_sans_validation: 0 } : [], error: null }),
  from: () => { const q = { select: () => q, eq: () => q, order: () => q, limit: () => q, then: (r) => Promise.resolve({ data: [], error: null }).then(r) }; return q; } }) };`;

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const errors = [];
// Un contexte par scénario ; les rechargements d'un même contexte conservent localStorage
async function newCtx(mock, seed) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.clock.setFixedTime(new Date('2026-11-18T10:00:00'));
  await ctx.addInitScript(mock);
  if (seed) await ctx.addInitScript((s) => { if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); localStorage.setItem('onconic.absences.v1', s); } }, seed);
  await ctx.route('**/*', (r) => (r.request().url().startsWith(BASE) ? r.continue() : r.abort()));
  return ctx;
}
async function openPage(ctx, path, ready) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.goto(BASE + path);
  await page.locator(ready).waitFor({ state: 'visible' });
  return page;
}
const order = (page) => page.locator('#ab-order-list .ab-ord-name').evaluateAll((n) => n.map((x) => x.textContent.replace(' (moi)', '')));
let step = 0; const ok = (m) => console.log(`ok ${++step} - ${m}`);

try {
  // ===== Planning des absences =====
  const ctx = await newCtx(ABS_MOCK, JSON.stringify({ scope: 'all' }));
  let p = await openPage(ctx, '/app/absences.html', '#ab-scroll table');
  const sel = p.locator('#ab-sort-slot select');
  await p.locator('#ab-pick-toggle').click();
  assert.equal(await sel.count(), 1, 'sélecteur « Trier par » présent');
  assert.match(await p.locator('#ab-sort-slot').innerText(), /Trier par/);
  assert.equal(await sel.inputValue(), 'family', 'défaut : nom de famille');
  assert.deepEqual(await order(p), ['Moi Fictif', 'Zoé Abel', 'Bob Blanc', 'Chloé de la Cruz', 'Alice Zed'].map((x) => x));
  ok('planning : ordre par défaut = nom de famille, moi en tête');
  await sel.selectOption('first');
  assert.deepEqual(await order(p), ['Moi Fictif', 'Alice Zed', 'Bob Blanc', 'Chloé de la Cruz', 'Zoé Abel']);
  ok('planning : choix « Prénom »');
  p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(BASE + '/app/absences.html');
  await p.locator('#ab-scroll table').waitFor();
  await p.locator('#ab-pick-toggle').click();
  assert.equal(await p.locator('#ab-sort-slot select').inputValue(), 'first', 'choix mémorisé');
  assert.deepEqual(await order(p), ['Moi Fictif', 'Alice Zed', 'Bob Blanc', 'Chloé de la Cruz', 'Zoé Abel']);
  ok('planning : choix mémorisé au rechargement');
  // Ordre manuel prioritaire : Chloé monte en tête, le reste suit le tri choisi
  await p.locator('#ab-order-list li[data-id="c"] .ab-ord-up').click();
  await p.locator('#ab-order-list li[data-id="c"] .ab-ord-up').click();
  await p.locator('#ab-order-list li[data-id="c"] .ab-ord-up').click();
  assert.equal((await order(p))[0], 'Chloé de la Cruz');
  const manual = await order(p);
  await p.locator('#ab-sort-slot select').selectOption('family');
  assert.equal((await order(p))[0], 'Chloé de la Cruz', 'l\'ordre manuel reste prioritaire');
  assert.equal(await p.locator('#ab-order-reset').isVisible(), true);
  await p.locator('#ab-order-reset').click();
  assert.deepEqual(await order(p), ['Moi Fictif', 'Zoé Abel', 'Bob Blanc', 'Chloé de la Cruz', 'Alice Zed']);
  assert.ok(manual.length === 5);
  ok('planning : ordre manuel prioritaire, la remise à zéro revient au tri choisi');
  await ctx.close();

  // ===== Membres et accès =====
  const mctx = await newCtx(MEM_MOCK);
  const m = await openPage(mctx, '/admin/membres.html', '#am-tool');
  const names = () => m.locator('#am-list .am-row-name').allTextContents();
  assert.equal(await m.locator('#am-sort-slot select').inputValue(), 'family');
  assert.deepEqual(await names(), ['Chloé Rey', 'Zoé Abel', 'Bob Blanc', 'Admin Fictif', 'Alice Zed'], 'en attente en tête, puis nom de famille');
  await m.locator('#am-sort-slot select').selectOption('first');
  assert.deepEqual(await names(), ['Chloé Rey', 'Admin Fictif', 'Alice Zed', 'Bob Blanc', 'Zoé Abel'], 'en attente en tête, puis prénom');
  await m.locator('#am-sort-slot select').selectOption('role');
  assert.equal((await names())[0], 'Chloé Rey');
  assert.equal((await names())[1], 'Bob Blanc', 'cadre avant assistant, infirmier et administrateur');
  ok('membres : en attente en tête, le reste suit le tri choisi');
  await mctx.close();

  // ===== Oncoodle : réponses, suggestions =====
  const octx = await newCtx(OC_MOCK);
  const o = await openPage(octx, '/app/oncoodle.html#p=1', '#oc-detail .oc-head');
  const line = async () => (await o.locator('#oc-detail p', { hasText: /^Participent \(/ }).innerText());
  assert.equal(await o.locator('#oc-detail select').inputValue(), 'family');
  assert.match(await line(), /Zoé Abel, Bob Blanc, Chloé de la Cruz, Alice Zed/);
  await o.locator('#oc-detail select').selectOption('first');
  assert.match(await line(), /Alice Zed, Bob Blanc, Chloé de la Cruz, Zoé Abel/);
  ok('oncoodle : réponses triées par nom de famille puis par prénom');
  await o.locator('#oc-back').click();
  await o.locator('#oc-new').click();
  await o.locator('#oc-pick-in').fill('th');
  const sugg = () => o.locator('#oc-pick-list li button').evaluateAll((n) => n.map((x) => x.textContent.split('  ')[0]));
  assert.deepEqual(await sugg(), ['Zoé Abel', 'Bob Blanc', 'Chloé de la Cruz', 'Alice Zed']);
  await o.locator('#oc-sort-slot select').selectOption('role');
  await o.locator('#oc-pick-in').fill('');
  await o.locator('#oc-pick-in').fill('th');
  assert.deepEqual(await sugg(), ['Zoé Abel', 'Alice Zed', 'Bob Blanc', 'Chloé de la Cruz'], 'rôle : médecin assistant, cadre, infirmière');
  ok('oncoodle : suggestions de destinataires triées, sélecteur dans le formulaire');
  await octx.close();

  // ===== Absences, administration : validateurs =====
  const actx = await newCtx(AA_MOCK);
  const a = await openPage(actx, '/admin/absences.html', '#aa-tool');
  const cad = () => a.locator('.aa-cadres label span').allTextContents();
  assert.deepEqual(await cad(), ['Zoé Abel', 'Bob Blanc', 'Alice Zed']);
  await a.locator('#aa-sort-slot select').selectOption('first');
  assert.deepEqual(await cad(), ['Alice Zed', 'Bob Blanc', 'Zoé Abel']);
  ok('administration des absences : cadres triés par nom de famille puis par prénom');
  await actx.close();
  assert.deepEqual(errors, [], 'aucune erreur de console');
  ok('aucune erreur de page');
} finally { await browser.close(); server.close(); }
