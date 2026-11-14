// Mon compte : réglages des notifications par type et par canal. Page minimale + vraie feuille de style et vrai script, réponses simulées.
// Nécessite Playwright : node tests/absences/notify-prefs-ui.mjs
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
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const OWN = ['approved', 'rejected', 'change_approved', 'change_rejected', 'direction_change'];
const KINDS = { validator: ['to_validate', 'to_validate_change', 'reminder', ...OWN, 'event_join'], direction: ['to_direction', 'to_opinion', 'reminder', ...OWN, 'event_join'], plain: [...OWN, 'event_join'], none: [] };

const MOCK = `
const who = new URLSearchParams(location.search).get('who') || 'validator';
const kinds = ${JSON.stringify(KINDS)}[who];
window.__calls = [];
window.__fail = false;
let prefs = {};
const view = () => ({ kinds: kinds.map((k) => ({ kind: k, email: k === 'event_join' ? null : (prefs[k] && prefs[k].email === false ? false : true), push: prefs[k] && prefs[k].push === false ? false : true })) });
window.supabase = { createClient: () => ({
  auth: { getSession: async () => ({ data: { session: { user: { id: 'me' } } } }) },
  rpc: async (name, args) => {
    window.__calls.push({ name, args });
    if (name === 'my_notification_prefs') return { data: view(), error: null };
    if (name === 'my_set_notification_pref') { if (window.__fail) return { data: null, error: { message: 'boom' } }; prefs[args.p_kind] = Object.assign({}, prefs[args.p_kind], { [args.p_channel]: args.p_on }); return { data: view(), error: null }; }
    if (name === 'my_reset_notification_prefs') { prefs = {}; return { data: view(), error: null }; }
    return { data: null, error: null };
  } }) };
window.ONCONIC_CONFIG = { supabaseUrl: 'https://example.invalid', supabaseAnonKey: 'x' };`;
const page = (lang) => `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/assets/css/onconic.css"><link rel="stylesheet" href="/assets/css/notify-prefs.css"></head><body><main class="container"><div class="card"><h2>Notifications</h2><div id="notify-prefs" hidden></div></div></main><script>${MOCK}</script><script src="/assets/js/notify-prefs.js"></script></body></html>`;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/__fr') { res.setHeader('content-type', TYPES['.html']); return res.end(page('fr')); }
  if (url.pathname === '/__en') { res.setHeader('content-type', TYPES['.html']); return res.end(page('en')); }
  const file = normalize(join(ROOT, decodeURIComponent(url.pathname)));
  if (!file.startsWith(ROOT)) { res.statusCode = 403; return res.end(); }
  try { res.setHeader('content-type', TYPES[extname(file)] || 'application/octet-stream'); res.end(await readFile(file)); } catch { res.statusCode = 404; res.end('404'); }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const BASE = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const errors = [];
const open = async (path, viewport = { width: 1100, height: 900 }) => {
  const ctx = await browser.newContext({ viewport });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await p.goto(BASE + path);
  return p;
};
const shot = async (p, name) => { if (SHOTS) { await mkdir(SHOTS, { recursive: true }); await p.screenshot({ path: join(SHOTS, name + '.png'), fullPage: true }); } };
let step = 0; const ok = (m) => console.log(`ok ${++step} - ${m}`);

