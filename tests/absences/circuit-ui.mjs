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
const U3 = '33333333-3333-4333-8333-333333333333';
const altSteps = [
  { id: 11, pos: 0, kind: 'preavis', label: 'Pré-avis de la direction', rule: 'all', blocking: false, active: true, persons: [], kinds: null, min_days: null, pdf_slot: null },
  { id: 12, pos: 10, kind: 'visa', label: 'Visa de la direction', rule: 'any', blocking: true, active: true, persons: [], kinds: null, min_days: null, pdf_slot: null },
];
const circuits = [
  { id: 1, name: 'Circuit général', is_default: true, pos: 0, assignments: [], active_steps: 3, members: 1 },
  { id: 2, name: 'Cadres', is_default: false, pos: 10, assignments: [{ type: 'role', target: 'cadre', name: 'cadre' }], active_steps: 2, members: 1 },
  { id: 3, name: 'Urologie', is_default: false, pos: 20, assignments: [{ type: 'role', target: 'direction', name: 'direction' }, { type: 'clinic', target: 'Thoracique', name: 'Thoracique' }], active_steps: 2, members: 1 },
];
const overview = {
  direction: [{ id: U2, name: 'Direction Fictive', has_tool: true }], admins: [], visa_fallback_admins: false,
  clinics: [{ clinic: 'Thoracique', members: 5, validators: [], active_count: 0, goes_to: 'direction' }, { clinic: 'Urologie', members: 2, validators: [], active_count: 0, goes_to: 'direction' }],
  members: [{ id: U1, name: 'Cheffe Fictive', role: 'cadre', clinics: ['Thoracique'] }, { id: U2, name: 'Direction Fictive', role: 'direction', clinics: [] }, { id: U3, name: 'Alice Exemple', role: 'clinician', clinics: ['Thoracique'] }],
  steps, circuits, warnings: ["Circuit « Urologie » : exemple d avertissement"],
};
const who = [
  { id: U1, name: 'Cheffe Fictive', role: 'cadre', clinics: ['Thoracique'], circuit_id: 2, circuit_name: 'Cadres', reason: 'role', conflict: false },
  { id: U2, name: 'Direction Fictive', role: 'direction', clinics: ['Administration'], circuit_id: 3, circuit_name: 'Urologie', reason: 'role', conflict: false },
  { id: U3, name: 'Alice Exemple', role: 'clinician', clinics: ['Thoracique', 'Urologie'], circuit_id: 3, circuit_name: 'Urologie', reason: 'clinic', conflict: true },
  { id: 'b', name: 'Bob Exemple', role: 'clinician', clinics: ['Sénologie'], circuit_id: 1, circuit_name: 'Circuit général', reason: 'default', conflict: false },
];
const byId = (id) => circuits.find((c) => c.id === id);
const detail = (id) => { const c = byId(id); return { circuit: { id: c.id, name: c.name, is_default: c.is_default }, steps: c.is_default ? steps : altSteps, assignments: c.assignments, log: [{ id: 1, at: '2026-11-17T09:30:00Z', by_name: 'Admin Fictif', summary: 'Étapes actives : Validateurs de clinique, Visa de la direction' }] }; };
window.__calls = [];
const sb = {
  auth: { getSession: async () => ({ data: { session: { user: { id: 'me' } } } }), signOut: async () => ({ error: null }) },
  rpc: async (name, args) => {
    window.__calls.push([name, args]);
    if (name === 'current_role_name') return { data: 'admin', error: null };
    if (name === 'absence_circuit_overview') return { data: overview, error: null };
    if (name === 'absence_circuit_who') return { data: who, error: null };
    if (name === 'absence_circuit_get') return { data: detail(args.p_circuit), error: null };
    if (name === 'absence_circuit_create') { if (args.p_name === 'Doublon') return { data: null, error: { message: 'Un circuit porte déjà ce nom.' } }; const id = 10 + circuits.length; circuits.push({ id, name: args.p_name, is_default: false, pos: 100 + id, assignments: [], active_steps: 2, members: 0 }); return { data: id, error: null }; }
    if (name === 'absence_circuit_rename') { byId(args.p_circuit).name = args.p_name; return { data: null, error: null }; }
    if (name === 'absence_circuit_delete') { circuits.splice(circuits.findIndex((c) => c.id === args.p_circuit), 1); return { data: null, error: null }; }
    if (name === 'absence_circuit_reorder') { args.p_ids.forEach((id, i) => { byId(id).pos = 10 * (i + 1); }); circuits.sort((a, b) => (b.is_default - a.is_default) || a.pos - b.pos); return { data: null, error: null }; }
    if (name === 'absence_circuit_assign') {
      if (args.p_targets.includes('direction')) return { data: null, error: { message: 'La cible « direction » suit déjà le circuit « Urologie ».' } };
      const c = byId(args.p_circuit);
      c.assignments = c.assignments.filter((a) => a.type !== args.p_type).concat(args.p_targets.map((t) => ({ type: args.p_type, target: t, name: t })));
      return { data: c.assignments, error: null };
    }
    if (name === 'absence_circuit_simulate') {
      const draft = !!args.p_steps;
      return { data: { member: { name: 'Alice Exemple', role: 'clinician' }, clinics: ['Thoracique'], kind: args.p_kind,
        circuit: draft ? { id: args.p_circuit, name: byId(args.p_circuit).name, reason: 'draft', detail: null } : { id: 3, name: 'Urologie', reason: 'clinic', detail: 'Urologie' },
        resolved: { id: 3, name: 'Urologie', reason: 'clinic', detail: 'Urologie' },
        steps: [{ pos: 10, kind: 'clinique', label: 'Validateurs de clinique', rule: 'tous', blocking: true, people: [], note: null }], excluded: [], admin_override: 'Un administrateur peut valider à toute étape.', self_excluded: false }, error: null };
    }
    if (name === 'absence_circuit_save') return args.p_steps.some((s) => s.label === 'ERREUR') ? { data: null, error: { message: 'Le libellé est refusé par le serveur.' } } : { data: detail(args.p_circuit), error: null };
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
  // Sélecteur : trois circuits, le général sélectionné, pas de bloc d'attributions ni de renommage
  assert.deepEqual(await p.locator('#cc-tabs .cc-tab').allInnerTexts(), ['Circuit général', 'Cadres', 'Urologie']);
  assert.equal(await p.locator('#cc-tabs .cc-tab.active').innerText(), 'Circuit général');
  assert.equal(await p.locator('#cc-assign-box').isVisible(), false);
  assert.equal(await p.locator('#cc-rename').isVisible(), false);
  assert.equal(await p.locator('#cc-delete').isVisible(), false);
  assert.match(await p.locator('#cc-warn').innerText(), /exemple d avertissement/);
  // Schéma : étape inactive grisée, conditions affichées
  assert.equal(await p.locator('#cc-flow .cc-node.inactive').count(), 1);
  assert.match(await p.locator('#cc-flow .cc-node.inactive').innerText(), /désactivée/);
  assert.match(await p.locator('#cc-flow').innerText(), /seulement : congrès/);
  assert.match(await p.locator('#cc-flow').innerText(), /dès 10 jours ouvrables/);
  assert.equal(await p.locator('#cc-editor .cc-ed').count(), 4);
  assert.equal(await p.locator('#cc-save').isDisabled(), true);
  assert.match(await p.locator('#cc-log').innerText(), /17\.11\.2026 \d\d:\d\d · Admin Fictif/);
  ok('sélecteur, schéma, éditeur et journal affichés');

  // Édition : libellé, ordre, indicateur de modifications
  await p.locator('#cc-editor .cc-ed').nth(2).locator('input[type=text]').fill('Visa final');
  assert.equal(await p.locator('#cc-dirty').isVisible(), true);
  await p.locator('#cc-editor .cc-ed').nth(2).getByRole('button', { name: 'Monter l\'étape' }).click();
  assert.equal(await p.locator('#cc-editor .cc-ed').nth(1).locator('input[type=text]').inputValue(), 'Visa final');
  assert.equal(await p.locator('#cc-editor .cc-ed').nth(0).getByRole('button').count(), 0, 'le pré-avis n\'est pas déplaçable');
  // Simulation du circuit modifié : p_steps avec positions recalculées, motif et circuit sélectionné
  await p.selectOption('#cc-kind', 'congres');
  await p.click('#cc-sim-draft');
  await p.locator('#cc-result .cc-steps').waitFor();
  const sim = (await calls(p, 'absence_circuit_simulate')).pop()[1];
  assert.equal(sim.p_kind, 'congres'); assert.equal(sim.p_circuit, 1);
  assert.deepEqual(sim.p_steps.map((s) => [s.pos, s.kind, s.label]), [[0, 'preavis', 'Pré-avis de la direction'], [10, 'visa', 'Visa final'], [20, 'clinique', 'Validateurs de clinique'], [30, 'personnes', 'Validation de la cheffe de service']]);
  assert.match(await p.locator('#cc-result .cc-applied').innerText(), /Circuit appliqué : Circuit général \(brouillon du circuit sélectionné\)/);
  assert.match(await p.locator('#cc-result').innerText(), /suit en réalité le circuit « Urologie » \(clinique\)/);
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
  const badCall = (await calls(p, 'absence_circuit_save')).pop()[1];
  const bad = badCall.p_steps.pop();
  assert.equal(badCall.p_circuit, 1);
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

  // Circuit alternatif : son schéma, ses attributions cochées, renommage et suppression disponibles
  await p.locator('#cc-tabs .cc-tab', { hasText: 'Cadres' }).click();
  await p.locator('#cc-assign-box').waitFor({ state: 'visible' });
  assert.equal((await calls(p, 'absence_circuit_get')).pop()[1].p_circuit, 2);
  assert.match(await p.locator('#cc-flow-title').innerText(), /Cadres/);
  assert.equal(await p.locator('#cc-editor .cc-ed').count(), 2);
  assert.equal(await p.locator('#cc-rename').isVisible(), true);
  assert.deepEqual(await p.locator('#cc-as-lists legend').allInnerTexts(), ['Membres', 'Rôles', 'Cliniques']);
  assert.equal(await p.locator('#cc-as-lists .cc-as-set').nth(1).locator('.cc-check', { hasText: 'médecin cadre' }).locator('input').isChecked(), true);
  assert.match(await p.locator('#cc-as-lists .cc-as-set').nth(1).innerText(), /direction · déjà dans « Urologie »/);
  assert.equal(await p.locator('#cc-as-save').isDisabled(), true);
  ok('circuit alternatif : attributions cochées');

  // Attribution refusée par le serveur, puis enregistrement des trois listes
  const roles = p.locator('#cc-as-lists .cc-as-set').nth(1);
  await roles.locator('.cc-check', { hasText: 'direction' }).locator('input').check();
  assert.equal(await p.locator('#cc-as-save').isDisabled(), false);
  await p.click('#cc-as-save');
  await p.locator('#cc-as-msg.error').waitFor();
  assert.match(await p.locator('#cc-as-msg').innerText(), /suit déjà le circuit « Urologie »/);
  await roles.locator('.cc-check', { hasText: 'direction' }).locator('input').uncheck();
  const members = p.locator('#cc-as-lists .cc-as-set').nth(0);
  await members.locator('input[type=search]').fill('alice');
  assert.equal(await members.locator('.cc-check:visible').count(), 1);
  await members.locator('.cc-check:visible input').check();
  await p.click('#cc-as-save');
  await p.locator('#cc-as-msg.ok').waitFor();
  const asg = (await calls(p, 'absence_circuit_assign')).slice(-3).map((c) => [c[1].p_circuit, c[1].p_type, c[1].p_targets]);
  assert.deepEqual(asg, [[2, 'member', ['33333333-3333-4333-8333-333333333333']], [2, 'role', ['cadre']], [2, 'clinic', []]]);
  ok('attributions : erreur dans .form-msg, enregistrement des trois types');

  // Nouveau circuit (copie), erreur de nom, renommage, ordre, suppression
  await p.click('#cc-new');
  await p.fill('#cc-box-name', 'Doublon'); await p.locator('#cc-box button[type=submit]').click();
  await p.locator('#cc-box-msg.error').waitFor();
  assert.match(await p.locator('#cc-box-msg').innerText(), /porte déjà ce nom/);
  await p.fill('#cc-box-name', 'Nouveau test'); await p.selectOption('#cc-box-copy', '2'); await p.locator('#cc-box button[type=submit]').click();
  await p.locator('#cc-tabs .cc-tab.active', { hasText: 'Nouveau test' }).waitFor();
  const cr = (await calls(p, 'absence_circuit_create')).pop()[1];
  assert.deepEqual([cr.p_name, cr.p_copy_from], ['Nouveau test', 2]);
  assert.equal(await p.locator('#cc-box').isVisible(), false);
  await p.click('#cc-up');
  await p.locator('#cc-tabs .cc-tab').nth(2).filter({ hasText: 'Nouveau test' }).waitFor();
  const ro = (await calls(p, 'absence_circuit_reorder')).pop()[1].p_ids;
  assert.deepEqual(ro, [2, 13, 3]);
  assert.deepEqual(await p.locator('#cc-tabs .cc-tab').allInnerTexts(), ['Circuit général', 'Cadres', 'Nouveau test', 'Urologie']);
  await p.click('#cc-rename');
  assert.equal(await p.inputValue('#cc-box-name'), 'Nouveau test');
  await p.fill('#cc-box-name', 'Renommé'); await p.locator('#cc-box button[type=submit]').click();
  await p.locator('#cc-tabs .cc-tab.active', { hasText: 'Renommé' }).waitFor();
  await p.click('#cc-delete');
  await p.locator('#cc-tabs .cc-tab.active', { hasText: 'Circuit général' }).waitFor();
  assert.deepEqual(await p.locator('#cc-tabs .cc-tab').allInnerTexts(), ['Circuit général', 'Cadres', 'Urologie']);
  assert.equal((await calls(p, 'absence_circuit_delete')).pop()[1].p_circuit, 13);
  ok('nouveau circuit, renommage, ordre et suppression');

  // Qui suit quel circuit : tableau, raison, conflit, filtres
  assert.equal(await p.locator('#cc-who-table tbody tr').count(), 4);
  assert.match(await p.locator('#cc-who-table tbody tr', { hasText: 'Alice' }).innerText(), /clinique\s+conflit/);
  assert.equal(await p.locator('#cc-who-table .cc-pill.warn').count(), 1);
  assert.match(await p.locator('#cc-who-table tbody tr', { hasText: 'Cheffe' }).innerText(), /Cadres\s+rôle/);
  assert.match(await p.locator('#cc-who-table tbody tr', { hasText: 'Bob' }).innerText(), /défaut/);
  await p.fill('#cc-who-q', 'bob');
  assert.equal(await p.locator('#cc-who-table tbody tr').count(), 1);
  await p.fill('#cc-who-q', '');
  await p.selectOption('#cc-who-circuit', '3');
  assert.equal(await p.locator('#cc-who-table tbody tr').count(), 2);
  await p.selectOption('#cc-who-circuit', '');
  ok('tableau « qui suit quel circuit » : raison, conflit, filtres');

  // Simulation du circuit résolu
  await p.click('#cc-form button[type=submit]');
  await p.locator('#cc-result .cc-applied').waitFor();
  assert.match(await p.locator('#cc-result .cc-applied').innerText(), /Circuit appliqué : Urologie \(clinique : Urologie\)/);
  assert.equal((await calls(p, 'absence_circuit_simulate')).pop()[1].p_steps, undefined);
  ok('simulation : circuit appliqué et raison');

  // Téléphone : aucun défilement horizontal de la page, contrôles de 40 px
  const m = await open({ width: 390, height: 844 });
  assert.ok((await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 1, 'pas de défilement horizontal');
  await m.locator('#cc-tabs .cc-tab', { hasText: 'Cadres' }).click();
  await m.locator('#cc-assign-box').waitFor({ state: 'visible' });
  assert.ok((await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 1, 'pas de défilement horizontal avec les attributions');
  const h = await m.locator('#cc-editor .cc-ed').first().locator('input[type=text]').evaluate((e) => e.getBoundingClientRect().height);
  assert.ok(h >= 40, 'contrôles de 40 px');
  for (const sel of ['#cc-tabs .cc-tab', '#cc-new', '#cc-rename', '#cc-up', '#cc-as-save', '#cc-who-q', '#cc-who-circuit']) {
    const hh = await m.locator(sel).first().evaluate((e) => e.getBoundingClientRect().height);
    assert.ok(hh >= 39.5, sel + ' : 40 px (' + hh + ')');
  }
  ok('téléphone : pas de débordement, contrôles de 40 px');
  assert.deepEqual(errors, []);
} finally { await browser.close(); server.close(); }
