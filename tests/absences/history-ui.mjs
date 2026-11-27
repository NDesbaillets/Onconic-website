// Absences : onglet Historique, recherche par numéro, pastilles de numéro et archivage. Serveur statique et réponses simulées (aucune base distante, données fictives).
// Nécessite Playwright : NODE_PATH=/opt/node-tools/node_modules node tests/absences/history-ui.mjs
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

const MOCK = `
window.__calls = [];
const P = (id, name, clinics, me) => ({ id, name, role: 'clinician', clinics, is_me: !!me });
const people = [P('me', 'Cadre Fictive', ['Thoracique'], true), P('alice', 'Alice Fictive', ['Thoracique'])];
const H = (i, extra) => Object.assign({ id: i, request_no: '2026-' + String(i).padStart(4, '0'), user_id: i % 2 ? 'alice' : 'me', name: i % 2 ? 'Alice Fictive' : 'Cadre Fictive', kind: 'vacances', note: null,
  start_date: '2027-03-0' + (1 + i % 5), end_date: '2027-03-0' + (2 + i % 5), status: 'approved', change_type: null, change_kind: null, change_start: null, change_end: null,
  submitted_at: '2026-11-10T10:00:00Z', decided_at: '2026-11-12T10:00:00Z', decided_by_name: 'Direction Fictive', decision: 'approved', decision_comment: null, archived_at: null, circuit_name: 'Circuit général' }, extra || {});
const all = Array.from({ length: 60 }, (_, i) => H(i + 1));
all[1] = H(2, { status: 'rejected', decision: 'rejected', decision_comment: 'Motif fictif', archived_at: '2026-11-20T10:00:00Z' });
const MINE = [{ id: 77, user_id: 'me', kind: 'vacances', status: 'rejected', start_date: '2027-05-03', end_date: '2027-05-04', note: null, change_type: null, decision: 'rejected', decision_comment: 'Refus fictif',
  decided_at: new Date().toISOString(), submitted_at: '2026-11-10T10:00:00Z', request_no: '2026-0077', confidential: false }];
const rpc = async (name, args) => {
  window.__calls.push({ name, args });
  const ok = (data) => ({ data, error: null });
  switch (name) {
    case 'absence_context': return ok({ me: 'me', role: 'cadre', clinics: ['Thoracique'], validates: ['Thoracique'], pending: 0 });
    case 'absence_people': return ok(people);
    case 'absence_clinics': return ok([{ clinic: 'Thoracique', max_absent: 2 }]);
    case 'absence_grid': return ok([]);
    case 'absence_calendar': return ok([]);
    case 'absence_pending_count': return ok(0);
    case 'absence_to_validate': return ok([]);
    case 'absence_list': return ok(JSON.parse(JSON.stringify(MINE)));
    case 'absence_approvals_all': case 'absence_rejected_to_manage': return ok([]);
    case 'absence_delete_rejected': return ok(null);
    case 'absence_agenda_context': return { data: null, error: { message: 'absent' } };
    case 'absence_notification_status': return ok({ pending: 0, failed: 0, sent: 0 });
    case 'absence_requests_history': { const p = args.p_status ? all.filter((x) => args.p_status.includes(x.status)) : all; return ok(p.slice(args.p_offset, args.p_offset + args.p_limit)); }
    case 'absence_find': return ok(String(args.p_q).split(/[^0-9]+/).pop().replace(/^0+/, '') === '12' ? [all[11]] : []);
    default: return ok(null);
  }
};
window.supabase = { createClient: () => ({
  auth: { getSession: async () => ({ data: { session: { user: { id: 'me' } } } }), signOut: async () => ({ error: null }) },
  rpc, functions: { invoke: async () => ({ data: null, error: null }) },
  from: () => { const q = { select: () => q, eq: () => q, single: async () => ({ data: { role: 'cadre' } }), then: (r) => Promise.resolve({ data: [], error: null }).then(r) }; return q; } }) };`;

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const errors = [];
let step = 0; const ok = (m) => console.log(`ok ${++step} - ${m}`);
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.clock.setFixedTime(new Date('2026-11-18T10:00:00'));
  await ctx.addInitScript(MOCK);
  await ctx.route('**/*', (r) => (r.request().url().startsWith(BASE) ? r.continue() : r.abort()));
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  p.on('dialog', (d) => d.accept());
  await p.goto(BASE + '/app/absences.html');
  await p.locator('#ab-tool').waitFor({ state: 'visible' });
  const calls = (name) => p.evaluate((n) => window.__calls.filter((c) => c.name === n), name);

  // Mes absences : pastille du numéro, « Archiver » à la place de « Supprimer »
  await p.locator('#ab-t-mine').click();
  await p.locator('#ab-mine-list .ab-item').first().waitFor();
  assert.equal((await p.locator('#ab-mine-list .ab-no').first().innerText()).trim(), 'N° 2026-0077');
  assert.equal(await p.getByRole('button', { name: 'Archiver', exact: true }).count(), 1);
  assert.equal(await p.getByRole('button', { name: 'Supprimer', exact: true }).count(), 0);
  assert.match(await p.locator('#ab-mine-list').innerText(), /reste consultable dans l'historique/);
  await p.getByRole('button', { name: 'Archiver', exact: true }).click();
  await p.waitForFunction(() => window.__calls.some((c) => c.name === 'absence_delete_rejected'));
  assert.match(await p.locator('#ab-mine-msg').innerText(), /archivée/);
  ok('Mes absences : numéro, archivage, message d\'historique');

  // Historique : visible pour tous, première page de 50, « Charger la suite »
  assert.equal(await p.locator('#ab-t-hist').isVisible(), true);
  await p.locator('#ab-t-hist').click();
  await p.locator('#ab-hist-list .ab-item').first().waitFor();
  assert.equal(await p.locator('#ab-hist-list .ab-item').count(), 50);
  assert.equal(await p.locator('#ab-hist-more').isVisible(), true);
  assert.equal((await p.locator('#ab-hist-list .ab-item .ab-no').first().innerText()).trim(), 'N° 2026-0001');
  assert.match(await p.locator('#ab-hist-list .ab-item').nth(1).innerText(), /Refusée[\s\S]*Archivée|Archivée[\s\S]*Refusée/);
  assert.match(await p.locator('#ab-hist-list .ab-item').nth(1).innerText(), /Motif fictif/);
  await p.locator('#ab-hist-more').click();
  await p.waitForFunction(() => document.querySelectorAll('#ab-hist-list .ab-item').length === 60);
  assert.equal(await p.locator('#ab-hist-more').isVisible(), false);
  assert.deepEqual((await calls('absence_requests_history')).map((c) => c.args.p_offset), [0, 50]);
  ok('Historique : liste paginée, statut, archivée, motif de refus');

  // Personne : visible car l'appelant voit plusieurs personnes ; statut transmis au serveur
  assert.equal(await p.locator('#ab-hist-who-wrap').isVisible(), true);
  await p.locator('#ab-hist-status').selectOption('rejected');
  await p.waitForFunction(() => document.querySelectorAll('#ab-hist-list .ab-item').length === 1);
  assert.deepEqual((await calls('absence_requests_history')).at(-1).args.p_status, ['rejected']);
  ok('filtres : statut côté serveur');

  // Recherche : un numéro appelle absence_find, un texte passe par p_q
  await p.locator('#ab-hist-status').selectOption('');
  await p.locator('#ab-hist-q').fill('2026-0012');
  await p.locator('#ab-hist-go').click();
  await p.waitForFunction(() => window.__calls.some((c) => c.name === 'absence_find'));
  await p.waitForFunction(() => document.querySelectorAll('#ab-hist-list .ab-item').length === 1);
  assert.equal((await p.locator('#ab-hist-list .ab-no').innerText()).trim(), 'N° 2026-0012');
  assert.equal(await p.locator('#ab-hist-more').isVisible(), false);
  await p.locator('#ab-hist-q').fill('12');
  await p.locator('#ab-hist-go').click();
  await p.waitForFunction(() => window.__calls.filter((c) => c.name === 'absence_find').length === 2);
  await p.locator('#ab-hist-q').fill('0099');
  await p.locator('#ab-hist-go').click();
  await p.waitForFunction(() => /Aucune demande trouvée/.test(document.getElementById('ab-hist-list').innerText));
  const before = (await calls('absence_requests_history')).length;
  await p.locator('#ab-hist-q').fill('Alice');
  await p.locator('#ab-hist-go').click();
  await p.waitForFunction((n) => window.__calls.filter((c) => c.name === 'absence_requests_history').length > n, before);
  const last = (await calls('absence_requests_history')).at(-1).args;
  assert.equal(last.p_q, 'Alice'); assert.equal(last.p_offset, 0);
  assert.equal((await calls('absence_find')).length, 3);
  ok('recherche : numéro complet ou partiel via absence_find, texte via p_q');

  const wide = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  assert.equal(wide, false, 'pas de défilement horizontal de la page');
  await ctx.close();
  assert.deepEqual(errors, [], 'aucune erreur de console');
  ok('aucune erreur de console');
} finally {
  await browser.close();
  server.close();
}
