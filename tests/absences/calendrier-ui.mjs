// Calendrier des fériés et événements : page d'administration (admin/calendrier.html) et effets dans le planning des absences.
// Serveur statique et réponses simulées (aucune base distante, données fictives). Nécessite Playwright :
//   NODE_PATH=/opt/node-tools/node_modules node tests/absences/calendrier-ui.mjs      (captures : SHOTS_DIR=/dossier)
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

// ----- Page d'administration : rôle réglable, entrées modifiables en mémoire -----
const ADMIN_MOCK = (role) => `
window.__calls = [];
window.__impact = 2;
let nextId = 10;
const E = (id, kind, label, s, e, extra) => Object.assign({ id, kind, label, start_date: s, end_date: e, source: 'manuel', to_confirm: false, created_by_name: 'Direction Fictive', updated_by_name: null, updated_at: null }, extra || {});
let entries = [E(1, 'vacances_scolaires', 'Vacances scolaires VD : Noël', '2026-12-24', '2027-01-10', { source: 'openholidays', to_confirm: true, created_by_name: null }),
  E(2, 'evenement', 'Retraite fictive', '2026-09-03', '2026-09-04'), E(3, 'ferie', 'Pont fictif', '2026-05-15', '2026-05-15'), E(4, 'presence_obligatoire', 'Séminaire fictif', '2026-10-01', '2026-10-01')];
let log = [{ id: 1, at: '2026-11-10T09:00:00Z', actor_name: 'Direction Fictive', action: 'create', kind: 'ferie', label: 'Pont fictif', start_date: '2026-05-15', end_date: '2026-05-15' }];
const rpc = async (name, args) => {
  window.__calls.push({ name, args });
  const ok = (data) => ({ data, error: null });
  switch (name) {
    case 'current_role_name': return ok('${role}');
    case 'admin_calendar_list': return ok(JSON.parse(JSON.stringify(entries)));
    case 'admin_calendar_log_list': return ok(log);
    case 'admin_calendar_sync_status': return ok({ last_run: '2026-11-03T06:17:00Z', result: { ajoutees: 1, mises_a_jour: 0, identiques: 3, ecarts: [{ label: 'Vacances scolaires VD : été', saisi: ['2027-07-03', '2027-08-22'], source: ['2027-07-05', '2027-08-20'] }] } });
    case 'admin_calendar_impact': return ok(window.__impact);
    case 'admin_calendar_save': {
      if (args.p_id) entries = entries.map((e) => (e.id === args.p_id ? Object.assign(e, { kind: args.p_kind, label: args.p_label, start_date: args.p_start, end_date: args.p_end, to_confirm: false, updated_by_name: 'Direction Fictive', updated_at: '2026-11-18T10:00:00Z' }) : e));
      else entries.push(E(nextId++, args.p_kind, args.p_label, args.p_start, args.p_end));
      log.unshift({ id: nextId, at: '2026-11-18T10:00:00Z', actor_name: 'Direction Fictive', action: args.p_id ? 'update' : 'create', kind: args.p_kind, label: args.p_label, start_date: args.p_start, end_date: args.p_end });
      return ok(args.p_id || nextId - 1);
    }
    case 'admin_calendar_delete': entries = entries.filter((e) => e.id !== args.p_id); return ok(null);
    case 'admin_calendar_confirm': entries = entries.map((e) => (e.id === args.p_id ? Object.assign(e, { to_confirm: false }) : e)); return ok(null);
    default: return ok(null);
  }
};
window.supabase = { createClient: () => ({
  auth: { getSession: async () => ({ data: { session: { user: { id: 'me' } } } }), signOut: async () => ({ error: null }) },
  rpc, functions: { invoke: async () => ({ data: null, error: null }) } }) };`;

