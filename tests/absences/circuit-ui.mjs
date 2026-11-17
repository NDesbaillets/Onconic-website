// Page Circuit des absences : schéma, éditeur, simulation et enregistrement sur réponses simulées (aucune base distante).
// Nécessite Playwright : node tests/absences/circuit-ui.mjs
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

// Données fictives
const MOCK = `
const U1 = '11111111-1111-4111-8111-111111111111', U2 = '22222222-2222-4222-8222-222222222222';
const steps = [
  { id: 1, pos: 0, kind: 'preavis', label: 'Pré-avis de la direction', rule: 'all', blocking: false, active: true, persons: [], kinds: null, min_days: null, pdf_slot: null },
  { id: 2, pos: 10, kind: 'clinique', label: 'Validateurs de clinique', rule: 'all', blocking: true, active: true, persons: [], kinds: null, min_days: null, pdf_slot: null },
  { id: 3, pos: 20, kind: 'visa', label: 'Visa de la direction', rule: 'any', blocking: true, active: true, persons: [], kinds: null, min_days: null, pdf_slot: null },
  { id: 4, pos: 30, kind: 'personnes', label: 'Validation de la cheffe de service', rule: 'any', blocking: true, active: false, persons: [{ id: U1, name: 'Cheffe Fictive', has_tool: true }], kinds: ['congres'], min_days: 10, pdf_slot: 'chef_service' },
];
const overview = {
  direction: [{ id: U2, name: 'Direction Fictive', has_tool: true }], admins: [], visa_fallback_admins: false,
  clinics: [{ clinic: 'Thoracique', members: 5, validators: [], active_count: 0, goes_to: 'direction' }],
  members: [{ id: U1, name: 'Cheffe Fictive', role: 'cadre', clinics: ['Thoracique'] }, { id: U2, name: 'Direction Fictive', role: 'direction', clinics: [] }, { id: '33333333-3333-4333-8333-333333333333', name: 'Alice Exemple', role: 'clinician', clinics: ['Thoracique'] }],
  steps, warnings: [],
};
window.__calls = [];
const sb = {
  auth: { getSession: async () => ({ data: { session: { user: { id: 'me' } } } }), signOut: async () => ({ error: null }) },
  rpc: async (name, args) => {
    window.__calls.push([name, args]);
    if (name === 'current_role_name') return { data: 'admin', error: null };
    if (name === 'absence_circuit_overview') return { data: overview, error: null };
    if (name === 'absence_circuit_get') return { data: { steps, log: [{ id: 1, at: '2026-11-17T09:30:00Z', by_name: 'Admin Fictif', summary: 'Étapes actives : Validateurs de clinique, Visa de la direction' }] }, error: null };
    if (name === 'absence_circuit_simulate') return { data: { member: { name: 'Alice Exemple', role: 'clinician' }, clinics: ['Thoracique'], kind: args.p_kind, steps: [{ pos: 10, kind: 'clinique', label: 'Validateurs de clinique', rule: 'tous', blocking: true, people: [], note: null }], excluded: [], admin_override: 'Un administrateur peut valider à toute étape.', self_excluded: false }, error: null };
    if (name === 'absence_circuit_save') return args.p_steps.some((s) => s.label === 'ERREUR') ? { data: null, error: { message: 'Le libellé est refusé par le serveur.' } } : { data: { steps, log: [] }, error: null };
    return { data: null, error: null };
  },
};
window.supabase = { createClient: () => sb };`;

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const errors = [];
let step = 0; const ok = (m) => console.log(`ok ${++step} - ${m}`);
async function open(viewport) {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript(MOCK);
  await ctx.route('**/*', (r) => (r.request().url().startsWith(BASE) ? r.continue() : r.abort()));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on('dialog', (d) => d.accept());
  await page.goto(BASE + '/admin/circuit-absences.html');
  await page.locator('#cc-tool').waitFor({ state: 'visible' });
  return page;
}
const calls = (p, name) => p.evaluate((n) => window.__calls.filter((c) => c[0] === n), name);

