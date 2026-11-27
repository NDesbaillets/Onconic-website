// Listes de personnes triées par nom de famille côté navigateur : onglet Direction, « Résumé de », diffusion, planning administratif,
// Congrès, Annuaire pour médecins, comptes temporaires, circuits (réponses simulées, données fictives).
//   NODE_PATH=/opt/node-tools/node_modules node tests/absences/name-lists-ui.mjs
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

// Ordre du serveur (par prénom), tel que signalé : le navigateur doit le remplacer par le nom de famille
const BY_FIRST = ['Alice Zed', 'alma Dupond', 'Anna Exemple', 'Bruno Test', 'Chloé Marti', 'Clara de la Roche', 'Démo Account', 'Émile Dupond', 'Eric Dupont', 'Max Test'];
const BY_FAMILY = ['Démo Account', 'Clara de la Roche', 'alma Dupond', 'Émile Dupond', 'Eric Dupont', 'Anna Exemple', 'Chloé Marti', 'Bruno Test', 'Max Test', 'Alice Zed'];

const SESSION = `auth: { getSession: async () => ({ data: { session: { user: { id: 'me' } } } }), signOut: async () => ({ error: null }) }`;
const LIST = JSON.stringify(BY_FIRST);

// ----- Absences, rôle direction -----
const ABS_MOCK = `
const names = ${LIST};
const members = names.map((n, i) => ({ id: 'm' + i, name: n, role: 'clinician', clinics: ['Thoracique'], institution: 'CHUV' }));
const people = [{ id: 'me', name: 'Moi Fictif', role: 'direction', clinics: [], is_me: true }].concat(members.map((m) => ({ id: m.id, name: m.name, role: 'clinician', clinics: ['Thoracique'], is_me: false })));
const rpc = async (name) => {
  const ok = (data) => ({ data, error: null });
  switch (name) {
    case 'absence_context': return ok({ me: 'me', role: 'direction', clinics: [], validates: [], pending: 0 });
    case 'absence_people': return ok(people);
    case 'absence_clinics': return ok([{ clinic: 'Thoracique', max_absent: 2 }]);
    case 'absence_manageable_members': return ok(members);
    case 'absence_notification_status': return ok({ pending: 0, failed: 0, sent: 0 });
    case 'absence_agenda_context': return { data: null, error: { message: 'absent' } };
    case 'absence_pending_count': case 'absence_agenda_pending_count': return ok(0);
    default: return ok([]);
  }
};
window.supabase = { createClient: () => ({ ${SESSION},
  rpc, functions: { invoke: async () => ({ data: null, error: null }) },
  from: () => { const q = { select: () => q, eq: () => q, single: async () => ({ data: { role: 'direction' } }), then: (r) => Promise.resolve({ data: [], error: null }).then(r) }; return q; } }) };`;

// ----- Diffusion -----
const DF_MOCK = `
const f = (n) => { const [a, ...b] = n.split(' '); return { first_name: a, last_name: b.join(' ') }; };
const names = ${LIST};
const rows = names.map((n, i) => Object.assign({ id: 'u' + i, role: 'clinician', email: 'u' + i + '@example.com' }, f(n)));
const docs = names.map((n, i) => ({ id: 'u' + i, name: n, role: 'clinician', clinics: ['Thoracique'], blocs: [], recipients: 1, mode: null }));
const leads = [{ id: 'l1', name: 'Alice Zed' }, { id: 'l2', name: 'Zoé Abel' }, { id: 'l3', name: 'Bob Blanc' }];
window.supabase = { createClient: () => ({ ${SESSION},
  rpc: async (name) => {
    const ok = (data) => ({ data, error: null });
    if (name === 'current_role_name') return ok('admin');
    if (name === 'admin_members') return ok(rows);
    if (name === 'admin_blocs_list') return ok({ blocs: [], clinics: ['Thoracique'], leads });
    if (name === 'admin_form_routing_overview') return ok(docs);
    if (name === 'admin_form_routing_get') return ok({ default: { blocs: [], members: [{ id: 'x', name: 'Alice Zed' }, { id: 'y', name: 'Zoé Abel' }] }, effective: { emails: [], members: [] }, mode: null, emails: [], member_ids: [] });
    return ok(null);
  } }) };`;