// ----- Planning : un férié ajouté (ven. 20.11.2026), une présence obligatoire (24 et 25.11.2026), une demande à valider qui la chevauche -----
const PLAN_MOCK = `
window.__calls = [];
const P = (id, name, me) => ({ id, name, role: 'clinician', clinics: ['Thoracique'], is_me: !!me });
const people = [P('me', 'Cadre Fictive', true), P('alice', 'Alice Fictive')];
const A = (id, user_id, kind, status, s, e) => ({ id, user_id, kind, status, start_date: s, end_date: e, note: null, change_type: null });
const grid = [A(1, 'alice', 'vacances', 'requested', '2026-11-23', '2026-11-27')];
let drafts = [];
const todo = [{ id: 1, user_id: 'alice', name: 'Alice Fictive', clinics: ['Thoracique'], kind: 'vacances', note: null, start_date: '2026-11-23', end_date: '2026-11-27', status: 'requested', change_type: null,
  conflicts: [], progress: [{ name: 'Cadre Fictive', validator_name: 'Cadre Fictive', decision: 'pending', step: 0 }], stage: 1, opinions: [], step_kind: 'clinique', step_label: 'Validateurs de clinique',
  steps: [{ pos: 10, kind: 'clinique', label: 'Validateurs de clinique', mine: true }] }];
const T2 = (id, name, extra) => Object.assign(JSON.parse(JSON.stringify(todo[0])), { id, user_id: 'u' + id, name }, extra);
todo.push(T2(2, 'Bob Fictif', { start_date: '2026-11-24', end_date: '2026-11-25', change_type: 'delete' }));
todo.push(T2(3, 'Carla Fictive', { start_date: '2026-12-01', end_date: '2026-12-04', change_type: 'modify', change_kind: 'vacances', change_start: '2026-11-24', change_end: '2026-11-25' }));
window.__cal = [{ id: 33, kind: 'ferie', label: 'Férié passé fictif', start_date: '2025-05-14', end_date: '2025-05-14' }, { id: 31, kind: 'ferie', label: 'Pont fictif', start_date: '2026-11-20', end_date: '2026-11-20' },
  { id: 32, kind: 'presence_obligatoire', label: 'Séminaire fictif', start_date: '2026-11-24', end_date: '2026-11-25' }];
const rpc = async (name, args) => {
  window.__calls.push({ name, args });
  const ok = (data) => ({ data, error: null });
  switch (name) {
    case 'absence_context': return ok({ me: 'me', role: 'cadre', clinics: ['Thoracique'], validates: ['Thoracique'], pending: todo.length });
    case 'absence_people': return ok(people);
    case 'absence_clinics': return ok([{ clinic: 'Thoracique', max_absent: 2 }]);
    case 'absence_grid': return ok(grid.filter((g) => g.end_date >= args.p_from && g.start_date <= args.p_to));
    case 'absence_calendar': if (window.__calFail) return { data: null, error: { message: 'panne simulée' } }; return ok(window.__cal.filter((c) => c.end_date >= args.p_from && c.start_date <= args.p_to));
    case 'absence_pending_count': return ok(todo.length);
    case 'absence_to_validate': return ok(JSON.parse(JSON.stringify(todo)));
    case 'absence_request': drafts = [{ id: 77, user_id: 'me', kind: args.p_kind, status: 'draft', start_date: args.p_start, end_date: args.p_end, note: null, requested_by: 'me', change_type: null }]; return ok({ id: 77, conflicts: [] });
    case 'absence_list': return ok(JSON.parse(JSON.stringify(drafts.concat([{ id: 90, user_id: 'me', kind: 'vacances', status: 'approved', start_date: '2025-05-12', end_date: '2025-05-16', note: null, change_type: null }]))));
    case 'absence_my_validators': return ok({ validators: [{ id: 'me', name: 'Cadre Fictive' }], fallback: false });
    case 'absence_agenda_context': return { data: null, error: { message: 'absent' } };
    case 'absence_notification_status': return ok({ pending: 0, failed: 0, sent: 0 });
    case 'absence_approvals_all': case 'absence_rejected_to_manage': return ok([]);
    default: return ok(null);
  }
};
window.supabase = { createClient: () => ({
  auth: { getSession: async () => ({ data: { session: { user: { id: 'me' } } } }), signOut: async () => ({ error: null }) },
  rpc, functions: { invoke: async () => ({ data: null, error: null }) },
  from: () => { const q = { select: () => q, eq: () => q, single: async () => ({ data: { role: 'cadre' } }), then: (r) => Promise.resolve({ data: [], error: null }).then(r) }; return q; } }) };`;

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const errors = [];
async function open(mock, path, ready, viewport = { width: 1280, height: 900 }) {
  const ctx = await browser.newContext({ viewport });
  await ctx.clock.setFixedTime(new Date('2026-11-18T10:00:00'));
  await ctx.addInitScript(mock);
  await ctx.route('**/*', (r) => (r.request().url().startsWith(BASE) ? r.continue() : r.abort()));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.goto(BASE + path);
  if (ready) await page.locator(ready).waitFor({ state: 'visible' });
  return page;
}
const shot = async (page, name) => { if (SHOTS) { await mkdir(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, name + '.png'), fullPage: true }); } };
const calls = (page, name) => page.evaluate((n) => window.__calls.filter((c) => c.name === n), name);
const labels = (page) => page.locator('#ac-list .ac-item:not(.ac-calc) .ac-label').allInnerTexts();
let step = 0; const ok = (m) => console.log(`ok ${++step} - ${m}`);