try {
  const p = await open({ width: 1280, height: 900 });
  // Schéma : étape inactive grisée, conditions affichées
  assert.equal(await p.locator('#cc-flow .cc-node.inactive').count(), 1);
  assert.match(await p.locator('#cc-flow .cc-node.inactive').innerText(), /désactivée/);
  assert.match(await p.locator('#cc-flow').innerText(), /seulement : congrès/);
  assert.match(await p.locator('#cc-flow').innerText(), /dès 10 jours ouvrables/);
  assert.equal(await p.locator('#cc-editor .cc-ed').count(), 4);
  assert.equal(await p.locator('#cc-save').isDisabled(), true);
  assert.match(await p.locator('#cc-log').innerText(), /17\.11\.2026 \d\d:\d\d · Admin Fictif/);
  ok('schéma, éditeur et journal affichés');

  // Édition : libellé, ordre, indicateur de modifications
  await p.locator('#cc-editor .cc-ed').nth(2).locator('input[type=text]').fill('Visa final');
  assert.equal(await p.locator('#cc-dirty').isVisible(), true);
  await p.locator('#cc-editor .cc-ed').nth(2).getByRole('button', { name: 'Monter l\'étape' }).click();
  assert.equal(await p.locator('#cc-editor .cc-ed').nth(1).locator('input[type=text]').inputValue(), 'Visa final');
  assert.equal(await p.locator('#cc-editor .cc-ed').nth(0).getByRole('button').count(), 0, 'le pré-avis n\'est pas déplaçable');
  // Simulation du circuit modifié : p_steps avec positions recalculées et motif
  await p.selectOption('#cc-kind', 'congres');
  await p.click('#cc-sim-draft');
  await p.locator('#cc-result .cc-steps').waitFor();
  const sim = (await calls(p, 'absence_circuit_simulate')).pop()[1];
  assert.equal(sim.p_kind, 'congres');
  assert.deepEqual(sim.p_steps.map((s) => [s.pos, s.kind, s.label]), [[0, 'preavis', 'Pré-avis de la direction'], [10, 'visa', 'Visa final'], [20, 'clinique', 'Validateurs de clinique'], [30, 'personnes', 'Validation de la cheffe de service']]);
  ok('édition, ordre, simulation du circuit modifié');

  // Ajout, conditions, enregistrement et erreur serveur
  await p.click('#cc-add');
  assert.equal(await p.locator('#cc-editor .cc-ed').count(), 5);
  const last = p.locator('#cc-editor .cc-ed').nth(4);
  await last.locator('input[type=text]').first().fill('ERREUR');
  await last.locator('.cc-person-list .cc-check').first().locator('input').check();
  await last.locator('input[type=number]').fill('5');
  await p.click('#cc-save');
  await p.locator('#cc-ed-msg.error').waitFor();
  assert.match(await p.locator('#cc-ed-msg').innerText(), /refusé par le serveur/);
  const bad = (await calls(p, 'absence_circuit_save')).pop()[1].p_steps.pop();
  assert.equal(bad.min_days, 5); assert.equal(bad.persons.length, 1); assert.equal(bad.kinds, null);
  await last.locator('input[type=text]').first().fill('Finances');
  await p.click('#cc-save');
  await p.locator('#cc-ed-msg.ok').waitFor();
  assert.equal(await p.locator('#cc-dirty').isVisible(), false);
  ok('ajout d\'étape, erreur serveur dans .form-msg, enregistrement');

  // Annuler les modifications
  await p.locator('#cc-editor .cc-ed').nth(1).locator('input[type=text]').fill('Autre');
  await p.click('#cc-cancel');
  assert.equal(await p.locator('#cc-editor .cc-ed').nth(1).locator('input[type=text]').inputValue(), 'Validateurs de clinique');
  ok('annulation des modifications');

  // Téléphone : aucun défilement horizontal de la page, contrôles de 40 px
  const m = await open({ width: 390, height: 844 });
  assert.ok((await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 1, 'pas de défilement horizontal');
  const h = await m.locator('#cc-editor .cc-ed').first().locator('input[type=text]').evaluate((e) => e.getBoundingClientRect().height);
  assert.ok(h >= 40, 'contrôles de 40 px');
  ok('téléphone : pas de débordement, contrôles de 40 px');
  assert.deepEqual(errors, []);
} finally { await browser.close(); server.close(); }