// ----- Planning administratif -----
const PL_MOCK = `
const names = ${LIST};
const staff = names.map((n, i) => { const [a, ...b] = n.split(' '); return { id: i + 1, first_name: a, last_name: b.join(' '), team: 'AM', pct: 100, bloc: null, resp: '', status: 'fixe', off: [], position: i, me: false }; });
window.supabase = { createClient: () => ({ ${SESSION},
  rpc: async (name) => {
    const ok = (data) => ({ data, error: null });
    if (name === 'my_tools') return ok(['planning']);
    if (name === 'plan_grid') return ok({ editor: false, codes: [], coverage: [], staff, cells: [], absences: [] });
    return ok([]);
  } }) };`;

// ----- Congrès -----
const CG_MOCK = `
const att = (n, st) => ({ event_id: 1, status: st, is_me: false, name: n, email: null, phone: null });
const rows = [att('Alice Zed', 'going'), att('Émile Dupond', 'going'), att('Démo Account', 'maybe'), att('Anna Exemple', 'presenting'), att('Chloé Marti', 'presenting')];
const ev = { id: 1, title: 'Congrès fictif', start_date: '2026-12-10', end_date: '2026-12-12', city: 'Lausanne', country: 'CH', kind: 'congres', clinics: [], created_by: 'x', description: '', venue: '' };
window.supabase = { createClient: () => ({ ${SESSION},
  rpc: async (name) => {
    const ok = (data) => ({ data, error: null });
    if (name === 'has_tool') return ok(true);
    if (name === 'event_attendees') return ok(rows);
    return ok([]);
  },
  functions: { invoke: async () => ({ data: null, error: null }) },
  from: (t) => { const data = t === 'events' ? [ev] : t === 'profiles' ? { role: 'clinician', show_in_events: true, contactable: false } : []; const q = { select: () => q, order: () => q, range: () => q, eq: () => q, single: async () => ({ data }), then: (r) => Promise.resolve({ data, error: null }).then(r) }; return q; } }) };`;

// ----- Annuaire pour médecins -----
const CT_MOCK = `
const mk = (id, first, last, service) => ({ id, first_name: first, last_name: last, service, detail: '', label: '', phone: '+41213145000', email: null, notes: '', scope: 'interne' });
const rows = [mk(1, 'Alice', 'Zed', 'Oncologie'), mk(2, 'Émile', 'Dupond', 'Oncologie'), mk(3, '', '', 'Radiologie'), mk(4, 'Chloé', 'Marti', 'Pharmacie'), mk(5, 'Zoé', 'Abel', 'Chirurgie'), mk(6, 'Zoé', 'Abel', 'Urgences'), mk(7, '', '', 'Abel Zoé')];
window.supabase = { createClient: () => ({ ${SESSION},
  rpc: async (name) => ({ data: name === 'has_tool' ? true : null, error: null }),
  from: (t) => { const data = t === 'contacts' ? rows : t === 'profiles' ? { role: 'clinician' } : []; const q = { select: () => q, order: () => q, range: () => q, eq: () => q, single: async () => ({ data }), then: (r) => Promise.resolve({ data, error: null }).then(r) }; return q; } }) };`;

// ----- Comptes temporaires -----
const TP_MOCK = `
const t = (id, first, last, active) => ({ id, email: first.toLowerCase() + '@example.com', first_name: first, last_name: last, access_until: '2026-12-31', active, created_at: '2026-11-01T10:00:00Z', created_by_name: 'Admin Fictif', last_sign_in_at: null });
const rows = [t('a', 'Alice', 'Zed', false), t('b', 'Bob', 'Blanc', true), t('c', 'Chloé', 'Abel', true), t('d', 'Dan', 'Abel', false)];
window.supabase = { createClient: () => ({ ${SESSION},
  rpc: async (name) => ({ data: name === 'can_manage_temps' ? true : name === 'temp_accounts' ? rows : null, error: null }) }) };`;

