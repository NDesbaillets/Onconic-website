// Oncoodle de bout en bout : le vrai navigateur pilote la vraie page contre le vrai SQL (PGlite). Aucune base distante, aucun e-mail.
// Nécessite Playwright et Chromium (voir README) : node tests/absences/oncoodle-e2e.mjs
import http from 'node:http';
import { createRequire } from 'node:module';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import assert from 'node:assert/strict';
import { makeDb, uid } from './oncoodle-db.mjs';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { console.log('Playwright absent : test de navigateur ignoré.'); process.exit(0); }
const ROOT = new URL('../../', import.meta.url).pathname;
const SHOTS = process.env.SHOTS_DIR || '';
const SETOF = new Set(['oncoodle_people', 'oncoodle_list']);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };

const db = await makeDb();
let queue = Promise.resolve();
const exclusive = (fn) => (queue = queue.then(fn, fn));
async function runRpc({ name, args, uid: who }) {
  return exclusive(async () => {
    await db.exec('reset role');
    await db.query("select set_config('test.uid',$1,false)", [who || '']);
    await db.exec('set role authenticated');
    const keys = Object.keys(args || {});
    const call = `public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')})`;
    const sql = SETOF.has(name) ? `select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) as data from ${call} r` : `select ${call} as data`;
    try { const r = await db.query(sql, keys.map((k) => args[k])); return { data: r.rows[0].data ?? null, error: null }; }
    catch (e) { return { data: null, error: { message: e.message, code: e.code } }; }
  });
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'POST' && url.pathname === '/__rpc') {
    let body = ''; for await (const c of req) body += c;
    res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(await runRpc(JSON.parse(body))));
  }
  const file = normalize(join(ROOT, decodeURIComponent(url.pathname)));
  if (!file.startsWith(ROOT)) { res.statusCode = 403; return res.end(); }
  try { res.setHeader('content-type', TYPES[extname(file)] || 'application/octet-stream'); res.end(await readFile(file)); }
  catch { res.statusCode = 404; res.end('404'); }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const BASE = `http://127.0.0.1:${server.address().port}`;

const MOCK = (who, role) => `
window.__calls = [];
const user = { id: '${who}', email: 'test@example.invalid' };
const rpc = async (name, args) => {
  window.__calls.push(name);
  const r = await fetch('/__rpc', { method: 'POST', body: JSON.stringify({ name, args: args || {}, uid: '${who}' }) });
  return r.json();
};
const q = { select: () => q, eq: () => q, single: async () => ({ data: { role: '${role}' } }) };
const sb = { auth: { getSession: async () => ({ data: { session: { user } } }), signOut: async () => ({ error: null }) }, from: () => q, rpc,
  functions: { invoke: async (n) => { window.__calls.push('fn:' + n); return { data: {}, error: null }; } } };
window.supabase = { createClient: () => sb };`;

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const errors = [];
async function open(n, role, path, viewport = { width: 1100, height: 900 }) {
  const ctx = await browser.newContext({ viewport, acceptDownloads: true });
  await ctx.addInitScript(MOCK(uid(n), role));
  await ctx.route('**/*', (r) => (r.request().url().startsWith(BASE) ? r.continue() : r.abort()));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${n}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`${n}: ${m.text()}`); });
  await page.goto(BASE + path);
  if (process.env.DEBUG_E2E) { await page.waitForTimeout(1500); console.log('STATUS', await page.locator('#oc-status').innerText(), errors); }
  return { ctx, page };
}
const shot = async (page, name) => { if (SHOTS) { await mkdir(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, name + '.png'), fullPage: true }); } };
const text = (page, sel) => page.locator(sel).innerText();
let step = 0;
const ok = (msg) => console.log(`ok ${++step} - ${msg}`);

