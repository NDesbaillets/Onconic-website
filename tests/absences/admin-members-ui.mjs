// Page Administration des membres : liste à gauche, fiche à droite (ordinateur), vue plein écran (mobile).
// Serveur statique et réponses simulées, aucune base distante. Nécessite Playwright : node tests/absences/admin-members-ui.mjs
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
window.__calls = [];
const tools = (on, custom) => Object.fromEntries(['congres','trials','lettres','limitations','duree','absences','medletters'].map((t) => [t, { allowed: on.includes(t), custom: custom.includes(t) }]));
const mk = (id, first, last, role, extra) => Object.assign({ id, first_name: first, last_name: last, full_name: first + ' ' + last, email: first.toLowerCase() + '@example.com', role, institution: 'CHUV',
  created_at: '2026-10-01T10:00:00Z', last_sign_in_at: '2026-11-10T10:00:00Z', tools: tools(['congres','trials'], []), clinics: [], cdc_clinics: [], absence_validator: false, validates: [] }, extra || {});
window.__rows = [
  mk('me', 'Admin', 'Fictif', 'admin'),
  mk('u1', 'Alice', 'Martin', 'clinician', { clinics: ['Thoracique'] }),
  mk('u2', 'Bruno', 'Dupont', 'cadre', { clinics: ['Urologie'], cdc_clinics: ['Urologie'], absence_validator: true, validates: ['Urologie'] }),
  mk('u3', 'Chloé', 'Rey', 'member'),
  mk('u4', 'David', 'Roch', 'nurse', { tools: tools(['trials','duree'], ['duree']) }),
  mk('u5', 'Eva', 'Blanc', 'assistant'),
  mk('u6', 'Farid', 'Noir', 'cdc', { clinics: ['ORL'], cdc_clinics: ['ORL'] }),
];
for (let i = 0; i < 30; i++) window.__rows.push(mk('x' + i, 'Prénom' + i, 'Nom' + String(i).padStart(2, '0'), 'clinician', { clinics: ['Sénologie'] }));
const sb = {
  auth: { getSession: async () => ({ data: { session: { user: { id: 'me' } } } }), signOut: async () => ({ error: null }) },
  rpc: async (name, args) => {
    window.__calls.push({ name, args });
    if (name === 'current_role_name') return { data: 'admin' };
    if (name === 'admin_members') return { data: structuredClone(window.__rows), error: null };
    if (name === 'admin_clinic_changes') return { data: [], error: null };
    if (name === 'admin_clinic_requests') return { data: [{ id: 1, user_id: 'u1', name: 'Alice Martin', current: ['Thoracique'], clinics: ['Urologie'] }], error: null };
    if (name === 'admin_set_tool') { const r = window.__rows.find((x) => x.id === args.p_user); r.tools[args.p_tool] = { allowed: args.p_allowed, custom: true }; return { data: args.p_allowed, error: null }; }
    if (name === 'admin_set_role') { window.__rows.find((x) => x.id === args.p_user).role = args.p_role; return { data: null, error: null }; }
    return { data: null, error: null };
  },
};
window.supabase = { createClient: () => sb };
window.confirm = () => true;`;

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const errors = [];
async function open(viewport, path = '/admin/membres.html') {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript(MOCK);
  await ctx.route('**/*', (r) => (r.request().url().startsWith(BASE) ? r.continue() : r.abort()));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.goto(BASE + path);
  await page.locator('#am-tool').waitFor({ state: 'visible' });
  return { ctx, page };
}
const shot = async (page, name) => { if (SHOTS) { await mkdir(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, name + '.png') }); } };
let step = 0; const ok = (m) => console.log(`ok ${++step} - ${m}`);

try {
  // Ordinateur : un tiers / deux tiers
  const d = await open({ width: 1440, height: 900 });
  const p = d.page;
  const [l, r] = await Promise.all([p.locator('#am-left').boundingBox(), p.locator('#am-detail').boundingBox()]);
  assert.ok(Math.abs(r.width / (l.width + r.width) - 2 / 3) < 0.03, `répartition ${l.width} / ${r.width}`);
  assert.match(await p.locator('#am-detail-body').innerText(), /Sélectionnez un membre/);
  assert.equal(await p.locator('#am-back').isVisible(), false);
  assert.match(await p.locator('#am-count').innerText(), /37 membres affichés sur 37 · 1 en attente/);
  assert.match(await p.locator('#am-list li').first().innerText(), /Chloé Rey/, 'les comptes en attente passent en premier');
  assert.match(await p.locator('#am-requests-sum').innerText(), /\(1\)/);
  await shot(p, '1-bureau-vide');
  ok('ordinateur : un tiers pour la liste, deux tiers pour la fiche, en attente en tête');

  await p.locator('.am-row', { hasText: 'Bruno Dupont' }).click();
  await p.locator('#am-detail-body .am-name', { hasText: 'Bruno Dupont' }).waitFor();
  assert.ok(await p.locator('.am-row.is-active', { hasText: 'Bruno Dupont' }).count() === 1);
  assert.match(await p.locator('#am-detail-body').innerText(), /Validation des absences/);
  assert.match(p.url(), /#u=u2/);
  assert.equal(await p.locator('#am-list li').count(), 37, 'la liste reste en place');
  await shot(p, '2-bureau-fiche');
  // Une action dans la fiche garde la sélection et la position de la liste
  await p.locator('#am-list').evaluate((e) => { e.scrollTop = 200; });
  await p.locator('.am-row', { hasText: 'Prénom10 Nom10' }).click();
  const before = await p.locator('#am-list').evaluate((e) => e.scrollTop);
  await p.getByLabel('Congrès', { exact: true }).click();
  await p.locator('#am-msg.ok', { hasText: 'Congrès fermé' }).waitFor();
  assert.match(await p.locator('#am-detail-body .am-name').innerText(), /Prénom10 Nom10/, 'la fiche reste ouverte après la modification');
  assert.equal(await p.locator('#am-list').evaluate((e) => e.scrollTop), before, 'la liste ne saute pas');
  assert.ok((await p.evaluate(() => window.__calls)).some((c) => c.name === 'admin_set_tool' && c.args.p_user === 'x10' && c.args.p_allowed === false));
  assert.match(await p.locator('.am-row.is-active').innerText(), /exception/);
  ok('sélection, fiche, modification d\'un accès sans perdre la sélection ni la position');

  // Recherche, filtre et fermeture
  await p.fill('#am-q', 'eva');
  assert.equal(await p.locator('#am-list li').count(), 1);
  assert.match(await p.locator('#am-detail-body .am-name').innerText(), /Prénom10 Nom10/, 'la fiche ouverte reste affichée même si la liste est filtrée');
  await p.fill('#am-q', '');
  await p.selectOption('#am-role', 'nurse');
  assert.equal(await p.locator('#am-list li').count(), 1);
  await p.selectOption('#am-role', '');
  await p.keyboard.press('Escape');
  assert.match(await p.locator('#am-detail-body').innerText(), /Sélectionnez un membre/);
  ok('recherche, filtre par rôle, Échap ferme la fiche');

  // Lien direct
  const d2 = await open({ width: 1440, height: 900 }, '/admin/membres.html#u=u3');
  await d2.page.locator('#am-detail-body .am-name', { hasText: 'Chloé Rey' }).waitFor();
  assert.match(await d2.page.locator('#am-detail-body').innerText(), /Compte en attente/);
  ok('lien direct #u=… ouvre la fiche');

  // Mobile : liste puis fiche plein écran
  const m = await open({ width: 390, height: 844 });
  const q = m.page;
  assert.equal(await q.locator('#am-detail').isVisible(), false);
  assert.ok((await q.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 1, 'pas de défilement horizontal (liste)');
  await shot(q, '3-mobile-liste');
  await q.locator('.am-row', { hasText: 'Alice Martin' }).click();
  await q.locator('#am-detail').waitFor({ state: 'visible' });
  assert.equal(await q.locator('#am-left').isVisible(), false);
  assert.equal(await q.locator('#am-close').isVisible(), false);
  assert.ok((await q.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 1, 'pas de défilement horizontal (fiche)');
  await shot(q, '4-mobile-fiche');
  await q.click('#am-back');
  await q.locator('#am-left').waitFor({ state: 'visible' });
  assert.equal(await q.locator('#am-detail').isVisible(), false);
  ok('mobile : liste, fiche plein écran, retour, aucun débordement');

  // Changement de rôle depuis la fiche
  await p.locator('.am-row', { hasText: 'Eva Blanc' }).click();
  await p.locator('.am-rolesel').selectOption('nurse');
  await p.locator('#am-msg.ok', { hasText: 'rôle' }).waitFor();
  assert.match(await p.locator('.am-row.is-active').innerText(), /Infirmier/);
  ok('changement de rôle : la ligne est mise à jour');

  assert.deepEqual(errors, [], 'aucune erreur JavaScript ni console');
  ok('aucune erreur de console');
} finally { await browser.close(); server.close(); }