// ----- Circuits -----
const CC_MOCK = `
const U = (k) => '00000000-0000-4000-8000-00000000000' + k;
const members = [{ id: U(1), name: 'Alice Zed', role: 'clinician', clinics: ['Thoracique'] }, { id: U(2), name: 'Bob Blanc', role: 'clinician', clinics: ['Thoracique'] }, { id: U(3), name: 'Zoé Abel', role: 'clinician', clinics: ['Thoracique'] }];
const circuits = [{ id: 1, name: 'Circuit général', is_default: true, pos: 0, assignments: [], active_steps: 1, members: 3 }];
const overview = { direction: [], admins: [], visa_fallback_admins: false, clinics: [{ clinic: 'Thoracique', members: 3, validators: [{ id: U(1), name: 'Alice Zed', role: 'cadre', active: true }, { id: U(3), name: 'Zoé Abel', role: 'cadre', active: true }], active_count: 2, goes_to: 'validators' }], members,
  steps: [{ id: 2, pos: 10, col: 10, kind: 'personnes', label: 'Personnes', rule: 'any', blocking: true, active: true, persons: [], roles: [], scope: 'clinic', kinds: null, min_days: null, pdf_slot: null }], circuits, warnings: [] };
const who = members.map((m) => Object.assign({ circuit_id: 1, circuit_name: 'Circuit général', reason: 'default', conflict: false }, m));
window.supabase = { createClient: () => ({ ${SESSION},
  rpc: async (name) => {
    const ok = (data) => ({ data, error: null });
    if (name === 'current_role_name') return ok('admin');
    if (name === 'absence_circuit_overview') return ok(overview);
    if (name === 'absence_circuit_who') return ok(who);
    if (name === 'absence_circuit_get') return ok({ circuit: { id: 1, name: 'Circuit général', is_default: true }, steps: overview.steps, assignments: [], log: [] });
    return ok(null);
  } }) };`;

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const errors = [];
async function newCtx(mock) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.clock.setFixedTime(new Date('2026-11-18T10:00:00'));
  await ctx.addInitScript(mock);
  await ctx.route('**/*', (r) => (r.request().url().startsWith(BASE) ? r.continue() : r.abort()));
  return ctx;
}
async function openPage(ctx, path, ready) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(path + ' : ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(path + ' : ' + m.text()); });
  await page.goto(BASE + path);
  await page.locator(ready).waitFor({ state: 'visible' });
  return page;
}
let step = 0; const ok = (m) => console.log(`ok ${++step} - ${m}`);
const opts = (loc) => loc.evaluateAll((n) => n.map((x) => x.textContent.split(' · ')[0]));

