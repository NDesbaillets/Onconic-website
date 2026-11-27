// Fériés ajoutés à la main par la direction, dans le planning administratif et dans Oncoodle (réponses simulées, données fictives).
//   NODE_PATH=/opt/node-tools/node_modules node tests/absences/feries-manuels-ui.mjs
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

// Date fixée : mercredi 18.11.2026. Fériés manuels fictifs : jeudi 19.11.2026 (« Pont fictif ») et mercredi 10.09.2025 (« Ancien fictif »,
// hors des trois ans lus au démarrage : J-366 = 17.11.2025). Le mock note chaque appel de calendar_feries dans window.__feriesCalls.
const COMMON = (fail) => `
window.__feriesCalls = [];
const FERIES = [{ day: '2026-11-19', label: 'Pont fictif' }, { day: '2025-09-10', label: 'Ancien fictif' }];
const feries = (a) => { window.__feriesCalls.push([a.p_from, a.p_to]); return ${fail ? "({ data: null, error: { message: 'indisponible', code: 'PGRST202' } })" : "({ data: FERIES.filter((r) => r.day >= a.p_from && r.day <= a.p_to), error: null })"}; };`;

const PL_MOCK = (fail) => COMMON(fail) + `
window.__sets = [];
const codes = [{ code: 'AM1', label: 'Poste fictif', grp: 'Postes', bg: '#FFFF00', fg: '#000000', kind: 'poste', private: false, position: 1, active: true }];
const mkp = (id, first, last) => ({ id, first_name: first, last_name: last, team: 'AM', bloc: 1, pct: 100, resp: '', status: 'fixe', start_date: null, end_date: null, off: [], week: Array(10).fill('AM1'), me: false, linked: false, user_id: null, account: null });
// Ordre du serveur (celui du tableur) : Rey, Zed, Blanc
const staff = [mkp(11, 'Chloé', 'Rey'), mkp(12, 'Alice', 'Zed'), mkp(13, 'Bob', 'Blanc')];
const rpc = async (name, args) => {
  const ok = (data) => ({ data, error: null });
  switch (name) {
    case 'my_tools': return ok(['planning']);
    case 'plan_grid': return ok({ editor: true, codes, coverage: [], staff: structuredClone(staff), cells: [], absences: [] });
    case 'plan_accounts': return ok([]);
    case 'plan_set_cells': window.__sets.push(...args.p_changes); return ok(null);
    case 'calendar_feries': return feries(args);
    default: return ok(null);
  }
};
window.supabase = { createClient: () => ({ auth: { getSession: async () => ({ data: { session: { user: { id: 'me' } } } }), signOut: async () => ({ error: null }) }, rpc }) };`;

const OC_MOCK = (fail) => COMMON(fail) + `
const detail = { poll: { id: 1, kind: 'slots', status: 'open', locked: false, is_creator: false, creator: 'Org Fictif', title: 'Sondage fictif', visibility: 'all', final_option_id: null, deadline: null, description: '', location: '' },
  counts: { responded: 0, invited: 2 }, me: { votes: {}, comment: '' },
  options: [{ id: 1, day: '2026-11-19', start: '12:00', end: '13:00', yes: 0, maybe: 0, no: 0 }, { id: 2, day: '2026-11-20', start: '12:00', end: '13:00', yes: 0, maybe: 0, no: 0 }], invitees: [] };
const rpc = async (name, args) => {
  const ok = (data) => ({ data, error: null });
  switch (name) {
    case 'has_tool': return ok(true);
    case 'oncoodle_people': case 'oncoodle_list': case 'oncoodle_calendar_requests': return ok([]);
    case 'oncoodle_get': return ok(detail);
    case 'oncoodle_prefs': return ok({ email: true });
    case 'calendar_feries': return feries(args);
    default: return ok(null);
  }
};
window.supabase = { createClient: () => ({
  auth: { getSession: async () => ({ data: { session: { user: { id: 'me' } } } }), signOut: async () => ({ error: null }) },
  rpc, functions: { invoke: async () => ({ data: null, error: null }) },
  from: () => { const q = { select: () => q, eq: () => q, single: async () => ({ data: { role: 'clinician' } }) }; return q; } }) };`;

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const errors = [];
async function open(mock, path, ready) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await ctx.clock.setFixedTime(new Date('2026-11-18T10:00:00'));
  await ctx.addInitScript(mock);
  await ctx.route('**/*', (r) => (r.request().url().startsWith(BASE) ? r.continue() : r.abort()));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.goto(BASE + path);
  await page.locator(ready).first().waitFor({ state: 'visible' });
  return page;
}
const calls = (p) => p.evaluate(() => window.__feriesCalls);
const names = (p) => p.locator('#pl-grid tbody .pl-who').evaluateAll((n) => n.map((x) => x.textContent));
let step = 0; const ok = (m) => console.log(`ok ${++step} - ${m}`);

