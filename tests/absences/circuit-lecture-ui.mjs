// Circuit de validation en lecture pour un médecin cadre (/admin/circuit-absences.html) et « Mon circuit de validation » (/app/absences.html).
// Serveur statique et réponses simulées (aucune base distante, données fictives). Nécessite Playwright :
//   NODE_PATH=/opt/node-tools/node_modules node tests/absences/circuit-lecture-ui.mjs      (captures : SHOTS_DIR=/dossier)
import http from 'node:http';
import { createRequire } from 'node:module';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { console.log('Playwright absent : test de navigateur ignoré.'); process.exit(0); }
const ROOT = new URL('../../', import.meta.url).pathname;
const SHOTS = process.env.SHOTS_DIR || '';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const server = http.createServer(async (req, res) => {
  const file = normalize(join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
  if (!file.startsWith(ROOT)) { res.statusCode = 403; return res.end(); }
  try { res.setHeader('content-type', TYPES[extname(file)] || 'application/octet-stream'); res.end(await readFile(file)); } catch { res.statusCode = 404; res.end('404'); }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const BASE = `http://127.0.0.1:${server.address().port}`;

// Simulation commune : colonnes, noms, notes ; `more` = personnes non listées (mon circuit)
const SIM = `
const SIMRES = (kind, extra) => {
  const P = (n) => n.map((x) => ({ name: x }));
  const st = [
    { key: 'preavis', pos: 0, col: 0, kind: 'preavis', label: 'Pré-avis de la direction', rule: 'facultatif', blocking: false, people: P(['Direction Fictive']), note: null },
    { key: 'clinique', pos: 10, col: 10, kind: 'clinique', label: 'Validateurs de clinique', rule: 'tous doivent valider', rule_code: 'all', blocking: true, people: P(['Cadre Un', 'Cadre Deux']), more: 0, note: null },
    { key: 'direction', pos: 20, col: 10, kind: 'direction', label: 'Avis de la direction', rule: 'une seule validation suffit', rule_code: 'any', blocking: false, people: P(['Direction Fictive']), more: 0, note: null },
    { key: 'groupe', pos: 30, col: 20, kind: 'groupe', label: 'Médecins du service', rule: 'une seule validation du groupe suffit', rule_code: 'any', blocking: true, people: P(['Alice Exemple', 'Bob Exemple', 'Carla Exemple']), more: 14, note: null },
    { key: 'visa', pos: 40, col: 30, kind: 'visa', label: 'Visa de la direction', rule: 'un seul visa suffit', rule_code: 'any', blocking: true, people: P(['Direction Fictive']), more: 0, note: null },
  ];
  const columns = [{ col: 10, steps: [st[1], st[2]], note: null }, { col: 20, steps: [st[3]], note: null }, { col: 30, steps: [st[4]], note: null }];
  return Object.assign({ member: { id: 'x', name: 'Alice Exemple', role: 'clinician' }, clinics: ['Thoracique'], kind, circuit: { id: 3, name: 'Urologie', reason: 'clinic', detail: 'Urologie' },
    resolved: { id: 3, name: 'Urologie', reason: 'clinic', detail: 'Urologie' }, steps: st, columns, excluded: [], self_excluded: false }, extra || {});
};`;

// ----- Page du circuit, vue par un médecin cadre -----
const MOCK_CIRCUIT = SIM + `
const U1 = '11111111-1111-4111-8111-111111111111', U3 = '33333333-3333-4333-8333-333333333333';
const S = (o) => Object.assign({ rule: 'all', blocking: true, active: true, persons: [], roles: [], scope: 'clinic', kinds: null, min_days: null, pdf_slot: null }, o);
const steps = [
  S({ id: 1, pos: 0, col: 0, kind: 'preavis', label: 'Pré-avis de la direction', blocking: false }),
  S({ id: 2, pos: 10, col: 10, kind: 'clinique', label: 'Validateurs de clinique' }),
  S({ id: 3, pos: 20, col: 20, kind: 'visa', label: 'Visa de la direction', rule: 'any' }),
  S({ id: 4, pos: 30, col: 30, kind: 'personnes', label: 'Validation de la cheffe de service', rule: 'any', persons: [{ id: U1, name: 'Cheffe Fictive', has_tool: true }], kinds: ['congres'], min_days: 10 }),
];
const circuits = [
  { id: 1, name: 'Circuit général', is_default: true, pos: 0, assignments: [], active_steps: 3, members: 1 },
  { id: 2, name: 'Cadres', is_default: false, pos: 10, assignments: [{ type: 'role', target: 'cadre', name: 'cadre' }, { type: 'member', target: U3, name: 'Alice Exemple' }], active_steps: 2, members: 1 },
];
const overview = { direction: [{ id: 'd', name: 'Direction Fictive', has_tool: true }], admins: [], visa_fallback_admins: false,
  clinics: [{ clinic: 'Thoracique', members: 5, validators: [{ id: U1, name: 'Cheffe Fictive', role: 'cadre', active: true }], active_count: 1, goes_to: 'validators' }],
  members: [{ id: U1, name: 'Cheffe Fictive', role: 'cadre', clinics: ['Thoracique'] }, { id: U3, name: 'Alice Exemple', role: 'clinician', clinics: ['Thoracique'] }],
  steps, circuits, warnings: ["Circuit « Cadres » : exemple d avertissement"] };
const who = [{ id: U3, name: 'Alice Exemple', role: 'clinician', clinics: ['Thoracique'], circuit_id: 2, circuit_name: 'Cadres', reason: 'member', conflict: false }];
window.__calls = [];
const sb = { auth: { getSession: async () => ({ data: { session: { user: { id: 'me' } } } }), signOut: async () => ({ error: null }) },
  rpc: async (name, args) => {
    window.__calls.push([name, args]);
    const detail = (id) => ({ circuit: { id, name: circuits.find((c) => c.id === id).name, is_default: id === 1 }, steps: id === 1 ? steps : steps.slice(0, 3), assignments: circuits.find((c) => c.id === id).assignments,
      log: [{ id: 1, at: '2026-11-17T09:30:00Z', by_name: 'Admin Fictif', summary: 'Étapes actives : Validateurs de clinique, Visa de la direction' }] });
    if (name === 'current_role_name') return { data: 'cadre', error: null };
    if (name === 'absence_circuit_overview') return { data: overview, error: null };
    if (name === 'absence_circuit_who') return { data: who, error: null };
    if (name === 'absence_circuit_get') return { data: detail(args.p_circuit || 1), error: null };
    if (name === 'absence_circuit_simulate') return { data: SIMRES(args.p_kind, { admin_override: 'Un administrateur peut valider à toute étape ; sa validation conclut la demande.' }), error: null };
    return { data: null, error: { message: 'Réservé à l administration.' } };
  } };
window.supabase = { createClient: () => sb };`;

// ----- Page Absences : médecin cadre / assistant / secrétaire -----
const MOCK_ABS = (role, secOf) => SIM + `
window.__calls = [];
const ROLE = ${JSON.stringify(role)}, SECOF = ${JSON.stringify(secOf)};
const P = (id, name, clinics, me) => ({ id, name, role: 'clinician', clinics, is_me: !!me });
const people = [P('me', 'Moi Fictif', ['Thoracique'], true), P('dr', 'Dr Fictif', ['Urologie'])];
const rpc = async (name, args) => {
  window.__calls.push({ name, args });
  const ok = (data) => ({ data, error: null });
  switch (name) {
    case 'absence_context': return ok({ me: 'me', role: ROLE, clinics: ['Thoracique'], validates: ROLE === 'cadre' ? ['Thoracique'] : [], pending: 0 });
    case 'absence_people': return ok(people);
    case 'absence_clinics': return ok([{ clinic: 'Thoracique', max_absent: 2 }, { clinic: 'Urologie', max_absent: 2 }]);
    case 'absence_grid': case 'absence_calendar': case 'absence_list': case 'absence_approvals_all': case 'absence_rejected_to_manage': case 'absence_to_validate': return ok([]);
    case 'absence_pending_count': return ok(0);
    case 'absence_agenda_context': return SECOF.length ? ok({ tab: false, secretary_of: SECOF }) : { data: null, error: { message: 'absent' } };
    case 'absence_notification_status': return ok({ pending: 0, failed: 0, sent: 0 });
    case 'absence_circuit_mine': {
      const forDr = args.p_user === 'dr';
      return ok(SIMRES(args.p_kind, { days: args.p_days, from: '2026-11-30', to: '2026-12-04', member: { id: forDr ? 'dr' : 'me', name: forDr ? 'Dr Fictif' : 'Moi Fictif', role: 'clinician' },
        circuit: forDr ? { id: 2, name: 'Cadres', reason: 'member', detail: 'Dr Fictif' } : { id: 3, name: 'Urologie', reason: 'clinic', detail: 'Urologie' } }));
    }
    default: return ok(null);
  }
};
window.supabase = { createClient: () => ({
  auth: { getSession: async () => ({ data: { session: { user: { id: 'me' } } } }), signOut: async () => ({ error: null }) },
  rpc, functions: { invoke: async () => ({ data: null, error: null }) },
  from: () => { const q = { select: () => q, eq: () => q, single: async () => ({ data: { role: ROLE } }), then: (r) => Promise.resolve({ data: [], error: null }).then(r) }; return q; } }) };`;

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const errors = [];
let step = 0; const ok = (m) => console.log(`ok ${++step} - ${m}`);
const shot = async (page, name, full = true) => { if (SHOTS) { await mkdir(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, name + '.png'), fullPage: full }); } };
const calls = (p, name) => p.evaluate((n) => window.__calls.filter((c) => (Array.isArray(c) ? c[0] : c.name) === n), name);
async function ctxPage(viewport, mock, url) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2 });
  await ctx.clock.setFixedTime(new Date('2026-11-23T10:00:00'));
  await ctx.addInitScript(mock);
  await ctx.route('**/*', (r) => (r.request().url().startsWith(BASE) ? r.continue() : r.abort()));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on('dialog', (d) => d.dismiss());
  await page.goto(BASE + url);
  return page;
}
const noHScroll = async (p, msg) => assert.ok((await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 1, msg);

try {
  // ===== Circuit en lecture, 1280 px =====
  let p = await ctxPage({ width: 1280, height: 900 }, MOCK_CIRCUIT, '/admin/circuit-absences.html');
  await p.locator('#cc-tool').waitFor({ state: 'visible' });
  await p.locator('#cc-builder .cc-col').first().waitFor();
  assert.equal(await p.locator('#cc-ro-note').isVisible(), true);
  assert.match(await p.locator('#cc-ro-note').innerText(), /Lecture seule : seuls l'administration et la direction modifient le circuit/);
  for (const id of ['cc-new', 'cc-rename', 'cc-delete', 'cc-up', 'cc-down', 'cc-save', 'cc-cancel', 'cc-sim-draft', 'cc-as-save', 'cc-box']) assert.equal(await p.locator('#' + id).isVisible(), false, id + ' masqué');
  assert.equal(await p.locator('.cc-plus, .cc-add').count(), 0, 'aucun point d\'insertion ni ajout d\'étape');
  assert.equal(await p.locator('#cc-builder .cc-card[draggable=true]').count(), 0, 'aucune carte déplaçable');
  assert.equal(await p.locator('#cc-pre input[role=switch]').isDisabled(), true);
  assert.deepEqual(await p.locator('#cc-tabs .cc-tab').allInnerTexts(), ['Circuit général', 'Cadres']);
  assert.equal(await p.locator('#cc-builder .cc-col').count(), 3);
  assert.equal(await p.locator('#cc-builder .cc-gap').count(), 2);
  assert.match(await p.locator('#cc-back').innerText(), /Absences/);
  assert.equal(await p.locator('#cc-back').getAttribute('href'), '/app/absences.html');
  ok('cadre : bandeau de lecture seule, aucun bouton d\'écriture, aucune palette ni glisser-déposer');

  // Panneau d'une étape : lecture, champs verrouillés, ni position ni suppression
  await p.locator('#cc-builder .cc-card', { hasText: 'Validation de la cheffe' }).click();
  await p.locator('#cc-panel').waitFor({ state: 'visible' });
  assert.equal(await p.locator('#cc-panel-body button').count(), 0, 'aucun bouton dans le panneau');
  const enabled = await p.locator('#cc-panel-body input:not([type=search]), #cc-panel-body select').evaluateAll((l) => l.filter((e) => !e.disabled).length);
  assert.equal(enabled, 0, 'tous les champs verrouillés');
  assert.match(await p.locator('#cc-panel-body').innerText(), /Cheffe Fictive/);
  assert.equal(await p.locator('#cc-panel-body .cc-person-list .cc-check').count(), 1, 'seulement la personne désignée');
  await shot(p, 'circuit-cadre-1280-panneau', false);
  await p.keyboard.press('Escape');
  ok('cadre : panneau d\'étape en lecture, champs désactivés');

  // Attributions en lecture ; simulateur sur le circuit enregistré
  await p.locator('#cc-tabs .cc-tab', { hasText: 'Cadres' }).click();
  await p.locator('#cc-assign-box').waitFor({ state: 'visible' });
  const boxes = await p.locator('#cc-as-lists input[type=checkbox]').evaluateAll((l) => l.map((e) => [e.checked, e.disabled]));
  assert.ok(boxes.length === 2 && boxes.every(([c, d]) => c && d), 'seules les cibles attribuées, cases verrouillées');
  await p.locator('#cc-tabs .cc-tab', { hasText: 'Circuit général' }).click();
  await p.click('#cc-form button[type=submit]');
  await p.locator('#cc-result .cc-col').first().waitFor();
  assert.match(await p.locator('#cc-result .cc-applied').innerText(), /Circuit appliqué : Urologie \(clinique : Urologie\)/);
  assert.equal((await calls(p, 'absence_circuit_simulate')).pop()[1].p_steps, undefined, 'jamais de brouillon');
  assert.match(await p.locator('#cc-result').innerText(), /et 14 autres/);
  await p.locator('#cc-who-box > summary').click();
  await p.locator('#cc-log-box > summary').click();
  await p.locator('#cc-warn-box > summary').click();
  await shot(p, 'circuit-cadre-1280');
  const writes = (await p.evaluate(() => window.__calls.map((c) => c[0]))).filter((n) => /save|create|rename|delete|reorder|assign/.test(n));
  assert.deepEqual(writes, [], 'aucun appel d\'écriture');
  ok('cadre : attributions verrouillées, simulation du circuit enregistré, aucun appel d\'écriture');
  await p.context().close();

  // ===== Mon circuit, 1280 px, médecin cadre =====
  p = await ctxPage({ width: 1280, height: 900 }, MOCK_ABS('cadre', []), '/app/absences.html');
  await p.locator('#ab-tool').waitFor({ state: 'visible' });
  await p.locator('#ab-scroll table').waitFor();
  const blk = p.locator('#ab-circuit');
  await blk.waitFor();
  assert.equal(await blk.evaluate((e) => e.open), true, 'ouvert sur grand écran');
  assert.equal(await p.locator('#ab-p-plan #ab-circuit').count(), 1, 'dans l\'onglet Planning');
  await p.locator('#ab-circuit-flow .cc-col').first().waitFor();
  assert.equal(await p.locator('#ab-circuit-flow .cc-col').count(), 3);
  assert.match(await blk.innerText(), /mon circuit de validation/i);
  assert.match(await p.locator('#ab-circuit-info').innerText(), /Circuit qui s'appliquerait à une demande de 5 jours ouvrables à partir du 30\.11\.2026 ; les étapes conditionnelles peuvent varier selon le motif et la durée\./);
  assert.match(await p.locator('#ab-circuit-flow .cc-applied').innerText(), /Circuit appliqué : Urologie \(clinique : Urologie\)/);
  assert.match(await p.locator('#ab-circuit-flow').innerText(), /Alice Exemple, Bob Exemple, Carla Exemple et 14 autres/);
  assert.match(await p.locator('#ab-circuit-flow .cc-pre').innerText(), /Direction Fictive/);
  assert.match(await p.locator('#ab-circuit-link a').innerText(), /Voir le circuit de validation/);
  assert.equal(await p.locator('#ab-circuit-link a').getAttribute('href'), '/admin/circuit-absences.html');
  assert.equal(await p.locator('#ab-circuit-link').isVisible(), true);
  assert.equal(await p.locator('#ab-circuit-flow button, #ab-circuit-flow input').count(), 0, 'lecture seule');
  const first = (await calls(p, 'absence_circuit_mine'))[0].args;
  assert.deepEqual(first, { p_user: null, p_kind: 'vacances', p_days: 5 });
  await p.selectOption('#ab-circuit-kind', 'congres');
  await p.waitForFunction(() => window.__calls.some((c) => c.name === 'absence_circuit_mine' && c.args.p_kind === 'congres'));
  await p.fill('#ab-circuit-days', '12'); await p.locator('#ab-circuit-days').dispatchEvent('change');
  await p.waitForFunction(() => window.__calls.some((c) => c.name === 'absence_circuit_mine' && c.args.p_days === 12));
  await p.fill('#ab-circuit-days', '80'); await p.locator('#ab-circuit-days').dispatchEvent('change');
  assert.match(await p.locator('#ab-circuit-msg').innerText(), /1 à 60/);
  assert.equal((await calls(p, 'absence_circuit_mine')).filter((c) => c.args.p_days === 80).length, 0, 'durée hors limites : aucun appel');
  await p.fill('#ab-circuit-days', '5'); await p.locator('#ab-circuit-days').dispatchEvent('change');
  await p.selectOption('#ab-circuit-kind', 'vacances');
  await p.locator('#ab-circuit-flow .cc-col').first().waitFor();
  await noHScroll(p, 'planning : pas de défilement horizontal');
  await shot(p, 'mon-circuit-1280');
  await shot(p, 'mon-circuit-1280-bloc', false);
  ok('1280 px, Planning : bloc ouvert, schéma, phrase, motif et durée, lien du cadre');

  // Même bloc dans Mes absences ; état mémorisé après fermeture
  await p.locator('#ab-t-mine').click();
  assert.equal(await p.locator('#ab-p-mine #ab-circuit').count(), 1, 'dans l\'onglet Mes absences');
  assert.equal(await p.locator('#ab-p-plan #ab-circuit').count(), 0);
  await p.locator('#ab-circuit > summary').click();
  assert.equal(await blk.evaluate((e) => e.open), false);
  assert.equal(await p.evaluate(() => localStorage.getItem('onconic.absences.circuit.v1')), 'closed');
  await p.reload();
  await p.locator('#ab-tool').waitFor({ state: 'visible' });
  assert.equal(await p.locator('#ab-circuit').evaluate((e) => e.open), false, 'fermé après rechargement');
  await noHScroll(p, 'mes absences : pas de défilement horizontal');
  ok('Mes absences : même bloc, état mémorisé dans localStorage');
  await p.context().close();

  // ===== Téléphone : fermé par défaut, ouvert au geste, sans défilement horizontal de la page =====
  p = await ctxPage({ width: 390, height: 844 }, MOCK_ABS('clinician', []), '/app/absences.html');
  await p.locator('#ab-tool').waitFor({ state: 'visible' });
  await p.locator('#ab-circuit').waitFor();
  assert.equal(await p.locator('#ab-circuit').evaluate((e) => e.open), false, 'fermé sur mobile');
  assert.equal((await calls(p, 'absence_circuit_mine')).length, 0, 'rien de chargé tant que le bloc est fermé');
  assert.equal(await p.locator('#ab-circuit-link').isVisible(), false, 'lien réservé aux médecins cadres');
  await p.locator('#ab-circuit > summary').click();
  await p.locator('#ab-circuit-flow .cc-col').first().waitFor();
  assert.equal(await p.evaluate(() => localStorage.getItem('onconic.absences.circuit.v1')), 'open');
  await noHScroll(p, 'mobile : pas de défilement horizontal');
  const cols = await p.evaluate(() => [...document.querySelectorAll('#ab-circuit-flow .cc-col')].map((c) => { const r = c.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right)]; }));
  assert.ok(cols.every(([l, r]) => l >= 0 && r <= 390), 'colonnes dans l\'écran');
  await p.locator('#ab-circuit').scrollIntoViewIfNeeded();
  await shot(p, 'mon-circuit-390');
  await p.locator('#ab-t-mine').click();
  assert.equal(await p.locator('#ab-p-mine #ab-circuit').count(), 1);
  await noHScroll(p, 'mobile, Mes absences : pas de défilement horizontal');
  ok('390 px : fermé par défaut, ouvert au geste, colonnes dans l\'écran, aucun défilement horizontal');
  await p.context().close();

  // ===== Secrétaire de médecin cadre : circuit du cadre choisi =====
  p = await ctxPage({ width: 1280, height: 900 }, MOCK_ABS('assistant', [{ id: 'dr', name: 'Dr Fictif' }]), '/app/absences.html');
  await p.locator('#ab-tool').waitFor({ state: 'visible' });
  await p.locator('#ab-circuit-flow .cc-col').first().waitFor();
  assert.match(await p.locator('#ab-circuit > summary').innerText(), /mon circuit de validation/i);
  await p.locator('#ab-t-mine').click();
  await p.selectOption('#ab-who', 'dr');
  await p.waitForFunction(() => window.__calls.some((c) => c.name === 'absence_circuit_mine' && c.args.p_user === 'dr'));
  await p.locator('#ab-circuit > summary', { hasText: 'Circuit de validation de Dr Fictif' }).waitFor();
  assert.match(await p.locator('#ab-circuit-flow .cc-applied').innerText(), /Circuit appliqué : Cadres \(nommé\)/);
  await p.selectOption('#ab-who', '');
  await p.locator('#ab-circuit > summary', { hasText: 'Mon circuit de validation' }).waitFor();
  ok('secrétaire : le circuit du cadre choisi s\'affiche, puis le sien');
  await p.context().close();

  assert.deepEqual(errors, [], 'aucune erreur de console : ' + errors.join(' | '));
  ok('aucune erreur de console');
} finally {
  await browser.close();
  server.close();
}