try {
  // ===== Absences : onglet Direction et « Résumé de » =====
  const actx = await newCtx(ABS_MOCK);
  const a = await openPage(actx, '/app/absences.html', '#ab-t-dir');
  await a.locator('#ab-t-dir').click();
  const dir = a.locator('#ab-dir-who option:not([value=""])');
  await dir.first().waitFor({ state: 'attached' });
  assert.deepEqual(await opts(dir), BY_FAMILY, 'Direction : nom de famille malgré l\'ordre du serveur par prénom');
  assert.equal(await a.locator('#ab-dir-who option').first().textContent(), 'Choisir un membre du CHUV…');
  assert.equal(await a.locator('#ab-dir-sort-slot select').inputValue(), 'family');
  ok('Direction : membres triés par nom de famille, invite en tête');
  await a.locator('#ab-dir-who').selectOption({ label: 'Émile Dupond · Thoracique' });
  await a.locator('#ab-dir-sort-slot select').selectOption('first');
  assert.deepEqual(await opts(dir), BY_FIRST, 'Direction : choix « Prénom »');
  assert.equal(await a.locator('#ab-dir-who option:checked').textContent(), 'Émile Dupond · Thoracique', 'la sélection est conservée');
  ok('Direction : choix « Prénom » mémorisé, sélection conservée');
  await a.reload();
  await a.locator('#ab-t-dir').click();
  await a.locator('#ab-dir-who option').nth(1).waitFor({ state: 'attached' });
  assert.equal(await a.locator('#ab-dir-sort-slot select').inputValue(), 'first', 'choix conservé au rechargement');
  await a.locator('#ab-dir-sort-slot select').selectOption('family');
  ok('Direction : choix conservé au rechargement');

  const who = a.locator('#ab-who option:not([value=""])');
  assert.equal(await a.locator('#ab-who-wrap').isVisible(), false, 'Résumé de est dans l\'onglet Mes absences');
  await a.locator('#ab-t-mine').click();
  assert.deepEqual(await opts(who), BY_FAMILY, '« Résumé de » : nom de famille');
  await a.locator('#ab-who-sort-slot select').selectOption('first');
  assert.deepEqual(await opts(who), BY_FIRST, '« Résumé de » : prénom');
  await a.locator('#ab-who-sort-slot select').selectOption('family');
  ok('Résumé de : nom de famille par défaut, sélecteur « Prénom »');
  await actx.close();

  // ===== Diffusion =====
  const dctx = await newCtx(DF_MOCK);
  const d = await openPage(dctx, '/admin/diffusion-absences.html', '#df-tool');
  await d.locator('#df-docs h3').first().waitFor();
  assert.deepEqual(await d.locator('#df-docs h3').allTextContents(), BY_FAMILY, 'médecins : nom de famille');
  assert.deepEqual(await d.locator('#df-new-body .aa-cadres').nth(1).locator('label span').allTextContents(), ['Zoé Abel', 'Bob Blanc', 'Alice Zed'], 'responsables de bloc');
  await d.locator('#df-docs article').first().getByRole('button', { name: 'Destinataires' }).click();
  const mem = d.locator('#df-docs form .aa-cadres label span');
  await mem.first().waitFor();
  assert.deepEqual(await mem.allTextContents(), BY_FAMILY, 'choix de membres : nom de famille');
  await d.locator('#df-docs form .sort-select').selectOption('first');
  assert.deepEqual(await mem.allTextContents(), BY_FIRST, 'choix de membres : prénom');
  assert.match(await d.locator('#df-docs article').first().innerText(), /Zoé Abel, Alice Zed|Zoé Abel/);
  await d.locator('#df-sort-slot select').selectOption('first');
  assert.deepEqual(await d.locator('#df-docs h3').allTextContents(), BY_FIRST, 'médecins : prénom');
  ok('diffusion : médecins, responsables de bloc et membres triés, sélecteurs');
  await dctx.close();

  // ===== Planning administratif =====
  const pctx = await newCtx(PL_MOCK);
  const p = await openPage(pctx, '/app/planning.html', '#pl-tool');
  const staff = () => p.locator('#pl-grid .pl-who').allTextContents();
  const rowsFamily = BY_FAMILY;
  assert.deepEqual(await staff(), rowsFamily, 'planning : nom de famille');
  await p.locator('#pl-sort-slot select').selectOption('first');
  assert.deepEqual(await staff(), BY_FIRST, 'planning : prénom');
  ok('planning administratif : personnel trié par nom de famille puis par prénom');
  await pctx.close();

  // ===== Congrès =====
  const cctx = await newCtx(CG_MOCK);
  const c = await openPage(cctx, '/app/congres.html', '#cg-tool');
  await c.locator('#v-list').click();
  await c.locator('#cg-list summary').first().click();
  const part = c.locator('.cg-part .cg-people li strong');
  await part.first().waitFor();
  assert.deepEqual(await part.allTextContents(), ['Anna Exemple', 'Chloé Marti', 'Démo Account', 'Émile Dupond', 'Alice Zed'], 'intervenants d\'abord, puis nom de famille');
  await c.locator('.cg-part .sort-select').selectOption('first');
  assert.deepEqual(await part.allTextContents(), ['Anna Exemple', 'Chloé Marti', 'Alice Zed', 'Démo Account', 'Émile Dupond']);
  ok('Congrès : participants triés (intervenants en tête), sélecteur « Prénom »');
  await cctx.close();

  // ===== Annuaire pour médecins =====
  const kctx = await newCtx(CT_MOCK);
  const k = await openPage(kctx, '/app/contacts.html', '#an-tool');
  await k.locator('#an-list .ug-name').first().waitFor();
  assert.deepEqual(await k.locator('#an-list .ug-name').allTextContents(), ['Zoé Abel', 'Zoé Abel', 'Abel Zoé', 'Émile Dupond', 'Chloé Marti', 'Radiologie', 'Alice Zed'], 'personnes par nom de famille, services par titre, égalités départagées par identifiant');
  await k.locator('#an-sort-slot select').selectOption('first');
  assert.deepEqual(await k.locator('#an-list .ug-name').allTextContents(), ['Abel Zoé', 'Alice Zed', 'Chloé Marti', 'Émile Dupond', 'Radiologie', 'Zoé Abel', 'Zoé Abel']);
  ok('annuaire : fiches de personnes par nom de famille, sélecteur « Prénom »');
  await kctx.close();

  // ===== Comptes temporaires =====
  const tctx = await newCtx(TP_MOCK);
  const t = await openPage(tctx, '/app/temporaires.html', '#tmp-list');
  await t.locator('#tmp-list article').first().waitFor();
  assert.deepEqual(await t.locator('#tmp-list article .tmp-head strong').allTextContents(), ['Chloé Abel', 'Bob Blanc', 'Dan Abel', 'Alice Zed'], 'actifs puis terminés, nom de famille dans chaque groupe');
  ok('comptes temporaires : actifs puis terminés, par nom de famille');
  await tctx.close();

  // ===== Circuits =====
  const kk = await newCtx(CC_MOCK);
  const cc = await openPage(kk, '/admin/circuit-absences.html', '#cc-tool');
  await cc.locator('details.cc-fold').evaluateAll((n) => n.forEach((d) => { d.open = true; }));
  await cc.locator('#cc-who-table tbody tr').first().waitFor();
  const col = (sel) => cc.locator(sel).allTextContents();
  assert.deepEqual(await col('#cc-who-table tbody tr td:first-child'), ['Zoé Abel', 'Bob Blanc', 'Alice Zed'], 'qui suit quel circuit : nom de famille');
  await cc.locator('#cc-who-sort select').selectOption('first');
  assert.deepEqual(await col('#cc-who-table tbody tr td:first-child'), ['Alice Zed', 'Bob Blanc', 'Zoé Abel']);
  assert.deepEqual((await col('#cc-member option')).map((x) => x.split(' · ')[0]), ['Zoé Abel', 'Bob Blanc', 'Alice Zed'], 'simulateur : nom de famille');
  await cc.locator('#cc-sim-sort select').selectOption('first');
  assert.deepEqual((await col('#cc-member option')).map((x) => x.split(' · ')[0]), ['Alice Zed', 'Bob Blanc', 'Zoé Abel']);
  assert.match(await cc.locator('#cc-table tbody tr').first().innerText(), /Zoé Abel.*Alice Zed|Alice Zed.*Zoé Abel/s);
  assert.ok((await cc.locator('#cc-table tbody tr').first().innerText()).indexOf('Zoé Abel') < (await cc.locator('#cc-table tbody tr').first().innerText()).indexOf('Alice Zed'), 'validateurs par clinique : nom de famille');
  ok('circuits : « qui suit quel circuit », simulateur et validateurs triés, sélecteurs');
  await kk.close();

  assert.deepEqual(errors, [], 'aucune erreur de console');
  ok('aucune erreur de page');
} finally { await browser.close(); server.close(); }