try {
  // ===== Planning administratif =====
  const p = await open(PL_MOCK(false), '/app/planning.html', '#pl-grid td.pl-c');
  const c0 = await calls(p);
  assert.ok(c0.length >= 2, 'trois ans lus au démarrage, en tranches de 800 jours au plus : ' + JSON.stringify(c0));
  assert.ok(c0.every(([a, b]) => (Date.parse(b) - Date.parse(a)) / 864e5 <= 800));
  assert.equal(c0[0][0], '2025-11-17', 'J-366');
  assert.equal(c0.at(-1)[1], '2029-11-22', 'J+1100');
  assert.equal(await p.locator('#pl-feries-warn').count(), 0);
  const head = p.locator('#pl-grid th.pl-day.pl-hol');
  assert.equal(await head.count(), 1, 'un seul jour férié dans les deux semaines affichées : le férié manuel');
  assert.match(await head.getAttribute('title'), /19\.11\.2026 · Pont fictif/);
  const cell = p.locator('#pl-grid td[data-p="11"][data-d="2026-11-19"][data-h="0"]');
  assert.equal(await cell.evaluate((e) => getComputedStyle(e).backgroundColor), 'rgb(217, 217, 217)', 'case grisée');
  assert.match(await cell.getAttribute('title'), /Pont fictif/);
  ok('planning : le férié manuel est grisé, intitulé en info-bulle, trois ans lus au démarrage');

  // Saisie par lot (semaine type) : le férié manuel est exclu
  await p.locator('#pl-grid button.pl-who', { hasText: 'Chloé Rey' }).click();
  await p.locator('#pl-person').waitFor({ state: 'visible' });
  await p.fill('#pl-wk-from', '2026-11-16'); await p.fill('#pl-wk-to', '2026-11-20');
  await p.click('#pl-wk-apply');
  await p.locator('#pl-person-msg', { hasText: /demi-journée\(s\) mise\(s\) à jour/ }).waitFor();
  await p.waitForFunction(() => window.__sets.length > 0);
  const sets = await p.evaluate(() => window.__sets);
  assert.deepEqual([...new Set(sets.map((x) => x.d))].sort(), ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-20'], 'le 19.11.2026 est exclu de la saisie par lot');
  assert.equal(sets.length, 8);
  ok('planning : le férié manuel est exclu de la saisie par lot');
  await p.keyboard.press('Escape');

  // Navigation vers une autre année : la plage manquante est lue avant de rendre
  const before = (await calls(p)).length;
  await p.click('[data-span="month"]');
  for (let i = 0; i < 14; i++) { await p.click('#pl-prev'); await p.waitForTimeout(40); }
  await p.locator('#pl-range', { hasText: 'septembre 2025' }).waitFor();
  await p.locator('#pl-grid th.pl-day.pl-hol').first().waitFor();
  const c1 = await calls(p);
  assert.ok(c1.length > before, 'une nouvelle plage a été lue');
  assert.ok(c1.slice(before).some(([a]) => a < '2025-09-10'), 'la plage lue couvre septembre 2025 : ' + JSON.stringify(c1.slice(before)));
  assert.match(await p.locator('#pl-grid th.pl-day.pl-hol').first().getAttribute('title'), /10\.09\.2025 · Ancien fictif/);
  ok('planning : la navigation hors de la plage lue recharge les fériés manuels');

  // Mode « Ordre du tableur » : ordre du serveur ; défaut : nom de famille
  await p.click('#pl-today');
  await p.locator('#pl-range', { hasText: 'novembre 2026' }).waitFor();
  const sel = p.locator('#pl-sort-slot select');
  assert.deepEqual(await sel.locator('option').allTextContents(), ['Nom de famille', 'Prénom', 'Ordre du tableur']);
  assert.equal(await sel.inputValue(), 'family', 'défaut : nom de famille');
  assert.deepEqual(await names(p), ['Bob Blanc', 'Chloé Rey', 'Alice Zed']);
  await sel.selectOption('sheet');
  assert.deepEqual(await names(p), ['Chloé Rey', 'Alice Zed', 'Bob Blanc'], 'ordre reçu du serveur');
  await sel.selectOption('first');
  assert.deepEqual(await names(p), ['Alice Zed', 'Bob Blanc', 'Chloé Rey']);
  await sel.selectOption('sheet');
  await p.reload();
  await p.locator('#pl-grid td.pl-c').first().waitFor();
  assert.equal(await p.locator('#pl-sort-slot select').inputValue(), 'sheet', 'choix mémorisé');
  assert.deepEqual(await names(p), ['Chloé Rey', 'Alice Zed', 'Bob Blanc']);
  ok('planning : « Ordre du tableur » restitue l\'ordre du serveur, défaut nom de famille, choix mémorisé');

  // Échec de la lecture : message discret, page utilisable, fériés calculés conservés
  const f = await open(PL_MOCK(true), '/app/planning.html', '#pl-grid td.pl-c');
  assert.match(await f.locator('#pl-feries-warn').innerText(), /Les fériés ajoutés par la direction n'ont pas pu être chargés : les jours fériés affichés peuvent être incomplets\./);
  assert.equal(await f.locator('#pl-grid th.pl-day.pl-hol').count(), 0, 'le férié manuel n\'est pas connu');
  assert.ok(await f.locator('#pl-grid td.pl-c').count() >= 60, 'la grille s\'affiche');
  await f.click('#pl-next');
  await f.locator('#pl-range', { hasText: '30.11.2026' }).waitFor();
  assert.ok(await f.locator('#pl-grid th.pl-day').count() >= 10);
  await f.click('[data-span="month"]');
  for (let i = 0; i < 4; i++) { await f.click('#pl-next'); await f.waitForTimeout(40); }
  await f.locator('#pl-range', { hasText: 'mars 2027' }).waitFor();
  assert.match(await f.locator('#pl-grid th.pl-day.pl-hol').first().getAttribute('title'), /26\.03\.2027 · Vendredi saint/, 'les fériés calculés restent affichés');
  assert.equal(await f.locator('#pl-feries-warn').count(), 1, 'un seul message');
  ok('planning : lecture en échec, message discret, page utilisable, fériés calculés conservés');

  // ===== Oncoodle =====
  const o = await open(OC_MOCK(false), '/app/oncoodle.html#p=1', '#oc-detail .oc-head');
  const oc0 = await calls(o);
  assert.equal(oc0[0][0], '2025-11-17'); assert.equal(oc0.at(-1)[1], '2029-11-22');
  const rows = o.locator('#oc-detail tbody tr');
  assert.match(await rows.nth(0).innerText(), /Jour férié : Pont fictif/);
  assert.doesNotMatch(await rows.nth(1).innerText(), /Jour férié/);
  ok('Oncoodle : avertissement « Jour férié : Pont fictif » sur la date proposée');

  await o.goto(BASE + '/app/oncoodle.html');
  await o.locator('#oc-new').waitFor({ state: 'visible' });
  await o.click('#oc-new');
  await o.fill('#g-from', '2026-11-18'); await o.fill('#g-to', '2026-11-24'); await o.fill('#g-starts', '12:00');
  await o.click('#g-run');
  await o.locator('#g-msg', { hasText: /créneaux? ajoutés?/ }).waitFor();
  const slots = await o.locator('#oc-slots li').allInnerTexts();
  assert.deepEqual(slots.map((s) => s.replace(/\s+/g, ' ').replace(/ ×$/, '').split(',')[0].trim()), ['mercredi 18 novembre 2026', 'vendredi 20 novembre 2026', 'lundi 23 novembre 2026', 'mardi 24 novembre 2026'], 'jeudi 19.11.2026 sauté');
  assert.doesNotMatch(await o.locator('#g-msg').innerText(), /fériés ajoutés par la direction/);
  // jour ajouté à la main : la mention « (jour férié) » apparaît
  await o.fill('#m-day', '2026-11-19'); await o.fill('#m-start', '12:00'); await o.fill('#m-end', '13:00');
  await o.click('#m-add');
  await o.locator('#oc-slots li', { hasText: '(jour férié)' }).waitFor();
  // sans « sauter les fériés » : tout est proposé
  await o.uncheck('#g-holidays'); await o.click('#g-run');
  await o.locator('#oc-slots li', { hasText: 'jeudi 19 novembre 2026' }).first().waitFor();
  ok('Oncoodle : la génération saute le férié manuel, la saisie manuelle le signale, décocher la case les propose');

  // Échec de la lecture : message discret, génération avertie, page utilisable
  const e = await open(OC_MOCK(true), '/app/oncoodle.html', '#oc-new');
  assert.match(await e.locator('#oc-feries-warn').innerText(), /Les fériés ajoutés par la direction n'ont pas pu être chargés : les jours fériés affichés peuvent être incomplets\./);
  await e.click('#oc-new');
  await e.fill('#g-from', '2026-11-18'); await e.fill('#g-to', '2026-11-24'); await e.fill('#g-starts', '12:00');
  await e.click('#g-run');
  await e.locator('#g-msg', { hasText: /créneaux? ajoutés?/ }).waitFor();
  assert.match(await e.locator('#g-msg').innerText(), /la liste des fériés ajoutés par la direction n'a pas pu être chargée/);
  assert.ok(await e.locator('#oc-slots li').count() >= 4, 'la génération fonctionne avec les seuls fériés calculés');
  await e.uncheck('#g-holidays'); await e.click('#g-run');
  await e.locator('#g-msg', { hasText: /créneau/ }).waitFor();
  assert.doesNotMatch(await e.locator('#g-msg').innerText(), /n'a pas pu être chargée/, 'pas d\'avertissement quand les fériés ne sont pas sautés');
  ok('Oncoodle : lecture en échec, message discret, avertissement à la génération, page utilisable');

  assert.deepEqual(errors, [], 'aucune erreur JavaScript ni console');
  ok('aucune erreur de console');
} finally { await browser.close(); server.close(); }
