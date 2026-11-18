// Absences, côté validateur : décision depuis le planning, et planning de la clinique à côté de la liste « À valider ».
// Serveur statique et réponses simulées (aucune base distante, données fictives). Nécessite Playwright :
//   NODE_PATH=/opt/node-tools/node_modules node tests/absences/validator-ui.mjs      (captures : SHOTS_DIR=/dossier)
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

// Données fictives : une validatrice (moi), deux demandeurs de Thoracique, un collègue de Thoracique, une personne d'Urologie
const MOCK = `
window.__calls = [];
const P = (id, name, clinics, me) => ({ id, name, role: 'clinician', clinics, is_me: !!me });
const people = [P('me', 'Cadre Fictive', ['Thoracique'], true), P('alice', 'Alice Fictive', ['Thoracique']), P('bob', 'Bob Fictif', ['Thoracique']), P('erik', 'Erik Fictif', ['Thoracique']), P('carla', 'Carla Fictive', ['Urologie'])];
const A = (id, user_id, kind, status, s, e, extra) => Object.assign({ id, user_id, kind, status, start_date: s, end_date: e, note: null, change_type: null }, extra || {});
const grid = [A(1, 'alice', 'vacances', 'requested', '2026-11-23', '2026-11-27'), A(5, 'bob', 'congres', 'approved', '2026-11-26', '2026-11-27'),
  A(2, 'erik', 'vacances', 'requested', '2026-12-07', '2026-12-11'), A(9, 'carla', 'vacances', 'approved', '2026-11-24', '2026-11-25')];
const T = (id, user_id, name, s, e, extra) => Object.assign({ id, user_id, name, clinics: ['Thoracique'], kind: 'vacances', note: null, start_date: s, end_date: e, status: 'requested', change_type: null,
  conflicts: [], progress: [{ name: 'Cadre Fictive', validator_name: 'Cadre Fictive', decision: 'pending', step: 0 }], stage: 1, opinions: [], step_kind: 'clinique', step_label: 'Validateurs de clinique',
  steps: [{ pos: 10, kind: 'clinique', label: 'Validateurs de clinique', mine: true }] }, extra || {});
let todo = [T(1, 'alice', 'Alice Fictive', '2026-11-23', '2026-11-27', { opinions: [{ name: 'Direction Fictive', opinion: 'favorable', at: '2026-11-18', comment: 'Rien à signaler' }],
    conflicts: [{ clinic: 'Thoracique', first_day: '2026-11-26', last_day: '2026-11-27', peak: 3, max_absent: 2, others: ['Bob Fictif'] }] }),
  T(2, 'erik', 'Erik Fictif', '2026-12-07', '2026-12-11')];
const rpc = async (name, args) => {
  window.__calls.push({ name, args });
  const ok = (data) => ({ data, error: null });
  switch (name) {
    case 'absence_context': return ok({ me: 'me', role: 'cadre', clinics: ['Thoracique'], validates: ['Thoracique'], pending: todo.length });
    case 'absence_people': return ok(people);
    case 'absence_clinics': return ok([{ clinic: 'Thoracique', max_absent: 2 }, { clinic: 'Urologie', max_absent: 2 }]);
    case 'absence_grid': return ok(grid.filter((g) => g.end_date >= args.p_from && g.start_date <= args.p_to));
    case 'absence_calendar': return ok([]);
    case 'absence_pending_count': return ok(todo.length);
    case 'absence_to_validate': return ok(JSON.parse(JSON.stringify(todo)));
    case 'absence_decide': { todo = todo.filter((t) => t.id !== args.p_id); return ok('approved'); }
    case 'absence_agenda_context': return { data: null, error: { message: 'absent' } };
    case 'absence_notification_status': return ok({ pending: 0, failed: 0, sent: 0 });
    case 'absence_list': case 'absence_approvals_all': case 'absence_rejected_to_manage': return ok([]);
    default: return ok(null);
  }
};
window.supabase = { createClient: () => ({
  auth: { getSession: async () => ({ data: { session: { user: { id: 'me' } } } }), signOut: async () => ({ error: null }) },
  rpc, functions: { invoke: async () => ({ data: null, error: null }) },
  from: () => { const q = { select: () => q, eq: () => q, single: async () => ({ data: { role: 'cadre' } }), then: (r) => Promise.resolve({ data: [], error: null }).then(r) }; return q; } }) };`;

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const errors = [];
async function open(viewport) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2 });
  await ctx.clock.setFixedTime(new Date('2026-11-18T10:00:00'));
  await ctx.addInitScript(MOCK);
  await ctx.route('**/*', (r) => (r.request().url().startsWith(BASE) ? r.continue() : r.abort()));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.goto(BASE + '/app/absences.html');
  await page.locator('#ab-tool').waitFor({ state: 'visible' });
  await page.locator('#ab-scroll table').waitFor();
  return page;
}
const shot = async (page, name, full = true) => { if (SHOTS) { await mkdir(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, name + '.png'), fullPage: full }); } };
const calls = (page, name) => page.evaluate((n) => window.__calls.filter((c) => c.name === n), name);
let step = 0; const ok = (m) => console.log(`ok ${++step} - ${m}`);