try {
  // 1. L'organisateur (médecin assistant, Thoracique) crée un sondage à partir d'un modèle, avec un groupe et un participant obligatoire
  const a = await open(3, 'clinician', '/app/oncoodle.html');
  const pa = a.page;
  await pa.locator('#oc-tool').waitFor({ state: 'visible' });
  assert.match(await text(pa, '#oc-list'), /Aucun sondage ici pour le moment/);
  ok('liste vide au départ');
  await pa.click('#oc-new');
  await pa.selectOption('#oc-template', 'tumorboard');
  assert.equal(await pa.inputValue('input[name=title]'), 'Tumor board');
  await pa.fill('#g-from', '2026-11-16'); await pa.fill('#g-to', '2026-12-04');
  await pa.click('#g-run');
  assert.match(await text(pa, '#g-msg'), /créneaux? ajoutés?/);
  const nSlots = await pa.locator('#oc-slots li').count();
  assert.ok(nSlots >= 6, `créneaux générés : ${nSlots}`);
  await pa.fill('input[name=location]', 'Salle de colloque');
  // groupe : clinique Thoracique
  await pa.locator('.oc-rule .oc-opts').first().getByLabel('Thoracique', { exact: true }).check();
  await pa.locator('#oc-preview strong').filter({ hasText: 'personnes invitées' }).waitFor();
  assert.match(await text(pa, '#oc-preview'), /3 personnes invitées/);
  assert.match(await text(pa, '#oc-preview'), /Test 5/);
  await pa.locator('#oc-preview li', { hasText: 'Test 5' }).getByLabel('Obligatoire').check();
  // une personne choisie à la main, puis exclue du groupe par le champ d'exclusion
  await pa.fill('#oc-pick-in', 'test 11');
  await pa.locator('#oc-pick-list button', { hasText: 'Test 11' }).click();
  await pa.locator('#oc-preview strong').filter({ hasText: '4 personnes invitées' }).waitFor();
  await pa.fill('#oc-ex-in', 'test 10');
  await pa.locator('#oc-ex-list button', { hasText: 'Test 10' }).click();
  await pa.locator('#oc-preview strong').filter({ hasText: '3 personnes invitées' }).waitFor();
  assert.doesNotMatch(await text(pa, '#oc-preview'), /Test 10/);
  await shot(pa, '1-formulaire');
  await pa.click('#oc-submit');
  await pa.locator('#oc-detail h2').waitFor();
  assert.equal(await text(pa, '#oc-detail h2'), 'Tumor board');
  assert.match(await text(pa, '#oc-detail'), /Sondage créé/);
  assert.match(await text(pa, '#oc-detail'), /Lieu : Salle de colloque/);
  assert.ok((await pa.evaluate(() => window.__calls)).includes('fn:notify-oncoodle'), 'envoi immédiat sollicité');
  const pollId = Number(new URL(pa.url()).hash.slice(3));
  ok(`sondage créé (${nSlots} créneaux, 3 invités dont 1 obligatoire)`);

  // 2. Un invité (4) répond : oui au premier créneau, non au deuxième
  const b = await open(4, 'clinician', '/app/oncoodle.html');
  await b.page.locator('#oc-tool').waitFor({ state: 'visible' });
  assert.match(await text(b.page, '#oc-tabs'), /À répondre \(1\)/);
  await b.page.locator('.oc-card').first().click();
  await b.page.locator('#oc-detail table').first().waitFor();
  const rows = b.page.locator('#oc-detail table').first().locator('tbody tr');
  await rows.nth(0).getByRole('button', { name: 'Oui' }).click();
  await rows.nth(1).getByRole('button', { name: 'Non' }).click();
  await b.page.fill('.oc-comment input', 'Plutôt en présentiel');
  await shot(b.page, '2-reponse-mobile');
  await b.page.click('#oc-save');
  await b.page.locator('.form-msg.ok', { hasText: 'Réponses enregistrées' }).waitFor();
  assert.match(await text(b.page, '#oc-detail'), /Plutôt en présentiel/);
  assert.match(await text(b.page, '#oc-detail'), /1 sur 4 ont répondu/);
  ok('un invité répond et voit les réponses nominatives');

  // 3. Le participant obligatoire (5) refuse le premier créneau : l'organisateur est averti
  const c = await open(5, 'cadre', `/app/oncoodle.html#p=${pollId}`);
  const rowsC = c.page.locator('#oc-detail table').first().locator('tbody tr');
  await rowsC.nth(0).waitFor();
  await rowsC.nth(0).getByRole('button', { name: 'Non' }).click();
  await rowsC.nth(1).getByRole('button', { name: 'Oui' }).click();
  await rowsC.nth(2).getByRole('button', { name: 'Peut-être' }).click();
  await c.page.click('#oc-save');
  await c.page.locator('.form-msg.ok', { hasText: 'Réponses enregistrées' }).waitFor();
  ok('participant obligatoire répond');

  // 4. L'organisateur voit la synthèse, le refus d'un obligatoire et le meilleur choix, puis clôture
  await pa.reload();
  await pa.locator('#oc-detail table').first().waitFor();
  const detail = await text(pa, '#oc-detail');
  assert.match(detail, /1 participant obligatoire refuse/);
  assert.match(detail, /Meilleur choix/);
  assert.match(detail, /Pas encore répondu/);
  assert.match(detail, /Plutôt en présentiel/);
  assert.equal(await pa.locator('.oc-who tbody tr').count(), 4);
  await shot(pa, '3-synthese');
  assert.ok(await pa.getByRole('button', { name: /Relancer \(\d sans réponse\)/ }).isEnabled());
  await pa.getByRole('button', { name: /Relancer/ }).click();
  await pa.locator('.form-msg.ok', { hasText: 'relance' }).waitFor();
  assert.ok(await pa.getByRole('button', { name: /Relancer/ }).isDisabled(), 'une relance par 12 h');
  await pa.locator('.oc-table tr.best').first().getByRole('button', { name: 'Retenir' }).click();
  await pa.locator('#oc-dlg').waitFor({ state: 'visible' });
  await pa.fill('#oc-dlg textarea', 'Merci de venir avec vos cas');
  await shot(pa, '4-cloture');
  await pa.click('#oc-dlg-ok');
  await pa.locator('.oc-banner', { hasText: 'Date retenue' }).waitFor();
  assert.match(await text(pa, '.oc-banner'), /Merci de venir avec vos cas/);
  const [dl] = await Promise.all([pa.waitForEvent('download'), pa.getByRole('button', { name: /agenda \(\.ics\)/ }).click()]);
  assert.equal(dl.suggestedFilename(), 'oncoodle.ics');
  ok('synthèse, meilleur choix, relance, clôture et fichier agenda');

  // 5. Un invité voit le sondage clos ; un non-invité ne le voit pas
  await b.page.reload();
  await b.page.locator('.oc-banner', { hasText: 'Date retenue' }).waitFor();
  assert.equal(await b.page.locator('.oc-choice button').first().isDisabled().catch(() => true), true);
  const d = await open(7, 'nurse', `/app/oncoodle.html#p=${pollId}`);
  await d.page.locator('#oc-detail').waitFor();
  await d.page.locator('#oc-detail .form-msg.error').waitFor();
  assert.match(await text(d.page, '#oc-detail'), /introuvable/);
  ok('droits : invité en lecture seule après clôture, non-invité refusé');

  // 6. Modifier : ajout d'un destinataire (infirmier) à un sondage rouvert
  await pa.getByRole('button', { name: 'Rouvrir le sondage' }).click();
  await pa.locator('.form-msg.ok', { hasText: 'rouvert' }).waitFor();
  await pa.getByRole('button', { name: 'Modifier' }).click();
  await pa.locator('#oc-current li').first().waitFor();
  await pa.locator('.oc-rule').first().getByRole('button', { name: 'Retirer ce groupe' }).click().catch(() => {});
  await pa.click('#oc-add-rule');
  await pa.locator('.oc-rule .oc-opts').last().getByLabel('Infirmier·ères').check();
  await pa.locator('#oc-preview strong').filter({ hasText: '1 nouveau destinataire' }).waitFor();
  await pa.click('#oc-submit');
  await pa.locator('.form-msg.ok', { hasText: 'Modifications enregistrées' }).waitFor();
  assert.match(await text(pa, '#oc-detail'), /sur 5 ont répondu|sur 5/);
  ok('modification : destinataire ajouté par fonction');

  // 7. Le nouvel invité (infirmier) voit le sondage à répondre ; sondage de participation (rsvp) créé par la direction
  const e = await open(7, 'nurse', '/app/oncoodle.html');
  await e.page.locator('#oc-tool').waitFor({ state: 'visible' });
  assert.match(await text(e.page, '#oc-tabs'), /À répondre \(1\)/);
  const f = await open(2, 'direction', '/app/oncoodle.html');
  await f.page.locator('#oc-tool').waitFor({ state: 'visible' });
  await f.page.click('#oc-new');
  await f.page.locator('#oc-kind').getByLabel(/Participation à un événement/).check();
  await f.page.selectOption('#oc-template', 'repas');
  await f.page.fill('#m-day', '2026-12-10');
  await f.page.click('#m-add');
  await f.page.locator('#oc-rules .oc-rule').first().getByLabel('Tous les membres de The Hive').check();
  await f.page.locator('#oc-preview strong').filter({ hasText: /\d+ personnes invitées/ }).waitFor();
  assert.match(await text(f.page, '#oc-preview'), /9 personnes invitées/);
  await f.page.click('#oc-submit');
  await f.page.locator('#oc-detail h2').waitFor();
  assert.match(await text(f.page, '#oc-detail'), /Participation/);
  await f.page.getByRole('button', { name: "Confirmer l'événement" }).click();
  await f.page.locator('#oc-dlg-body input[type=checkbox]').check();
  await f.page.click('#oc-dlg-ok');
  await f.page.locator('.oc-banner', { hasText: 'Date retenue' }).waitFor();
  await exclusive(() => db.exec('reset role'));
  const cal = await db.query("select count(*)::int as n from absence_calendar where kind='evenement' and label='Repas d''équipe'");
  assert.equal(cal.rows[0].n, 1, 'la direction publie directement dans l\'agenda commun');
  ok('sondage de participation, tous les membres, agenda commun par la direction');

  // 8. Mobile : pas de défilement horizontal de la page
  const m = await open(4, 'clinician', `/app/oncoodle.html#p=${pollId}`, { width: 390, height: 844 });
  await m.page.locator('#oc-detail h2').waitFor();
  const overflow = await m.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 1, `débordement horizontal : ${overflow}px`);
  await shot(m.page, '5-mobile-detail');
  await m.page.goto(BASE + '/app/oncoodle.html'); await m.page.locator('#oc-tool').waitFor({ state: 'visible' });
  await m.page.click('#oc-new'); await m.page.locator('#oc-form').waitFor({ state: 'visible' });
  const wide = await m.page.evaluate(() => [...document.querySelectorAll('#oc-form *')].filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1).slice(0, 5).map((e) => `${e.tagName}#${e.id}.${e.className}:${Math.round(e.getBoundingClientRect().right)}`));
  assert.ok((await m.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 1, 'formulaire mobile ' + wide.join(' | '));
  await shot(m.page, '6-mobile-formulaire');
  ok('mobile : aucun débordement horizontal');

  assert.deepEqual(errors, [], 'aucune erreur JavaScript ni console');
  ok('aucune erreur de console');
} finally {
  await browser.close(); server.close(); await db.close();
}