try {
  // Valideur : trois groupes, pas de groupe Direction
  const p = await open('/__fr?who=validator');
  await p.locator('#notify-prefs .np-table').first().waitFor();
  assert.deepEqual(await p.locator('.np-caption').allInnerTexts(), ["Demandes d'absence à traiter", 'Rappels', 'Mes absences', 'Congrès']);
  assert.equal(await p.locator('.np-table').nth(0).locator('tbody tr').count(), 2);
  assert.equal(await p.locator('.np-table').nth(2).locator('tbody tr').count(), 5);
  assert.equal((await p.locator('.np-table').nth(3).locator('tbody td.np-ch').first().innerText()).trim(), '—', 'pas d\'e-mail pour les congrès');
  assert.equal(await p.locator('#notify-prefs input:checked').count(), await p.locator('#notify-prefs input[type=checkbox]').count(), 'tout est coché par défaut (cases et en-têtes)');
  await shot(p, '1-valideur');
  ok('valideur : groupes selon le profil, tout coché par défaut, congrès sans e-mail');

  // Décocher l'e-mail d'un type
  await p.getByLabel('Nouvelle demande d\'absence à valider : E-mail', { exact: true }).uncheck();
  await p.locator('.form-msg.ok', { hasText: 'Enregistré.' }).waitFor();
  let calls = await p.evaluate(() => window.__calls.filter((c) => c.name === 'my_set_notification_pref'));
  assert.deepEqual(calls.at(-1).args, { p_kind: 'to_validate', p_channel: 'email', p_on: false });
  assert.equal(await p.getByLabel('Nouvelle demande d\'absence à valider : E-mail', { exact: true }).isChecked(), false, 'reste décoché après rechargement de l\'état');
  assert.equal(await p.getByLabel('Nouvelle demande d\'absence à valider : Notification', { exact: true }).isChecked(), true, 'l\'autre canal ne bouge pas');
  // En-tête de colonne : état partiel puis tout décocher
  const head = p.getByLabel("Demandes d'absence à traiter : E-mail, Tout");
  assert.equal(await head.evaluate((e) => e.indeterminate), true);
  await head.click();
  await p.locator('.np-table').nth(0).locator('tbody tr').nth(1).getByRole('checkbox').first().waitFor();
  assert.equal(await p.locator('.np-table').nth(0).locator('tbody tr input[aria-label$="E-mail"]:checked').count(), 2, 'tout coché après un clic sur l\'état partiel');
  await head.uncheck();
  await p.waitForFunction(() => document.querySelectorAll('.np-wrap:first-of-type tbody tr input[aria-label$="E-mail"]:checked').length === 0);
  calls = await p.evaluate(() => window.__calls.filter((c) => c.name === 'my_set_notification_pref'));
  assert.ok(calls.some((c) => c.args.p_kind === 'to_validate_change' && c.args.p_channel === 'email' && c.args.p_on === false));
  await shot(p, '2-emails-coupes');
  ok('décocher un type, état partiel de l\'en-tête, tout cocher et tout décocher une colonne');

  // Tout réactiver
  await p.getByRole('button', { name: 'Tout réactiver' }).click();
  await p.locator('.form-msg.ok', { hasText: 'réactivées' }).waitFor();
  assert.equal(await p.locator('#notify-prefs input:checked').count(), await p.locator('#notify-prefs input[type=checkbox]').count());
  ok('tout réactiver');

  // Erreur d'enregistrement : la case revient en arrière
  await p.evaluate(() => { window.__fail = true; });
  await p.getByLabel('Mon absence est validée : E-mail', { exact: true }).click();
  await p.locator('.form-msg.error').waitFor();
  assert.equal(await p.getByLabel('Mon absence est validée : E-mail', { exact: true }).isChecked(), true);
  ok('erreur d\'enregistrement : la case revient en arrière avec un message');

  // Direction, profil simple, profil sans type
  const d = await open('/__fr?who=direction');
  await d.locator('.np-table').first().waitFor();
  assert.deepEqual(await d.locator('.np-caption').allInnerTexts(), ['Direction', 'Rappels', 'Mes absences', 'Congrès']);
  assert.equal(await d.locator('.np-table').first().locator('tbody tr').count(), 2, 'visa et pré-avis');
  const s = await open('/__fr?who=plain');
  await s.locator('.np-table').first().waitFor();
  assert.deepEqual(await s.locator('.np-caption').allInnerTexts(), ['Mes absences', 'Congrès']);
  const n = await open('/__fr?who=none');
  await n.waitForTimeout(500);
  assert.equal(await n.locator('#notify-prefs').isVisible(), false, 'aucun type : rien à régler, le bloc reste masqué');
  ok('direction, profil simple et profil sans type');

  // Anglais et mobile
  const e = await open('/__en?who=validator', { width: 390, height: 844 });
  await e.locator('.np-table').first().waitFor();
  assert.match(await e.locator('#notify-prefs').innerText(), /Choose my notifications/);
  assert.match(await e.locator('#notify-prefs').innerText(), /New absence request to approve/);
  assert.ok((await e.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 1, 'pas de défilement horizontal de la page');
  await shot(e, '3-mobile-en');
  ok('anglais et téléphone sans débordement');

  assert.deepEqual(errors, [], 'aucune erreur de console');
  ok('aucune erreur de console');
} finally { await browser.close(); server.close(); }
