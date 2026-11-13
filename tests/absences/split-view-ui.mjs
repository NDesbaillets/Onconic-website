// Lettres d'assurance et CTCAE : liste à gauche (un tiers), fiche à droite (deux tiers) sur ordinateur, cartes dépliables sur téléphone.
// Serveur statique et réponses simulées, aucune base distante. Nécessite Playwright : node tests/absences/split-view-ui.mjs
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
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const server = http.createServer(async (req, res) => {
  const file = normalize(join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
  if (!file.startsWith(ROOT)) { res.statusCode = 403; return res.end(); }
  try { res.setHeader('content-type', TYPES[extname(file)] || 'application/octet-stream'); res.end(await readFile(file)); } catch { res.statusCode = 404; res.end('404'); }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const BASE = `http://127.0.0.1:${server.address().port}`;

const MOCK = `
const drug = (substance, brand, code) => ({ substance, brand, company: 'Firme fictive', code, route: 'IV', offLabel: false });
const rows = [
  { id: 1, position: 1, file: 'a.docx', title: 'Osimertinib adjuvant CBNPC EGFR', clinic: 'Thoracique', diagnosis: 'CBNPC', markers: 'EGFR', lines: ['adj'], trial: 'ADAURA', keywords: '', note: null, drugs: [drug('osimertinib', 'Tagrisso', '12345.01')], html: '<p>Texte de la lettre osimertinib.</p>' },
  { id: 2, position: 2, file: 'b.docx', title: 'Pembrolizumab 1re ligne CBNPC', clinic: 'Thoracique', diagnosis: 'CBNPC', markers: 'PD-L1 ≥ 50 %', lines: ['1L'], trial: 'KEYNOTE-024', keywords: '', note: 'Attention : limitation LS.', drugs: [drug('pembrolizumab', 'Keytruda', '67890.01')], html: '<p>Texte de la lettre pembrolizumab.</p>' },
  { id: 3, position: 3, file: 'c.docx', title: 'Enzalutamide cancer de la prostate', clinic: 'Urologie', diagnosis: 'Prostate', markers: '', lines: ['1L'], trial: 'PROSPER', keywords: '', note: null, drugs: [drug('enzalutamide', 'Xtandi', '11111.01')], html: '<p>Texte de la lettre enzalutamide.</p>' },
];
const builder = (result) => { const q = { select: () => q, order: () => q, range: () => q, eq: () => q, single: async () => result, maybeSingle: async () => result, then: (ok, ko) => Promise.resolve(result).then(ok, ko) }; return q; };
const sb = {
  auth: { getSession: async () => ({ data: { session: { user: { id: 'me' } } } }), signOut: async () => ({ error: null }) },
  from: (t) => t === 'letters' ? builder({ data: rows, error: null }) : t === 'letters_meta' ? builder({ data: { source_file: 'fictif.xlsx', imported_at: '2026-11-01T10:00:00Z', row_count: 3 } }) : builder({ data: { role: 'clinician' } }),
  rpc: async () => ({ data: false, error: null }),
};
window.supabase = { createClient: () => sb };`;

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const errors = [];
async function open(viewport, path) {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript(MOCK);
  await ctx.route('**/*', (r) => (r.request().url().startsWith(BASE) ? r.continue() : r.abort()));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.goto(BASE + path);
  return page;
}
const shot = async (page, name) => { if (SHOTS) { await mkdir(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, name + '.png') }); } };
const ratio = async (page) => { const [l, r] = await Promise.all([page.locator('.sv-left').boundingBox(), page.locator('#sv-detail').boundingBox()]); return r.width / (l.width + r.width); };
let step = 0; const ok = (m) => console.log(`ok ${++step} - ${m}`);

try {
  // ===== Lettres d'assurance, ordinateur =====
  const p = await open({ width: 1440, height: 900 }, '/app/lettres.html');
  await p.locator('#ug-tool').waitFor({ state: 'visible' });
  assert.ok(Math.abs((await ratio(p)) - 2 / 3) < 0.03, 'un tiers / deux tiers');
  assert.match(await p.locator('#sv-body').innerText(), /Sélectionnez une lettre/);
  assert.equal(await p.locator('#ug-results .lt-card').count(), 3);
  assert.equal(await p.locator('#ug-results details[open]').count(), 0, 'aucune carte dépliée en place sur ordinateur');
  await shot(p, '1-lettres-vide');
  await p.locator('#ug-results .lt-card', { hasText: 'Pembrolizumab' }).locator('summary').click();
  await p.locator('#sv-body .sv-title', { hasText: 'Pembrolizumab' }).waitFor();
  assert.match(await p.locator('#sv-body').innerText(), /Texte de la lettre pembrolizumab/);
  assert.match(await p.locator('#sv-body').innerText(), /Attention : limitation LS/);
  assert.ok(await p.getByRole('button', { name: 'Copier la lettre' }).isVisible());
  assert.equal(await p.locator('#ug-results .lt-card.is-active').count(), 1);
  assert.equal(await p.locator('#ug-results details[open]').count(), 0, 'la liste reste en place');
  await shot(p, '2-lettres-fiche');
  // La recherche filtre la liste sans fermer la lettre ; un résultat unique s'ouvre seul
  await p.fill('#q', 'enzalutamide');
  await p.locator('#sv-body .sv-title', { hasText: 'Enzalutamide' }).waitFor();
  assert.equal(await p.locator('#ug-results .lt-card').count(), 1);
  await p.fill('#q', '');
  assert.match(await p.locator('#sv-body .sv-title').innerText(), /Enzalutamide/, 'la lettre ouverte reste affichée');
  await p.locator('#sv-detail .sv-close').click();
  assert.match(await p.locator('#sv-body').innerText(), /Sélectionnez une lettre/);
  ok('Lettres, ordinateur : un tiers / deux tiers, clic ouvre la lettre à droite, recherche, résultat unique, fermeture');

  // ===== Lettres, téléphone : cartes dépliables inchangées =====
  const m = await open({ width: 390, height: 844 }, '/app/lettres.html');
  await m.locator('#ug-tool').waitFor({ state: 'visible' });
  assert.equal(await m.locator('#sv-detail').isVisible(), false);
  await m.locator('#ug-results .lt-card', { hasText: 'Pembrolizumab' }).locator('summary').click();
  await m.locator('#ug-results .lt-card[open] .lt-letter').waitFor();
  assert.match(await m.locator('#ug-results .lt-card[open]').innerText(), /Texte de la lettre pembrolizumab/);
  assert.ok((await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 1, 'pas de défilement horizontal');
  ok('Lettres, téléphone : carte dépliable, pas de panneau, pas de débordement');

  // ===== CTCAE, ordinateur =====
  const c = await open({ width: 1440, height: 900 }, '/app/ctcae.html');
  await c.locator('#ct-tool').waitFor({ state: 'visible' });
  assert.ok(Math.abs((await ratio(c)) - 2 / 3) < 0.03, 'un tiers / deux tiers');
  assert.equal(await c.locator('#sv-empty-browse #ct-browse').count(), 1, 'accueil à droite');
  assert.ok(await c.locator('#ct-browse .ct-cat').count() > 5, 'catégories');
  await shot(c, '3-ctcae-accueil');
  await c.fill('#q', 'diarrhée');
  await c.locator('#ct-list .ct-card').first().waitFor();
  const n = await c.locator('#ct-list .ct-card').count();
  assert.ok(n >= 1);
  assert.equal(await c.locator('#ct-list details[open]').count(), 0, 'aucune carte dépliée en place');
  await c.locator('#ct-list .ct-card').first().locator('summary').click();
  await c.locator('#sv-body .ct-table').waitFor();
  assert.match(await c.locator('#sv-body .sv-title').innerText(), /[Dd]iarrh/);
  assert.ok(await c.locator('#sv-body .ct-table tbody tr').count() >= 3, 'grades');
  assert.equal(await c.locator('#ct-list .ct-card.is-active').count(), 1);
  await shot(c, '4-ctcae-terme');
  // Changer la version ou la langue relit le terme ouvert
  const before = await c.locator('#sv-body .ct-table thead').innerText();
  await c.locator('#ct-ver button').nth(2).click();
  await c.waitForTimeout(500); if (process.env.DEBUG_UI) console.log('PANEL', errors.join(' | '), await c.locator('#sv-body').innerText().catch((e) => String(e)), await c.evaluate(() => [window.location.search, [...document.querySelectorAll('#ct-ver button')].map((b) => b.textContent + ':' + b.getAttribute('aria-pressed'))]));
  await c.locator('#sv-body .ct-table thead th', { hasText: 'v6.0' }).waitFor();
  assert.notEqual(await c.locator('#sv-body .ct-table thead').innerText(), before);
  await c.fill('#q', '');
  assert.ok(await c.locator('#ct-browse .ct-cat').count() > 5, 'retour à l\'accueil quand la recherche est vide');
  assert.match(await c.locator('#sv-body').innerText(), /Sélectionnez un terme/);
  await c.fill('#q', 'ALAT');
  await c.locator('#ct-list .ct-card').first().waitFor();
  assert.equal(await c.locator('#sv-body .ct-table').count(), 1, 'un résultat évident s\'ouvre seul');
  ok('CTCAE, ordinateur : accueil à droite, terme à droite, version relue, retour à l\'accueil, ouverture automatique');

  // ===== CTCAE, téléphone =====
  const t = await open({ width: 390, height: 844 }, '/app/ctcae.html?q=diarrh%C3%A9e');
  await t.locator('#ct-list .ct-card').first().waitFor();
  assert.equal(await t.locator('#sv-detail').isVisible(), false);
  assert.equal(await t.locator('#ct-browse').isVisible(), false);
  await t.locator('#ct-list .ct-card').first().locator('summary').click();
  await t.locator('#ct-list .ct-card[open] .ct-table').first().waitFor();
  await t.fill('#q', '');
  assert.ok(await t.locator('#ct-left #ct-browse .ct-cat').count() > 5, 'catégories dans la colonne sur téléphone');
  assert.ok((await t.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 1, 'pas de défilement horizontal');
  await shot(t, '5-ctcae-mobile');
  ok('CTCAE, téléphone : cartes dépliables, catégories sous la recherche, pas de débordement');

  assert.deepEqual(errors, [], 'aucune erreur JavaScript ni console');
  ok('aucune erreur de console');
} finally { await browser.close(); server.close(); }