try {
  // ===== Décider depuis le planning (1280 px) =====
  let p = await open({ width: 1280, height: 900 });
  await p.locator('td[data-id="5"]').first().click();
  assert.equal(await p.locator('#ab-detail button', { hasText: 'Valider' }).count(), 0, 'absence validée : aucune décision proposée');
  assert.equal(await p.locator('#ab-detail .ab-comment').count(), 0);
  ok('absence validée : détail inchangé, pas de bouton de décision');
  await p.locator('td[data-id="1"]').first().click();
  const det = p.locator('#ab-detail');
  assert.match(await det.innerText(), /Alice Fictive/);
  assert.match(await det.innerText(), /Validation : 0 sur 1/);
  assert.match(await det.innerText(), /Rien à signaler/, 'pré-avis affiché');
  assert.match(await det.innerText(), /trop d'absences en même temps/, 'avertissement de chevauchement');
  assert.equal(await det.getByRole('button', { name: 'Valider', exact: true }).count(), 1);
  assert.equal(await det.getByRole('button', { name: 'Refuser', exact: true }).count(), 1);
  await shot(p, 'planning-decision-1280');
  ok('absence en attente : progression, pré-avis, chevauchement, boutons Valider et Refuser');
  await det.getByRole('button', { name: 'Refuser', exact: true }).click();
  assert.match(await det.innerText(), /Un refus demande un commentaire/);
  assert.equal((await calls(p, 'absence_decide')).length, 0, 'refus sans commentaire : aucun appel');
  await det.getByRole('button', { name: 'Valider', exact: true }).click();
  await det.locator('.form-msg.ok').waitFor();
  const dec = await calls(p, 'absence_decide');
  assert.equal(dec.length, 1);
  assert.equal(dec[0].args.p_id, 1); assert.equal(dec[0].args.p_approve, true);
  assert.match(await det.innerText(), /Alice Fictive : accepté/);
  await p.waitForFunction(() => document.getElementById('ab-todo-n').textContent === '1');
  ok('décision depuis le planning : absence_decide appelé, message, compteur rafraîchi');
  await p.locator('td[data-id="1"]').first().click();
  assert.equal(await p.locator('#ab-detail').getByRole('button', { name: 'Valider', exact: true }).count(), 0, 'plus de décision après validation');
  ok('planning rafraîchi : plus de bouton sur la demande décidée');
  await p.context().close();

  // ===== À valider, 1280 px : liste à gauche, planning à droite =====
  p = await open({ width: 1280, height: 900 });
  await p.locator('#ab-t-todo').click();
  await p.locator('#ab-todo-side .ab-mini-grid').waitFor();
  assert.equal(await p.locator('#ab-todo-side').isVisible(), true);
  const cardsLoc = p.locator('#ab-todo-list article');
  assert.equal(await cardsLoc.count(), 2);
  assert.equal(await cardsLoc.nth(0).getAttribute('aria-current'), 'true', 'première carte sélectionnée d\'office');
  assert.equal(await cardsLoc.nth(1).getAttribute('aria-current'), null);
  const [l, r] = await Promise.all([cardsLoc.nth(0).boundingBox(), p.locator('#ab-todo-side').boundingBox()]);
  assert.ok(r.x > l.x + l.width - 1, 'panneau à droite de la liste');
  assert.match(await p.locator('#ab-todo-side .ab-mini-title').innerText(), /Planning de Thoracique/);
  const names = () => p.locator('#ab-todo-side tbody tr:not(.ab-cal):not(.ab-count-row) th .ab-pname').allInnerTexts();
  assert.deepEqual(await names(), ['Alice Fictive', 'Bob Fictif', 'Cadre Fictive (moi)', 'Erik Fictif'], 'demandeur en tête, cliniques de la demande seulement');
  assert.equal(await p.locator('#ab-todo-side tr.ab-req').count(), 1);
  assert.equal(await p.locator('#ab-todo-side thead th.ab-hl').count(), 5, 'cinq jours demandés surlignés');
  assert.match(await p.locator('#ab-todo-side .ab-mini-range').innerText(), /23\.11\.2026 – 11\.12\.2026/, 'trois semaines au moins');
  assert.ok(await p.locator('#ab-todo-side tr.ab-count-row').count() === 1);
  assert.equal(await p.locator('#ab-todo-side td.ab-s-requested').count() > 0, true, 'demande en attente visible');
  await shot(p, 'validateur-1280');
  ok('1280 px : panneau à droite, première carte sélectionnée, demandeur en tête, jours surlignés');
  await cardsLoc.nth(1).locator('.ab-item-head').click();
  assert.equal(await cardsLoc.nth(1).getAttribute('aria-current'), 'true');
  assert.equal(await cardsLoc.nth(0).getAttribute('aria-current'), null);
  await p.waitForFunction(() => /07\.12\.2026/.test(document.querySelector('#ab-todo-side .ab-mini-range')?.textContent || ''));
  assert.deepEqual(await names(), ['Erik Fictif', 'Alice Fictive', 'Bob Fictif', 'Cadre Fictive (moi)']);
  ok('changement de sélection : planning et demandeur en tête mis à jour');
  await cardsLoc.nth(0).focus();
  await p.keyboard.press('Enter');
  assert.equal(await cardsLoc.nth(0).getAttribute('aria-current'), 'true');
  ok('sélection au clavier (Entrée)');
  await p.locator('#ab-todo-side button[aria-label="Semaine suivante"]').click();
  await p.waitForFunction(() => /30\.11\.2026 – 18\.12\.2026/.test(document.querySelector('#ab-todo-side .ab-mini-range')?.textContent || ''));
  assert.equal(await p.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Semaine suivante', 'focus redonné au bouton ›');
  await p.locator('#ab-todo-side button[aria-label="Semaine précédente"]').click();
  await p.waitForFunction(() => /23\.11\.2026 – 11\.12\.2026/.test(document.querySelector('#ab-todo-side .ab-mini-range')?.textContent || ''));
  assert.equal(await p.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Semaine précédente', 'focus redonné au bouton ‹');
  ok('navigation d\'une semaine, focus conservé sur le bouton utilisé');

  // Sélection au focus : saisir dans la 2e carte la sélectionne ; groupe nommé ; commentaire conservé au changement de largeur
  assert.equal(await cardsLoc.nth(1).getAttribute('role'), 'group');
  assert.match(await cardsLoc.nth(1).getAttribute('aria-label'), /Erik Fictif, 07\.12\.2026 – 11\.12\.2026/);
  await cardsLoc.nth(1).locator('.ab-comment input').focus();
  assert.equal(await cardsLoc.nth(1).getAttribute('aria-current'), 'true', 'sélection au focus dans la carte');
  await p.waitForFunction(() => /07\.12\.2026/.test(document.querySelector('#ab-todo-side .ab-mini-range')?.textContent || ''));
  await p.keyboard.type('Pour avis');
  await p.setViewportSize({ width: 900, height: 900 });
  await p.locator('#ab-todo-list .ab-mini-toggle').first().waitFor();
  assert.equal(await p.locator('#ab-todo-list article').nth(1).locator('.ab-comment input').inputValue(), 'Pour avis', 'commentaire conservé');
  await p.setViewportSize({ width: 1280, height: 900 });
  await p.locator('#ab-todo-side .ab-mini-grid').waitFor();
  ok('sélection au focus, carte nommée, commentaire conservé au passage du seuil');

  // Ouvrir dans le planning : filtre temporaire, aucune préférence écrite
  const prefsBefore = await p.evaluate(() => localStorage.getItem('onconic.absences.v1'));
  await p.locator('#ab-todo-side').getByRole('button', { name: 'Ouvrir dans le planning' }).click();
  assert.equal(await p.locator('#ab-t-plan').getAttribute('aria-selected'), 'true');
  assert.equal(await p.locator('#ab-scroll table.ab-win').count(), 1, 'fenêtre glissante');
  assert.match(await p.locator('#ab-title').innerText(), /\d\d\.\d\d\.2026/);
  assert.equal(await p.locator('#ab-temp').isVisible(), true, 'mention de la vue temporaire');
  assert.equal(await p.locator('#ab-scroll tbody tr:not(.ab-cal) th .ab-pname').count(), 4, 'les 4 membres de Thoracique');
  assert.equal(await p.locator('#ab-scope').inputValue(), 'mine', 'sélecteur inchangé');
  assert.equal(await p.evaluate(() => localStorage.getItem('onconic.absences.v1')), prefsBefore, 'préférences intactes');
  await p.locator('#ab-rows').selectOption('5');
  const saved = await p.evaluate(() => JSON.parse(localStorage.getItem('onconic.absences.v1')));
  assert.equal(saved.scope, 'mine', 'le filtre temporaire n\'est jamais enregistré');
  assert.equal(await p.locator('#ab-scroll tbody tr:not(.ab-cal) th .ab-pname').count(), 4, 'pas tronqué par « lignes affichées »');
  await p.getByRole('button', { name: 'Revenir à mes réglages' }).click();
  assert.equal(await p.locator('#ab-temp').isVisible(), false);
  ok('ouverture dans le planning : filtre temporaire, non tronqué, non enregistré, retirable');
  await p.context().close();

  // ===== À valider, 390 px =====
  p = await open({ width: 390, height: 844 });
  await p.locator('#ab-t-todo').click();
  await p.locator('#ab-todo-list article').first().waitFor();
  assert.equal(await p.locator('#ab-todo-side').isVisible(), false, 'pas de panneau latéral');
  const toggles = p.getByRole('button', { name: 'Voir le planning de la clinique' });
  assert.equal(await toggles.count(), 2);
  await toggles.first().click();
  await p.locator('#ab-todo-list .ab-mini-grid').first().waitFor();
  assert.equal(await p.locator('#ab-todo-list .ab-mini-grid').count(), 1);
  const wide = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  assert.equal(wide, false, 'pas de défilement horizontal de la page');
  assert.equal(await p.locator('#ab-todo-list .ab-mini-scroll').evaluate((e) => e.scrollWidth > e.clientWidth), true, 'défilement dans le panneau seulement');
  await p.locator('#ab-todo-list .ab-mini-wrap').first().scrollIntoViewIfNeeded();
  await shot(p, 'validateur-390');
  ok('390 px : bouton qui déplie le planning, aucun défilement horizontal de la page');
  await p.context().close();

  assert.deepEqual(errors, [], 'aucune erreur de console');
  ok('aucune erreur de console');
} finally {
  await browser.close();
  server.close();
}
