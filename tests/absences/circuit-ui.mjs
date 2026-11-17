// Page Circuit des absences : constructeur visuel (colonnes, palette, panneau, glisser-déposer), simulation en colonnes et enregistrement sur réponses simulées (aucune base distante).
// Nécessite Playwright : node tests/absences/circuit-ui.mjs (NODE_PATH vers l'installation de Playwright si besoin)
// Captures facultatives : CIRCUIT_SHOTS=/dossier node tests/absences/circuit-ui.mjs
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
const S = (o) => Object.assign({ rule: 'all', blocking: true, active: true, persons: [], roles: [], scope: 'clinic', kinds: null, min_days: null, pdf_slot: null }, o);
const steps = [
  S({ id: 1, pos: 0, col: 0, kind: 'preavis', label: 'Pré-avis de la direction', blocking: false }),
  S({ id: 2, pos: 10, col: 10, kind: 'clinique', label: 'Validateurs de clinique' }),
  S({ id: 3, pos: 20, col: 20, kind: 'visa', label: 'Visa de la direction', rule: 'any' }),
  S({ id: 4, pos: 30, col: 30, kind: 'personnes', label: 'Validation de la cheffe de service', rule: 'any', active: false, persons: [{ id: U1, name: 'Cheffe Fictive', has_tool: true }], kinds: ['congres'], min_days: 10, pdf_slot: 'chef_service' }),
];
const U3 = '33333333-3333-4333-8333-333333333333';
const altSteps = [
  S({ id: 11, pos: 0, col: 0, kind: 'preavis', label: 'Pré-avis de la direction', blocking: false }),
  S({ id: 12, pos: 10, col: 10, kind: 'visa', label: 'Visa de la direction', rule: 'any' }),
];
const stored = {};
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
const detail = (id) => { const c = byId(id); return { circuit: { id: c.id, name: c.name, is_default: c.is_default }, steps: stored[id] || (c.is_default ? steps : altSteps), assignments: c.assignments, log: [{ id: 1, at: '2026-11-17T09:30:00Z', by_name: 'Admin Fictif', summary: 'Étapes actives : Validateurs de clinique, Visa de la direction' }] }; };
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
    if (name === 'absence_circuit_assign_all') {
      if (args.p_roles.includes('direction')) return { data: null, error: { message: 'La cible « direction » suit déjà le circuit « Urologie ».' } };
      const c = byId(args.p_circuit);
      c.assignments = [].concat(args.p_members.map((t) => ({ type: 'member', target: t, name: t })), args.p_roles.map((t) => ({ type: 'role', target: t, name: t })), args.p_clinics.map((t) => ({ type: 'clinic', target: t, name: t })));
      return { data: c.assignments, error: null };
    }
    if (name === 'absence_circuit_simulate') {
      const draft = !!args.p_steps;
      const people = (n) => n.map((x) => ({ id: x, name: x }));
      const st = [
        { key: 'preavis', pos: 0, col: 0, kind: 'preavis', label: 'Pré-avis de la direction', rule: 'facultatif', blocking: false, people: people(['Direction Fictive']), note: null },
        { key: 'clinique', pos: 10, col: 10, kind: 'clinique', label: 'Validateurs de clinique', rule: 'tous doivent valider', rule_code: 'all', blocking: true, people: people(['Cadre Un', 'Cadre Deux']), note: null },
        { key: 'direction', pos: 20, col: 10, kind: 'direction', label: 'Avis de la direction', rule: 'une seule validation suffit', rule_code: 'any', blocking: false, people: people(['Direction Fictive']), note: null },
        { key: 'groupe', pos: 30, col: 20, kind: 'groupe', label: 'CDC', rule: 'une seule validation du groupe suffit', rule_code: 'any', blocking: true, people: [], note: 'Aucune personne disponible : étape sautée' },
        { key: 'visa', pos: 40, col: 30, kind: 'visa', label: 'Visa de la direction', rule: 'un seul visa suffit', rule_code: 'any', blocking: true, people: people(['Direction Fictive']), note: null },
      ];
      const columns = [{ col: 10, steps: [st[1], st[2]], note: null }, { col: 20, steps: [st[3]], note: 'Aucune personne disponible : colonne sautée' }, { col: 30, steps: [st[4]], note: null }];
      return { data: { member: { name: 'Alice Exemple', role: 'clinician' }, clinics: ['Thoracique'], kind: args.p_kind,
        circuit: draft ? { id: args.p_circuit, name: byId(args.p_circuit).name, reason: 'draft', detail: null } : { id: 3, name: 'Urologie', reason: 'clinic', detail: 'Urologie' },
        resolved: { id: 3, name: 'Urologie', reason: 'clinic', detail: 'Urologie' },
        steps: st, columns, excluded: [], admin_override: 'Un administrateur peut valider à toute étape.', self_excluded: false }, error: null };
    }
    if (name === 'absence_circuit_save') {
      if (args.p_steps.some((s) => s.label === 'ERREUR')) return { data: null, error: { message: 'Le libellé est refusé par le serveur.' } };
      stored[args.p_circuit] = args.p_steps.map((s, i) => Object.assign({ id: 100 + i }, s));
      return { data: Object.assign(detail(args.p_circuit), { warning: args.p_steps.some((s) => s.kind === 'groupe') ? 'Avertissement fictif du serveur.' : null }), error: null };
    }
    return { data: null, error: null };
  },
};
window.supabase = { createClient: () => sb };`;

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const errors = [];
let step = 0; const ok = (m) => console.log(`ok ${++step} - ${m}`);
const SHOTS = process.env.CIRCUIT_SHOTS || '';
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
  await page.locator('#cc-builder .cc-col').first().waitFor();
  return page;
}
const calls = (p, name) => p.evaluate((n) => window.__calls.filter((c) => c[0] === n), name);
const labels = (p) => p.evaluate(() => [...document.querySelectorAll('#cc-builder .cc-col')].map((c) => [...c.querySelectorAll('.cc-card-label')].map((l) => l.textContent)));
const card = (p, txt) => p.locator('#cc-builder .cc-card', { hasText: txt });
const panelBtn = (p, txt) => p.locator('#cc-panel-body button', { hasText: txt });
const palette = async (p, anchorLabel, item) => { await p.getByRole('button', { name: anchorLabel, exact: true }).click(); await p.locator('#cc-palette').waitFor({ state: 'visible' }); await p.locator('#cc-palette .cc-pal-item', { hasText: item }).click(); };

try {
  const p = await open({ width: 1280, height: 900 });
  // En-tête : pastilles, boutons d'icône ; pas de bloc d'attributions pour le circuit général
  assert.deepEqual(await p.locator('#cc-tabs .cc-tab').allInnerTexts(), ['Circuit général', 'Cadres', 'Urologie']);
  assert.equal(await p.locator('#cc-tabs .cc-tab.active').innerText(), 'Circuit général');
  assert.equal(await p.locator('#cc-assign-box').isVisible(), false);
  assert.equal(await p.locator('#cc-rename').isVisible(), false);
  assert.equal(await p.locator('#cc-delete').isVisible(), false);
  assert.ok((await p.locator('#cc-tabs').evaluate((e) => e.getBoundingClientRect().height)) < 44, 'pastilles sur une ligne');
  // Sections repliées par défaut, avec compteur
  for (const id of ['cc-warn-box', 'cc-clinics-box', 'cc-who-box', 'cc-log-box']) assert.equal(await p.locator('#' + id).evaluate((e) => e.open), false, id + ' replié');
  assert.match(await p.locator('#cc-warn-box > summary').textContent(), /Avertissements \(1\)/);
  assert.equal(await p.locator('#cc-warn').isVisible(), false);
  await p.locator('#cc-warn-box > summary').click();
  assert.match(await p.locator('#cc-warn').innerText(), /exemple d avertissement/);
  await p.locator('#cc-log-box > summary').click();
  assert.match(await p.locator('#cc-log').innerText(), /17\.11\.2026 \d\d:\d\d · Admin Fictif/);
  ok('en-tête compact, sections repliées avec compteur');

  // Constructeur : pré-avis en bande, trois colonnes, étape inactive grisée avec ses conditions
  assert.equal(await p.locator('#cc-pre input[role=switch]').isChecked(), true);
  assert.match(await p.locator('#cc-pre').innerText(), /Pré-avis de la direction \(en parallèle, consultatif\)/);
  assert.deepEqual(await labels(p), [['Validateurs de clinique'], ['Visa de la direction'], ['Validation de la cheffe de service']]);
  assert.equal(await p.locator('#cc-builder .cc-card.inactive').count(), 1);
  const inactive = await p.locator('#cc-builder .cc-card.inactive').innerText();
  assert.match(inactive, /congrès/); assert.match(inactive, /≥10 j/); assert.match(inactive, /un seul/); assert.match(inactive, /Cheffe Fictive/); assert.match(inactive, /désactivée/);
  assert.equal(await p.locator('#cc-builder .cc-gap').count(), 4);
  assert.equal(await p.locator('#cc-save').isDisabled(), true);
  ok('constructeur : colonnes, pastilles, personnes, étape grisée');

  // Panneau de réglages : libellé, indicateurs, fermeture
  await card(p, 'Validation de la cheffe').click();
  await p.locator('#cc-panel').waitFor({ state: 'visible' });
  assert.match(await p.locator('#cc-panel-title').textContent(), /Personnes désignées/);
  await p.getByLabel('Libellé de l\'étape').fill('Cheffe de service');
  assert.equal(await p.locator('#cc-dirty').isVisible(), true);
  assert.equal(await card(p, 'Cheffe de service').count(), 1);
  assert.equal(await p.locator('#cc-panel-body .cc-person-list .cc-check').count(), 3);
  assert.equal(await p.locator('#cc-panel-body .cc-check', { hasText: 'Cheffe Fictive' }).locator('input').isChecked(), true);
  await p.keyboard.press('Escape');
  assert.equal(await p.locator('#cc-panel').isVisible(), false);
  await p.click('#cc-cancel');
  assert.deepEqual(await labels(p), [['Validateurs de clinique'], ['Visa de la direction'], ['Validation de la cheffe de service']]);
  assert.equal(await p.locator('#cc-dirty').isVisible(), false);
  ok('panneau de réglages et annulation');

  // Déplacement par les boutons : avec la colonne précédente, puis colonne suivante
  await card(p, 'Visa de la direction').click();
  assert.equal(await panelBtn(p, '← colonne précédente').isEnabled(), true);
  await panelBtn(p, 'avec la colonne précédente').click();
  assert.deepEqual(await labels(p), [['Validateurs de clinique', 'Visa de la direction'], ['Validation de la cheffe de service']]);
  assert.equal(await p.locator('#cc-panel-body .cc-field', { hasText: 'Règle' }).count(), 0, 'visa : ni règle ni type d\'avis');
  await panelBtn(p, 'colonne suivante →').click();
  assert.deepEqual(await labels(p), [['Validateurs de clinique'], ['Visa de la direction'], ['Validation de la cheffe de service']]);
  await p.keyboard.press('Escape');
  ok('déplacement par les boutons du panneau');

  // Glisser-déposer : la cheffe de service vers l'espace entre les deux premières colonnes
  await card(p, 'Validation de la cheffe').dragTo(p.locator('#cc-builder .cc-gap').nth(1));
  assert.deepEqual(await labels(p), [['Validateurs de clinique'], ['Validation de la cheffe de service'], ['Visa de la direction']]);
  // puis sur une carte : insérée avant elle, dans sa colonne
  await card(p, 'Validation de la cheffe').dragTo(card(p, 'Visa de la direction'));
  assert.deepEqual(await labels(p), [['Validateurs de clinique'], ['Validation de la cheffe de service', 'Visa de la direction']]);
  await card(p, 'Validation de la cheffe').dragTo(p.locator('#cc-builder .cc-gap').nth(1));
  assert.deepEqual(await labels(p), [['Validateurs de clinique'], ['Validation de la cheffe de service'], ['Visa de la direction']]);
  ok('glisser-déposer vers une colonne et entre deux colonnes');

  // Palette : types uniques grisés ; étape simultanée dans la colonne de la clinique
  await p.getByRole('button', { name: 'Ajouter une étape simultanée dans la colonne 1', exact: true }).click();
  assert.equal(await p.locator('#cc-palette .cc-pal-item').count(), 5);
  assert.equal(await p.locator('#cc-palette .cc-pal-item', { hasText: 'Validateurs de clinique' }).isDisabled(), true);
  assert.equal(await p.locator('#cc-palette .cc-pal-item', { hasText: 'Visa de la direction' }).isDisabled(), true);
  assert.equal(await p.locator('#cc-palette .cc-pal-item', { hasText: 'Direction' }).first().isEnabled(), true);
  await p.locator('#cc-palette .cc-pal-item', { hasText: 'Direction' }).first().click();
  assert.deepEqual((await labels(p))[0], ['Validateurs de clinique', 'Direction']);
  assert.equal(await p.locator('#cc-panel').isVisible(), true);
  await p.getByLabel('Libellé de l\'étape').fill('ERREUR');
  // groupe par rôle dans une nouvelle colonne en fin de rangée
  await p.keyboard.press('Escape');
  await palette(p, 'Ajouter une colonne à la fin', 'Groupe par rôle');
  assert.deepEqual((await labels(p)).at(-1), ['Groupe par rôle']);
  await p.getByLabel('Libellé de l\'étape').fill('CDC et cadres');
  await p.locator('#cc-panel-body .cc-check', { hasText: 'Étape active' }).locator('input').check();
  await p.click('#cc-save');
  assert.match(await p.locator('#cc-ed-msg').innerText(), /cochez au moins un rôle/);
  await p.locator('#cc-panel-body .cc-check', { hasText: /^CDC$/ }).locator('input').check();
  await p.locator('#cc-panel-body .cc-check', { hasText: 'médecin cadre' }).locator('input').check();
  await p.locator('#cc-panel-body .cc-field', { hasText: 'Périmètre' }).locator('select').selectOption('all');
  await p.locator('#cc-panel-body .cc-field', { hasText: 'Règle' }).locator('select').selectOption('any');
  assert.match(await card(p, 'CDC et cadres').innerText(), /CDC, médecin cadre · tout le service/);
  await p.keyboard.press('Escape');
  ok('palette : types uniques grisés, étape simultanée, groupe par rôle');

  // Simulation du brouillon : colonnes, noms réels et notes
  await p.selectOption('#cc-kind', 'congres');
  await p.click('#cc-sim-draft');
  await p.locator('#cc-result .cc-col').first().waitFor();
  const sim = (await calls(p, 'absence_circuit_simulate')).pop()[1];
  assert.equal(sim.p_kind, 'congres'); assert.equal(sim.p_circuit, 1);
  assert.deepEqual(sim.p_steps.map((s) => [s.pos, s.col, s.kind, s.label]), [[0, 0, 'preavis', 'Pré-avis de la direction'], [10, 10, 'clinique', 'Validateurs de clinique'], [20, 10, 'direction', 'ERREUR'],
    [30, 20, 'personnes', 'Validation de la cheffe de service'], [40, 30, 'visa', 'Visa de la direction'], [50, 40, 'groupe', 'CDC et cadres']]);
  const grp = sim.p_steps.at(-1);
  assert.deepEqual([grp.roles, grp.scope, grp.rule, grp.active], [['cdc', 'cadre'], 'all', 'any', true]);
  assert.equal(await p.locator('#cc-result .cc-col').count(), 3);
  assert.equal(await p.locator('#cc-result .cc-col').first().locator('.cc-card').count(), 2);
  assert.match(await p.locator('#cc-result .cc-col').first().innerText(), /Cadre Un, Cadre Deux/);
  assert.match(await p.locator('#cc-result .cc-col').first().innerText(), /consultative/);
  assert.match(await p.locator('#cc-result').innerText(), /étape sautée/);
  assert.match(await p.locator('#cc-result').innerText(), /colonne sautée/);
  assert.match(await p.locator('#cc-result .cc-pre').innerText(), /Direction Fictive/);
  assert.match(await p.locator('#cc-result .cc-applied').innerText(), /Circuit appliqué : Circuit général \(brouillon du circuit sélectionné\)/);
  assert.match(await p.locator('#cc-result').innerText(), /suit en réalité le circuit « Urologie » \(clinique\)/);
  ok('simulation du brouillon en colonnes');

  // Enregistrement : erreur serveur dans .form-msg, puis succès et avertissement
  await p.click('#cc-save');
  await p.locator('#cc-ed-msg.error').waitFor();
  assert.match(await p.locator('#cc-ed-msg').innerText(), /refusé par le serveur/);
  await card(p, 'ERREUR').click();
  await p.getByLabel('Libellé de l\'étape').fill('Avis de la direction');
  await p.keyboard.press('Escape');
  await p.click('#cc-save');
  await p.locator('#cc-ed-msg.ok').waitFor();
  assert.match(await p.locator('#cc-ed-msg').innerText(), /Circuit enregistré\. Avertissement fictif du serveur\./);
  const saved = (await calls(p, 'absence_circuit_save')).pop()[1];
  assert.equal(saved.p_circuit, 1);
  assert.deepEqual(saved.p_steps.map((s) => [s.pos, s.col, s.kind]), [[0, 0, 'preavis'], [10, 10, 'clinique'], [20, 10, 'direction'], [30, 20, 'personnes'], [40, 30, 'visa'], [50, 40, 'groupe']]);
  assert.deepEqual(saved.p_steps[3].persons, ['11111111-1111-4111-8111-111111111111']);
  assert.equal(saved.p_steps[3].pdf_slot, 'chef_service'); assert.deepEqual(saved.p_steps[3].kinds, ['congres']); assert.equal(saved.p_steps[3].min_days, 10);
  assert.equal(await p.locator('#cc-dirty').isVisible(), false);
  assert.deepEqual(await labels(p), [['Validateurs de clinique', 'Avis de la direction'], ['Validation de la cheffe de service'], ['Visa de la direction'], ['CDC et cadres']]);
  if (SHOTS) {
    await p.locator('#cc-form button[type=submit]').click();
    await p.locator('#cc-result .cc-col').first().waitFor();
    await p.screenshot({ path: SHOTS + '/circuit-1280.png', fullPage: true });
    await card(p, 'CDC et cadres').click();
    await p.screenshot({ path: SHOTS + '/circuit-1280-panneau.png' });
    await p.keyboard.press('Escape');
  }
  ok('enregistrement : erreur serveur, succès, avertissement, charge utile');

  // Suppression d'une étape depuis le panneau, puis annulation
  await card(p, 'CDC et cadres').click();
  await p.getByRole('button', { name: 'Supprimer l\'étape' }).click();
  assert.equal(await card(p, 'CDC et cadres').count(), 0);
  assert.equal(await p.locator('#cc-panel').isVisible(), false);
  assert.equal(await p.locator('#cc-dirty').isVisible(), true);
  await p.click('#cc-cancel');
  assert.equal(await card(p, 'CDC et cadres').count(), 1);
  ok('suppression depuis le panneau et annulation');

  // Circuit alternatif : son schéma, ses attributions cochées, renommage et suppression disponibles
  await p.locator('#cc-tabs .cc-tab', { hasText: 'Cadres' }).click();
  await p.locator('#cc-assign-box').waitFor({ state: 'visible' });
  assert.equal((await calls(p, 'absence_circuit_get')).pop()[1].p_circuit, 2);
  assert.match(await p.locator('#cc-flow-title').textContent(), /Cadres/);
  assert.deepEqual(await labels(p), [['Visa de la direction']]);
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
  const asg = (await calls(p, 'absence_circuit_assign_all')).pop()[1];
  assert.deepEqual(asg, { p_circuit: 2, p_members: ['33333333-3333-4333-8333-333333333333'], p_roles: ['cadre'], p_clinics: [] });
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
  await card(p, 'Visa de la direction').click();
  await p.getByLabel('Libellé de l\'étape').fill('Édition en cours');
  await p.keyboard.press('Escape');
  await p.click('#cc-rename');
  assert.equal(await p.inputValue('#cc-box-name'), 'Nouveau test');
  await p.fill('#cc-box-name', 'Renommé'); await p.locator('#cc-box button[type=submit]').click();
  await p.locator('#cc-tabs .cc-tab.active', { hasText: 'Renommé' }).waitFor();
  assert.equal(await card(p, 'Édition en cours').count(), 1, 'le renommage garde les modifications');
  await p.click('#cc-delete');
  await p.locator('#cc-tabs .cc-tab.active', { hasText: 'Circuit général' }).waitFor();
  assert.deepEqual(await p.locator('#cc-tabs .cc-tab').allInnerTexts(), ['Circuit général', 'Cadres', 'Urologie']);
  assert.equal((await calls(p, 'absence_circuit_delete')).pop()[1].p_circuit, 13);
  ok('nouveau circuit, renommage, ordre et suppression');

  // Qui suit quel circuit : section repliée, tableau, raison, conflit, filtres
  assert.match(await p.locator('#cc-who-box > summary').textContent(), /Qui suit quel circuit \(4\)/);
  await p.locator('#cc-who-box > summary').click();
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

  // Téléphone : colonnes empilées, aucun défilement horizontal de la page, contrôles de 40 px, feuille en bas d'écran
  const m = await open({ width: 390, height: 844 });
  const overflow = async (msg) => assert.ok((await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 1, msg);
  await overflow('pas de défilement horizontal');
  const boxes = await m.evaluate(() => [...document.querySelectorAll('#cc-builder .cc-col')].map((c) => { const r = c.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width)]; }));
  assert.equal(boxes.length, 3);
  assert.ok(boxes[1][1] > boxes[0][1] && boxes[2][1] > boxes[1][1] && boxes[0][0] === boxes[1][0], 'colonnes empilées');
  assert.ok(boxes[0][2] <= 390, 'colonne dans l\'écran');
  for (const sel of ['#cc-tabs .cc-tab', '#cc-new', '.cc-plus', '.cc-add', '#cc-save', '#cc-cancel', '#cc-sim-draft', '#cc-pre .cc-switch', '#cc-form select', '#cc-form input']) {
    const hh = await m.locator(sel).first().evaluate((e) => e.getBoundingClientRect().height);
    assert.ok(hh >= 39.5, sel + ' : 40 px (' + hh + ')');
  }
  await card(m, 'Validation de la cheffe').click();
  await m.locator('#cc-panel').waitFor({ state: 'visible' });
  const pr = await m.locator('#cc-panel').evaluate((e) => { const r = e.getBoundingClientRect(); return [r.left, r.right, r.bottom, window.innerWidth, window.innerHeight]; });
  assert.deepEqual([pr[0], pr[1], pr[2]], [0, 390, 844], 'feuille en bas d\'écran');
  for (const sel of ['#cc-panel-body input[type=text]', '#cc-panel-body select', '#cc-panel-body .cc-check', '#cc-panel-body .cc-moves button', '#cc-panel-close']) {
    const hh = await m.locator(sel).first().evaluate((e) => e.getBoundingClientRect().height);
    assert.ok(hh >= 39.5, sel + ' : 40 px (' + hh + ')');
  }
  await overflow('pas de défilement horizontal avec le panneau');
  await m.locator('#cc-scrim').click({ position: { x: 10, y: 10 } });
  assert.equal(await m.locator('#cc-panel').isVisible(), false);
  await m.locator('#cc-who-box > summary').click();
  await m.locator('#cc-warn-box > summary').click();
  await m.locator('#cc-clinics-box > summary').click();
  await m.locator('#cc-tabs .cc-tab', { hasText: 'Cadres' }).click();
  await m.locator('#cc-assign-box').waitFor({ state: 'visible' });
  await overflow('pas de défilement horizontal avec les attributions et les tableaux');
  for (const sel of ['#cc-rename', '#cc-up', '#cc-as-save', '#cc-who-q', '#cc-who-circuit']) {
    const hh = await m.locator(sel).first().evaluate((e) => e.getBoundingClientRect().height);
    assert.ok(hh >= 39.5, sel + ' : 40 px (' + hh + ')');
  }
  if (SHOTS) {
    await m.locator('#cc-tabs .cc-tab', { hasText: 'Circuit général' }).click();
    await m.locator('#cc-assign-box').waitFor({ state: 'hidden' });
    await m.locator('#cc-who-box > summary').click();
    await m.locator('#cc-warn-box > summary').click();
    await m.locator('#cc-clinics-box > summary').click();
    await m.locator('#cc-form button[type=submit]').click();
    await m.locator('#cc-result .cc-col').first().waitFor();
    await m.screenshot({ path: SHOTS + '/circuit-390.png', fullPage: true });
    await card(m, 'Validation de la cheffe').click();
    await m.screenshot({ path: SHOTS + '/circuit-390-panneau.png' });
  }
  ok('téléphone : colonnes empilées, pas de débordement, contrôles de 40 px, feuille en bas');
  assert.deepEqual(errors, []);
} finally { await browser.close(); server.close(); }