try {
  // ===== Accès réservé =====
  let p = await open(ADMIN_MOCK('clinician'), '/admin/calendrier.html', '#ug-status');
  await p.waitForFunction(() => /réservée à l'administration/.test(document.getElementById('ug-status').textContent));
  assert.equal(await p.locator('#ac-tool').isVisible(), false);
  assert.equal((await calls(p, 'admin_calendar_list')).length, 0, 'aucune donnée demandée à un autre rôle');
  await p.context().close();
  ok('autre rôle : accès refusé, aucune lecture du calendrier');

  // ===== Liste, fériés calculés, filtres, année =====
  p = await open(ADMIN_MOCK('direction'), '/admin/calendrier.html', '#ac-tool');
  await p.locator('#ac-list .ac-item').first().waitFor();
  assert.equal(await p.inputValue('#ac-year'), '2026');
  assert.deepEqual(await labels(p), ['Pont fictif', 'Retraite fictive', 'Séminaire fictif', 'Vacances scolaires VD : Noël'], 'entrées de 2026 triées par date');
  assert.equal(await p.locator('#ac-list .ac-calc').count(), 9, 'neuf fériés vaudois calculés');
  assert.equal(await p.locator('#ac-list .ac-calc button').count(), 0, 'fériés calculés en lecture seule');
  assert.match(await p.locator('#ac-list').innerText(), /03\.04\.2026[\s\S]*Vendredi saint/, 'Vendredi saint 2026');
  assert.match(await p.locator('#ac-log').innerText(), /Ajout · Férié ajouté « Pont fictif »/);
  assert.match(await p.locator('#ac-sync').innerText(), /Dernier import des vacances scolaires/);
  assert.match(await p.locator('#ac-sync').innerText(), /Écart à vérifier/);
  assert.equal(await p.getByRole('button', { name: 'Importer maintenant' }).count(), 1);
  await shot(p, 'calendrier-admin');
  ok('direction : liste de l\'année, fériés calculés en lecture seule, journal, état de l\'import');
  await p.selectOption('#ac-filter-kind', 'ferie');
  assert.deepEqual(await labels(p), ['Pont fictif']);
  assert.equal(await p.locator('#ac-list .ac-calc').count(), 0);
  await p.selectOption('#ac-filter-kind', 'calc');
  assert.equal(await p.locator('#ac-list .ac-item').count(), 9);
  await p.selectOption('#ac-filter-kind', '');
  await p.fill('#ac-q', 'retraite');
  assert.deepEqual(await labels(p), ['Retraite fictive']);
  await p.fill('#ac-q', 'noel');
  assert.equal(await p.locator('#ac-list .ac-calc').count(), 1, 'recherche sans accent : Noël');
  await p.fill('#ac-q', '');
  ok('filtres par type et recherche sans accent');
  await p.click('#ac-next');
  assert.equal(await p.inputValue('#ac-year'), '2027');
  assert.deepEqual(await labels(p), ['Vacances scolaires VD : Noël'], 'une période à cheval sur deux années figure dans les deux');
  assert.match(await p.locator('#ac-list').innerText(), /Lundi de Pâques/);
  await p.fill('#ac-year', '2025'); await p.press('#ac-year', 'Tab');
  assert.deepEqual(await labels(p), []);
  assert.equal(await p.locator('#ac-list .ac-calc').count(), 9);
  await p.click('#ac-prev'); await p.click('#ac-next'); await p.click('#ac-next');
  assert.equal(await p.inputValue('#ac-year'), '2026');
  ok('changement d\'année : suivante, précédente, saisie');

  // ===== Ajout d'un férié avec avertissement d'impact =====
  await p.selectOption('#ac-kind', 'ferie');
  assert.match(await p.locator('#ac-help').innerText(), /déduit des jours ouvrables de tout le monde, y compris des absences déjà déposées/);
  await p.selectOption('#ac-kind', 'presence_obligatoire');
  assert.match(await p.locator('#ac-help').innerText(), /avertissement non bloquant à la demande d'absence/);
  await p.selectOption('#ac-kind', 'ferie');
  await p.fill('#ac-label', 'Pont de l\'Ascension');
  await p.fill('#ac-start', '2026-05-15'); // la fin suit le début
  assert.equal(await p.inputValue('#ac-end'), '2026-05-15');
  await p.fill('#ac-start', '2026-05-14');
  await p.click('#ac-save');
  await p.locator('#ac-confirm').waitFor({ state: 'visible' });
  assert.match(await p.locator('#ac-confirm').innerText(), /Cette modification change le nombre de jours ouvrables de 2 absence\(s\) déjà déposée\(s\)\./);
  assert.equal((await calls(p, 'admin_calendar_save')).length, 0, 'rien n\'est enregistré avant la confirmation');
  const imp = await calls(p, 'admin_calendar_impact');
  assert.deepEqual(imp[0].args, { p_start: '2026-05-14', p_end: '2026-05-15', p_exclude_id: null });
  await p.locator('#ac-confirm').getByRole('button', { name: 'Annuler' }).click();
  assert.equal(await p.locator('#ac-confirm').isVisible(), false);
  assert.equal((await calls(p, 'admin_calendar_save')).length, 0);
  await p.click('#ac-save');
  await p.locator('#ac-confirm').getByRole('button', { name: 'Enregistrer' }).click();
  await p.waitForFunction(() => /Entrée ajoutée/.test(document.getElementById('ac-msg').textContent));
  const sv = await calls(p, 'admin_calendar_save');
  assert.equal(sv.length, 1);
  assert.deepEqual(sv[0].args, { p_id: null, p_kind: 'ferie', p_label: 'Pont de l\'Ascension', p_start: '2026-05-14', p_end: '2026-05-15' });
  assert.ok((await labels(p)).includes('Pont de l\'Ascension'));
  assert.match(await p.locator('#ac-log').innerText(), /Ajout · Férié ajouté « Pont de l'Ascension »/);
  assert.equal(await p.inputValue('#ac-label'), '', 'formulaire remis à zéro');
  ok('ajout d\'un férié : aide, impact annoncé, annulation possible, confirmation puis enregistrement et journal');

  // Une présence obligatoire ne déduit aucun jour ouvrable : pas de contrôle d'impact
  const before = (await calls(p, 'admin_calendar_impact')).length;
  await p.selectOption('#ac-kind', 'presence_obligatoire');
  await p.fill('#ac-label', 'Journée de service');
  await p.fill('#ac-start', '2026-06-10'); await p.fill('#ac-end', '2026-06-11');
  await p.click('#ac-save');
  await p.waitForFunction(() => /Entrée ajoutée/.test(document.getElementById('ac-msg').textContent));
  assert.equal((await calls(p, 'admin_calendar_impact')).length, before, 'pas d\'impact pour une présence obligatoire');
  assert.ok((await labels(p)).includes('Journée de service'));
  // dates incohérentes et intitulé trop court : refus côté page
  await p.fill('#ac-label', 'x'); await p.fill('#ac-start', '2026-06-10'); await p.fill('#ac-end', '2026-06-09');
  await p.click('#ac-save');
  assert.match(await p.locator('#ac-msg').innerText(), /2 à 120/);
  await p.fill('#ac-label', 'Valide'); await p.click('#ac-save');
  assert.match(await p.locator('#ac-msg').innerText(), /Vérifiez les dates/);
  await p.reload(); await p.locator('#ac-list .ac-item').first().waitFor();
  ok('présence obligatoire sans contrôle d\'impact ; validations côté page');

  // ===== Modification =====
  await p.locator('#ac-list .ac-item', { hasText: 'Pont fictif' }).getByRole('button', { name: 'Modifier' }).click();
  assert.equal(await p.inputValue('#ac-label'), 'Pont fictif');
  assert.equal(await p.inputValue('#ac-kind'), 'ferie');
  assert.equal(await p.inputValue('#ac-start'), '2026-05-15');
  assert.equal(await p.locator('#ac-form-title').innerText(), 'Modifier l\'entrée');
  assert.equal(await p.locator('#ac-cancel').isVisible(), true);
  await p.fill('#ac-label', 'Pont fictif corrigé');
  const nImp0 = (await calls(p, 'admin_calendar_impact')).length;
  await p.click('#ac-save'); // simple changement d'intitulé : aucun contrôle d'impact, enregistrement direct
  await p.waitForFunction(() => /Entrée modifiée/.test(document.getElementById('ac-msg').textContent));
  assert.equal((await calls(p, 'admin_calendar_impact')).length, nImp0, 'intitulé seul : pas de contrôle d\'impact');
  const mod = (await calls(p, 'admin_calendar_save')).pop();
  assert.deepEqual(mod.args, { p_id: 3, p_kind: 'ferie', p_label: 'Pont fictif corrigé', p_start: '2026-05-15', p_end: '2026-05-15' });
  assert.ok((await labels(p)).includes('Pont fictif corrigé'));
  assert.match(await p.locator('#ac-list .ac-item', { hasText: 'Pont fictif corrigé' }).innerText(), /modifié par Direction Fictive/);
  assert.match(await p.locator('#ac-log').innerText(), /Modification · Férié ajouté « Pont fictif corrigé »/);
  // changement de dates d'un férié : contrôle sur l'union des plages, entrée ignorée (p_exclude_id)
  await p.locator('#ac-list .ac-item', { hasText: 'Pont fictif corrigé' }).getByRole('button', { name: 'Modifier' }).click();
  await p.fill('#ac-start', '2026-05-15'); await p.fill('#ac-end', '2026-05-18');
  await p.evaluate(() => { window.__impact = 1; });
  await p.click('#ac-save');
  await p.locator('#ac-confirm').waitFor({ state: 'visible' });
  assert.match(await p.locator('#ac-confirm').innerText(), /de 1 absence\(s\)/);
  assert.deepEqual((await calls(p, 'admin_calendar_impact')).pop().args, { p_start: '2026-05-15', p_end: '2026-05-18', p_exclude_id: 3 });
  await p.locator('#ac-confirm').getByRole('button', { name: 'Annuler' }).click();
  await p.click('#ac-cancel');
  // annulation d'une modification
  await p.locator('#ac-list .ac-item', { hasText: 'Retraite fictive' }).getByRole('button', { name: 'Modifier' }).click();
  await p.click('#ac-cancel');
  assert.equal(await p.inputValue('#ac-label'), '');
  assert.equal(await p.locator('#ac-cancel').isVisible(), false);
  ok('modification : formulaire prérempli, enregistrement par identifiant, journal, annulation');

  // ===== Suppression, confirmation d'une période importée =====
  await p.evaluate(() => { window.__impact = 3; });
  await p.locator('#ac-list .ac-item', { hasText: 'Pont fictif corrigé' }).getByRole('button', { name: 'Supprimer' }).click();
  await p.locator('#ac-confirm').waitFor({ state: 'visible' });
  assert.match(await p.locator('#ac-confirm').innerText(), /change le nombre de jours ouvrables de 3 absence\(s\)/);
  assert.equal((await calls(p, 'admin_calendar_delete')).length, 0);
  assert.deepEqual((await calls(p, 'admin_calendar_impact')).pop().args, { p_start: '2026-05-15', p_end: '2026-05-15', p_exclude_id: 3 }, 'suppression simulée par p_exclude_id');
  await p.locator('#ac-confirm').getByRole('button', { name: 'Supprimer' }).click();
  await p.waitForFunction(() => /Entrée supprimée/.test(document.getElementById('ac-msg').textContent));
  assert.equal((await calls(p, 'admin_calendar_delete'))[0].args.p_id, 3);
  assert.ok(!(await labels(p)).includes('Pont fictif corrigé'));
  const nImp = (await calls(p, 'admin_calendar_impact')).length;
  await p.locator('#ac-list .ac-item', { hasText: 'Retraite fictive' }).getByRole('button', { name: 'Supprimer' }).click();
  assert.equal((await calls(p, 'admin_calendar_impact')).length, nImp, 'pas de contrôle d\'impact pour un événement');
  assert.doesNotMatch(await p.locator('#ac-confirm').innerText(), /jours ouvrables/);
  await p.locator('#ac-confirm').getByRole('button', { name: 'Annuler' }).click();
  assert.ok((await labels(p)).includes('Retraite fictive'), 'suppression annulée');
  await p.click('#ac-next');
  await p.locator('#ac-list .ac-item', { hasText: 'Noël' }).first().waitFor();
  const conf = p.locator('#ac-list .ac-item', { hasText: 'Vacances scolaires VD : Noël' }).getByRole('button', { name: 'Confirmer' });
  assert.equal(await conf.count(), 1);
  assert.match(await p.locator('#ac-list').innerText(), /Importé, à confirmer/);
  await conf.click();
  await p.waitForFunction(() => /Période confirmée/.test(document.getElementById('ac-msg').textContent));
  assert.equal((await calls(p, 'admin_calendar_confirm'))[0].args.p_id, 1);
  assert.equal(await p.locator('#ac-list .ac-item', { hasText: 'Vacances scolaires VD : Noël' }).getByRole('button', { name: 'Confirmer' }).count(), 0);
  assert.match(await p.locator('#ac-list').innerText(), /Importé, confirmé/);
  await shot(p, 'calendrier-admin-2027');
  ok('suppression avec impact et annulation, confirmation d\'une période importée');
  await p.context().close();

  // ===== Planning : férié ajouté grisé et déduit des jours ouvrables, avertissement de présence obligatoire =====
  p = await open(PLAN_MOCK, '/app/absences.html', '#ab-tool');
  await p.locator('#ab-scroll table').waitFor();
  const start = await calls(p, 'absence_calendar');
  assert.ok(start.some((c) => c.args.p_from < '2026-01-01' && c.args.p_to > '2028-11-18'), 'fenêtre de trois ans chargée au démarrage');
  await p.waitForFunction(() => document.querySelectorAll('#ab-scroll thead th.ab-d').length >= 30);
  assert.match(await p.locator('#ab-scroll thead th.ab-d').nth(19).getAttribute('class'), /ab-we/, 'le 20.11.2026 est grisé comme un férié');
  assert.doesNotMatch(await p.locator('#ab-scroll thead th.ab-d').nth(18).getAttribute('class'), /ab-we/, 'le 19.11.2026 reste ouvrable');
  const fer = p.locator('#ab-scroll td[data-cal="2026-11-20"]');
  assert.equal(await fer.innerText(), 'F');
  assert.match(await fer.getAttribute('title'), /Férié : Pont fictif/);
  const pres = p.locator('#ab-scroll td[data-cal="2026-11-24"]');
  assert.equal(await pres.innerText(), 'P');
  assert.match(await pres.getAttribute('class'), /ab-cal-presence_obligatoire/);
  assert.match(await pres.getAttribute('title'), /Séminaire fictif/);
  assert.match(await p.locator('ul[aria-label="Légende"]').innerText(), /Présence obligatoire/);
  await fer.click();
  assert.match(await p.locator('#ab-detail').innerText(), /Férié[\s\S]*Férié : Pont fictif/);
  await pres.click();
  assert.match(await p.locator('#ab-detail').innerText(), /Présence obligatoire[\s\S]*Séminaire fictif/);
  ok('planning : férié ajouté grisé et lettre F, présence obligatoire lettre P, légende et détail');

  // Formulaire : 16 au 20.11.2026 = cinq jours moins le férié du 20
  await p.fill('#ab-start', '2026-11-16'); await p.fill('#ab-end', '2026-11-20');
  assert.match(await p.locator('#ab-days').innerText(), /^4 jours ouvrables/);
  assert.equal(await p.locator('#ab-presence .ab-presence').count(), 0, 'aucune présence obligatoire sur cette période');
  await p.fill('#ab-start', '2026-11-24'); await p.fill('#ab-end', '2026-11-26');
  assert.match(await p.locator('#ab-presence').innerText(), /Cette période chevauche une présence obligatoire : Séminaire fictif \(24\.11\.2026 – 25\.11\.2026\)/);
  assert.match(await p.locator('#ab-days').innerText(), /^3 jours ouvrables/);
  await shot(p, 'planning-formulaire');
  // Récapitulatif d'envoi
  await p.getByRole('button', { name: 'Demander l\'absence' }).click();
  await p.locator('#sd[open]').waitFor();
  assert.match(await p.locator('#sd-warn').innerText(), /Cette période chevauche une présence obligatoire : Séminaire fictif/);
  assert.equal(await p.locator('#sd-go').isDisabled(), false, 'avertissement non bloquant');
  ok('formulaire : jours ouvrables sans le férié ajouté, avertissement de présence obligatoire (dates et récapitulatif)');

  // Carte du validateur : À valider, puis détail dans le planning
  await p.locator('#sd-close').click();
  await p.locator('#ab-t-todo').click();
  await p.locator('#ab-todo-list article').first().waitFor();
  assert.match(await p.locator('#ab-todo-list article').first().innerText(), /Cette période chevauche une présence obligatoire : Séminaire fictif \(24\.11\.2026 – 25\.11\.2026\)/);
  assert.match(await p.locator('#ab-todo-list article').first().innerText(), /5 jours ouvrables/, 'semaine du 23.11 : aucun férié ajouté')
  const bob = p.locator('#ab-todo-list article', { hasText: 'Bob Fictif' });
  assert.doesNotMatch(await bob.innerText(), /présence obligatoire/, 'demande de suppression : aucun avertissement de présence');
  assert.match(await p.locator('#ab-todo-list article', { hasText: 'Carla Fictive' }).innerText(), /Cette période chevauche une présence obligatoire : Séminaire fictif/, 'modification : la nouvelle période est comparée');
  await p.locator('#ab-t-plan').click();
  await p.locator('td[data-id="1"]').first().click();
  assert.match(await p.locator('#ab-detail').innerText(), /Cette période chevauche une présence obligatoire : Séminaire fictif/);
  await shot(p, 'planning-validateur');
  ok('carte du validateur (À valider) et détail du planning : avertissement de présence obligatoire');

  // Entrée modifiée puis supprimée entre deux chargements : la page relit les fériés au retour sur l'onglet
  const plus = () => p.evaluate(() => { const n = Date.now(); Date.now = () => n + 10 * 60 * 1000; document.dispatchEvent(new Event('visibilitychange')); });
  const cls = (i) => p.locator('#ab-scroll thead th.ab-d').nth(i).getAttribute('class');
  await p.locator('#ab-t-plan').click();
  await p.evaluate(() => { window.__cal.find((c) => c.id === 31).start_date = '2026-11-19'; window.__cal.find((c) => c.id === 31).end_date = '2026-11-19'; });
  await plus();
  await p.waitForFunction(() => /ab-we/.test(document.querySelectorAll('#ab-scroll thead th.ab-d')[18].className));
  assert.doesNotMatch(await cls(19), /ab-we/, 'ancienne date : redevenue ouvrable');
  await p.evaluate(() => { window.__cal = window.__cal.filter((c) => c.id !== 31); });
  await plus();
  await p.waitForFunction(() => !/ab-we/.test(document.querySelectorAll('#ab-scroll thead th.ab-d')[18].className));
  assert.doesNotMatch(await cls(18), /ab-we/, 'entrée supprimée : plus de férié');
  ok('modification de dates puis suppression d\'un férié entre deux chargements : la grille suit');

  // Mes absences d'une année passée : les fériés ajoutés de cette année sont lus avant le calcul des jours ouvrables
  await p.locator('#ab-t-mine').click();
  await p.selectOption('#ab-year', '2025');
  await p.locator('#ab-p-mine summary', { hasText: 'Passées' }).click();
  assert.match(await p.locator('#ab-p-mine').innerText(), /4 jours ouvrables/, 'du 12 au 16.05.2025 moins le férié du 14.05 ajouté');
  const past = (await calls(p, 'absence_calendar')).filter((c) => c.args.p_from <= '2025-05-12' && c.args.p_to >= '2025-05-16' && c.args.p_from > '2020-01-01');
  assert.ok(past.length >= 1, 'plage de l\'absence passée lue');
  // Export Word d'une année passée : fériés lus pour l'année avant la préparation du document
  await p.evaluate(() => { window.__calls.length = 0; });
  await p.click('#ab-docx');
  await p.waitForFunction(() => window.__calls.some((c) => c.name === 'absence_calendar'));
  assert.deepEqual((await calls(p, 'absence_calendar'))[0].args, { p_from: '2025-01-01', p_to: '2025-12-31' });
  ok('année passée : fériés ajoutés lus pour Mes absences et l\'export Word');
  await p.context().close();

  // Panne de lecture des fériés : message discret
  p = await open('window.__calFail = true;' + PLAN_MOCK, '/app/absences.html', '#ab-tool');
  await p.locator('#ab-feries-warn').waitFor({ state: 'visible' });
  assert.match(await p.locator('#ab-feries-warn').innerText(), /Les fériés ajoutés par la direction n'ont pas pu être chargés ; les jours ouvrables affichés peuvent différer/);
  ok('lecture des fériés en échec : message affiché, planning utilisable');
  await p.context().close();
} finally { await browser.close(); server.close(); }
if (errors.length) { console.error('Erreurs de page :\n' + errors.join('\n')); process.exit(1); }
console.log('Calendrier : tout est passé.');
