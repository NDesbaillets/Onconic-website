// Section « Ajouter un membre » de la page Membres et accès : rôles selon l'appelant, cliniques, mot de passe affiché une seule fois.
// Serveur statique et réponses simulées, aucune base distante. Nécessite Playwright : node tests/absences/admin-members-add-ui.mjs
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
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.webmanifest': 'application/manifest+json' };
const server = http.createServer(async (req, res) => {
  const file = normalize(join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
  if (!file.startsWith(ROOT)) { res.statusCode = 403; return res.end(); }
  try { res.setHeader('content-type', TYPES[extname(file)] || 'application/octet-stream'); res.end(await readFile(file)); } catch { res.statusCode = 404; res.end('404'); }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const BASE = `http://127.0.0.1:${server.address().port}`;

const MOCK = `
window.__calls = []; window.__invoke = [];
const mk = (id, first, last, role) => ({ id, first_name: first, last_name: last, full_name: first + ' ' + last, email: first.toLowerCase() + '@example.com', role, institution: 'CHUV',
  created_at: '2026-10-01T10:00:00Z', last_sign_in_at: '2026-11-10T10:00:00Z', tools: {}, clinics: [], cdc_clinics: [], absence_validator: false, validates: [] });
window.__rows = [mk('me', 'Moi', 'Fictif', window.__ROLE), mk('u1', 'Alice', 'Martin', 'clinician')];
const sb = {
  auth: { getSession: async () => ({ data: { session: { user: { id: 'me' } } } }), signOut: async () => ({ error: null }) },
  rpc: async (name, args) => {
    window.__calls.push({ name, args });
    if (name === 'current_role_name') return { data: window.__ROLE };
    if (name === 'member_create_allowed') return { data: window.__ROLE === 'admin' ? args.p_role !== 'admin' : (window.__ROLE === 'direction' ? !['admin', 'direction'].includes(args.p_role) : false), error: null };
    if (name === 'admin_members') return { data: structuredClone(window.__rows), error: null };
    return { data: [], error: null };
  },
  functions: { invoke: async (name, opts) => {
    window.__invoke.push({ name, body: opts.body });
    const fail = window.__FAIL;
    if (fail) return { data: null, error: { context: { json: async () => ({ error: fail }) } } };
    window.__rows.push(mk('n' + window.__invoke.length, opts.body.first_name, opts.body.last_name, opts.body.role));
    return { data: { ok: true, id: 'new', mode: opts.body.mode, password: opts.body.mode === 'password' ? 'Abcd-Efgh-Jklm-Npqr' : undefined }, error: null };
  } },
};
window.supabase = { createClient: () => sb };
window.confirm = () => true;
window.__copied = [];
Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t) => { window.__copied.push(t); } }, configurable: true });`;

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const errors = [];
async function open(role) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript('window.__ROLE = ' + JSON.stringify(role) + ';' + MOCK);
  await ctx.route('**/*', (r) => (r.request().url().startsWith(BASE) ? r.continue() : r.abort()));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.goto(BASE + '/admin/membres.html');
  await page.locator('#am-tool').waitFor({ state: 'visible' });
  return { ctx, page };
}
const roleOptions = (p) => p.locator('#am-add-role option').allTextContents();
let step = 0; const ok = (m) => console.log(`ok ${++step} - ${m}`);

try {
  // Administrateur : sept rôles, jamais « Administrateur » ni « En attente »
  const a = await open('admin');
  const p = a.page;
  await p.locator('#am-add > summary').waitFor();
  assert.deepEqual(await roleOptions(p), ['Médecin assistant', 'CDC (chef·fe de clinique)', 'Médecin cadre', 'Assistante médicale', 'Infirmier·ère', 'Pharmacien·ne', 'Admin de direction']);
  ok('administrateur : six rôles de membres et « Admin de direction », jamais « Administrateur »');

  await p.locator('#am-add > summary').click();
  await p.fill('#am-add-first', 'Nina');
  await p.fill('#am-add-last', 'Test');
  await p.fill('#am-add-email', 'nina.test@example.com');
  // Cliniques : visibles pour médecin assistant, CDC, cadre seulement
  assert.equal(await p.locator('#am-add-clinics').isVisible(), true);
  assert.equal(await p.locator('#am-add-cdc').isVisible(), false);
  await p.selectOption('#am-add-role', 'cdc');
  assert.equal(await p.locator('#am-add-cdc').isVisible(), true);
  await p.selectOption('#am-add-role', 'nurse');
  assert.equal(await p.locator('#am-add-clinics').isVisible(), false);
  assert.equal(await p.locator('#am-add-cdc').isVisible(), false);
  ok('cliniques de rattachement et de gestion affichées selon le rôle');

  // Validation locale
  await p.selectOption('#am-add-role', 'cadre');
  await p.fill('#am-add-email', 'pas-un-mail');
  await p.click('#am-add-submit');
  await p.locator('#am-add-msg.error', { hasText: 'Adresse e-mail invalide' }).waitFor();
  assert.equal((await p.evaluate(() => window.__invoke)).length, 0);
  await p.fill('#am-add-email', 'nina.test@example.com');

  // Création avec mot de passe provisoire
  await p.locator('#am-add-clinics input[value="ORL"]').check();
  await p.locator('#am-add-clinics input[value="Plateforme"]').check();
  await p.locator('#am-add-cdc input[value="ORL"]').check();
  await p.locator('input[name="am-add-mode"][value="password"]').check();
  await p.click('#am-add-submit');
  await p.locator('#am-add-msg.ok', { hasText: 'Compte créé pour Nina Test' }).waitFor();
  const inv = await p.evaluate(() => window.__invoke);
  assert.equal(inv.length, 1);
  assert.deepEqual(inv[0], { name: 'member-create', body: { first_name: 'Nina', last_name: 'Test', email: 'nina.test@example.com', role: 'cadre', institution: 'CHUV',
    clinics: ['ORL', 'Plateforme'], cdc_clinics: ['ORL'], mode: 'password' } });
  assert.equal(await p.locator('#am-add-pass-value').innerText(), 'Abcd-Efgh-Jklm-Npqr');
  assert.equal(await p.locator('#am-add-pass').isVisible(), true);
  await p.click('#am-add-pass-copy');
  await p.locator('#am-add-pass-copy', { hasText: 'Copié' }).waitFor();
  assert.deepEqual(await p.evaluate(() => window.__copied), ['Abcd-Efgh-Jklm-Npqr']);
  assert.match(await p.locator('#am-count').innerText(), /3 membres affichés sur 3/, 'la liste est rechargée');
  assert.equal(await p.locator('#am-add-first').inputValue(), '', 'formulaire vidé');
  ok('création avec mot de passe provisoire : envoi nettoyé, mot de passe affiché et copiable, liste rechargée');

  // « Masquer » efface le mot de passe du DOM
  await p.click('#am-add-pass-hide');
  assert.equal(await p.locator('#am-add-pass').isVisible(), false);
  assert.equal(await p.locator('#am-add-pass-value').textContent(), '');
  // Repli de la section : efface aussi
  await p.fill('#am-add-first', 'Zoé'); await p.fill('#am-add-last', 'Test'); await p.fill('#am-add-email', 'zoe.test@example.com');
  await p.selectOption('#am-add-role', 'nurse');
  await p.locator('input[name="am-add-mode"][value="password"]').check();
  await p.click('#am-add-submit');
  await p.locator('#am-add-pass').waitFor({ state: 'visible' });
  await p.locator('#am-add > summary').click();
  await p.waitForFunction(() => document.getElementById('am-add-pass-value').textContent === '');
  await p.locator('#am-add > summary').click();
  // Délai de 5 minutes : horloge accélérée
  await p.clock.install();
  await p.fill('#am-add-first', 'Yan'); await p.fill('#am-add-last', 'Test'); await p.fill('#am-add-email', 'yan.test@example.com');
  await p.locator('input[name="am-add-mode"][value="password"]').check();
  await p.click('#am-add-submit');
  await p.locator('#am-add-pass').waitFor({ state: 'visible' });
  await p.clock.fastForward(5 * 60 * 1000 + 1000);
  assert.equal(await p.locator('#am-add-pass').isVisible(), false);
  assert.equal(await p.locator('#am-add-pass-value').textContent(), '', 'délai : mot de passe effacé');
  ok('mot de passe provisoire effacé par « Masquer », au repli et après 5 minutes');

  // Le mot de passe n'est plus affiché à la création suivante (invitation)
  await p.fill('#am-add-first', 'Omar'); await p.fill('#am-add-last', 'Test'); await p.fill('#am-add-email', 'omar.test@example.com');
  await p.selectOption('#am-add-role', 'direction');
  await p.click('#am-add-submit');
  await p.locator('#am-add-msg.ok', { hasText: 'Une invitation a été envoyée à omar.test@example.com' }).waitFor();
  assert.equal(await p.locator('#am-add-pass').isVisible(), false);
  const last = (await p.evaluate(() => window.__invoke)).at(-1).body;
  assert.deepEqual([last.role, last.mode, last.clinics, last.cdc_clinics], ['direction', 'invite', [], []]);
  ok('invitation : aucun mot de passe affiché, cliniques vides pour la direction');

  // Erreurs en français
  await p.evaluate(() => { window.__FAIL = 'profile_failed'; });
  await p.fill('#am-add-first', 'Eve'); await p.fill('#am-add-last', 'Test'); await p.fill('#am-add-email', 'eve.test@example.com');
  await p.click('#am-add-submit');
  await p.locator('#am-add-msg.error', { hasText: "le rôle n'a pas pu être attribué" }).waitFor();
  assert.match(await p.locator('#am-add-msg').innerText(), /e-mail d'invitation est parti/, 'mode invitation : mention de l\'e-mail');
  assert.match(await p.locator('#am-add-msg').innerText(), /liste des membres en attente/);
  const loads = async () => (await p.evaluate(() => window.__calls)).filter((c) => c.name === 'admin_members').length;
  await p.waitForFunction(() => window.__calls.filter((c) => c.name === 'admin_members').length >= 3);
  await p.locator('input[name="am-add-mode"][value="password"]').check();
  const before = await loads();
  await p.click('#am-add-submit');
  await p.locator('#am-add-msg.error', { hasText: "le rôle n'a pas pu être attribué" }).waitFor();
  assert.ok(!/invitation/i.test(await p.locator('#am-add-msg').innerText()), 'mode mot de passe : aucune mention');
  await p.waitForFunction((n) => window.__calls.filter((c) => c.name === 'admin_members').length > n, before);
  await p.evaluate(() => { window.__FAIL = 'invalid_clinics'; });
  await p.click('#am-add-submit');
  await p.locator('#am-add-msg.error', { hasText: 'Clinique inconnue' }).waitFor();
  await p.evaluate(() => { window.__FAIL = 'user_exists'; });
  await p.click('#am-add-submit');
  await p.locator('#am-add-msg.error', { hasText: '(peut-être en attente)' }).waitFor();
  await p.evaluate(() => { window.__FAIL = 'forbidden'; });
  await p.click('#am-add-submit');
  await p.locator('#am-add-msg.error', { hasText: 'pas le droit' }).waitFor();
  assert.equal(await p.locator('#am-add-pass').isVisible(), false);
  ok('codes d\'erreur affichés en français');

  // Direction : jamais « Admin de direction »
  const d = await open('direction');
  assert.deepEqual(await roleOptions(d.page), ['Médecin assistant', 'CDC (chef·fe de clinique)', 'Médecin cadre', 'Assistante médicale', 'Infirmier·ère', 'Pharmacien·ne']);
  ok('direction : six rôles de membres, ni « Admin de direction » ni « Administrateur »');

  assert.deepEqual(errors, [], 'aucune erreur JavaScript ni console');
  ok('aucune erreur de console');
} finally { await browser.close(); server.close(); }
