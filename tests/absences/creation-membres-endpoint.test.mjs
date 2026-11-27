// Exécute le vrai gestionnaire de member-create avec Supabase simulé : droits, liste blanche des rôles, nettoyage du compte, journaux.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const calls = { rights: [], check: [], taken: [], create: [], invite: [], apply: [], del: [] };
let checkError = null, createdAt = null, taken = false, applyHook = null;
const logs = [];
let delError = null, allowed = true, rightsError = null, applyError = null, authError = null, user = { id: 'caller-1' };
globalThis.cmAdmin = {
  auth: {
    getUser: async () => ({ data: { user } }),
    admin: {
      createUser: async (a) => { calls.create.push(a); return authError ? { data: {}, error: authError } : { data: { user: { id: 'new-1', created_at: createdAt ?? new Date().toISOString() } }, error: null }; },
      inviteUserByEmail: async (e, o) => { calls.invite.push([e, o]); return authError ? { data: {}, error: authError } : { data: { user: { id: 'new-2', created_at: createdAt ?? new Date().toISOString() } }, error: null }; },
      deleteUser: async (id) => { calls.del.push(id); throw new Error('deleteUser ne doit jamais être appelé'); },
    },
  },
  rpc: async (name, args) => {
    if (name === 'member_email_taken') { calls.taken.push(args); return { data: taken, error: null }; }
    assert.equal(name, 'member_create_apply'); calls.apply.push(args); if (applyHook) return applyHook(); return { error: applyError }; },
};
globalThis.cmCaller = { rpc: async (name, args) => {
  if (name === 'member_create_check') { calls.check.push(args); return { error: checkError }; }
  assert.equal(name, 'member_create_allowed'); calls.rights.push(args); return { data: rightsError ? null : allowed, error: rightsError }; } };
globalThis.Deno = { env: { get: (k) => (k === 'SUPABASE_URL' ? 'https://uubowlcyekbgmizrlyxb.supabase.co' : 'fictif') }, serve: (h) => { globalThis.cmHandler = h; } };
for (const k of ['log', 'error', 'warn', 'info']) console[k] = (...a) => { logs.push(a.map(String).join(' ')); };

let source = await readFile(new URL('../../supabase/functions/member-create/index.ts', import.meta.url), 'utf8');
source = source.replace('import { createClient } from "npm:@supabase/supabase-js@2.57.4";', 'const createClient = (u, k, o) => (o && o.global ? globalThis.cmCaller : globalThis.cmAdmin);');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));

const base = { first_name: ' Alice ', last_name: 'Martin', email: 'Alice.Martin@Example.com', role: 'clinician', institution: 'CHUV', clinics: ['ORL', 'ORL', ' ION '], cdc_clinics: [], mode: 'password' };
const post = (body, headers = {}) => globalThis.cmHandler(new Request('https://example.invalid/member-create', {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer jwt', origin: 'https://onconic.ch', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }));
const reset = () => {
  for (const k of Object.keys(calls)) calls[k].length = 0;
  logs.length = 0; checkError = null; createdAt = null; taken = false; applyHook = null; delError = null; allowed = true; rightsError = null; applyError = null; authError = null; user = { id: 'caller-1' };
};

test('appelant sans session valide : 401, aucun compte créé', async () => {
  reset(); user = null;
  const r = await post(base);
  assert.equal(r.status, 401); assert.equal((await r.json()).error, 'unauthorized');
  assert.equal(calls.create.length + calls.invite.length, 0);
});

test('méthode, JSON invalide et préflight', async () => {
  reset();
  assert.equal((await globalThis.cmHandler(new Request('https://example.invalid/x', { method: 'GET' }))).status, 405);
  assert.equal((await globalThis.cmHandler(new Request('https://example.invalid/x', { method: 'OPTIONS', headers: { origin: 'https://onconic.pages.dev' } }))).headers.get('access-control-allow-origin'), 'https://onconic.pages.dev', 'aperçu accepté sur le projet de test');
  const r = await post('pas du json');
  assert.equal(r.status, 400); assert.equal((await r.json()).error, 'invalid_json');
});

test('rôle hors liste blanche (admin, member, inconnu, absent) : 400 avant tout droit ou création', async () => {
  for (const role of ['admin', 'member', 'superadmin', '', undefined, 'clinician ', 'DIRECTION']) {
    reset();
    const r = await post({ ...base, role });
    const j = await r.json();
    // « clinician » avec espace est nettoyé (trim) : seule la liste blanche compte
    if (role === 'clinician ') { assert.equal(r.status, 200); continue; }
    assert.equal(r.status, 400, String(role)); assert.equal(j.error, 'invalid_role');
    assert.equal(calls.rights.length + calls.create.length + calls.invite.length, 0, String(role));
  }
});

test('appelant refusé par la base (ou erreur de contrôle) : 403 forbidden, aucun compte créé', async () => {
  reset(); allowed = false;
  let r = await post({ ...base, role: 'direction' });
  assert.equal(r.status, 403); assert.equal((await r.json()).error, 'forbidden');
  assert.deepEqual(calls.rights, [{ p_role: 'direction' }]);
  assert.equal(calls.create.length + calls.invite.length + calls.apply.length, 0);
  reset(); rightsError = { message: 'fonction absente' };
  r = await post(base);
  assert.equal(r.status, 403);
  assert.equal(calls.create.length, 0);
});

test('création avec mot de passe : réponse unique avec le mot de passe, profil complété avec les données nettoyées', async () => {
  reset();
  const r = await post({ ...base, first_name: '<b>Alice</b>\u0007 ', role: 'cdc', cdc_clinics: ['Urologie'] });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true); assert.equal(j.id, 'new-1'); assert.equal(j.mode, 'password');
  assert.match(j.password, /^[A-Za-z2-9]{4}-[A-Za-z2-9]{4}-[A-Za-z2-9]{4}-[A-Za-z2-9]{4}$/);
  assert.equal(calls.create.length, 1);
  assert.equal(calls.create[0].email, 'alice.martin@example.com'); assert.equal(calls.create[0].email_confirm, true);
  assert.equal(calls.create[0].password, j.password);
  assert.deepEqual(calls.apply, [{ p_actor: 'caller-1', p_user: 'new-1', p_role: 'cdc', p_first: 'bAlice/b', p_last: 'Martin', p_institution: 'CHUV',
    p_clinics: ['ORL', 'ION'], p_cdc_clinics: ['Urologie'], p_mode: 'password' }]);
  assert.equal(calls.del.length, 0);
});

test('invitation : lien de retour vers le site (aperçu accepté sur le projet de test), pas de mot de passe', async () => {
  reset();
  let r = await post({ ...base, mode: 'invite', role: 'nurse' });
  let j = await r.json();
  assert.equal(r.status, 200); assert.equal(j.mode, 'invite'); assert.equal(j.password, undefined); assert.equal(j.id, 'new-2');
  assert.equal(calls.invite[0][1].redirectTo, 'https://onconic.ch/fr/nouveau-mot-de-passe.html');
  reset();
  await post({ ...base, mode: 'invite' }, { origin: 'https://abc.onconic.pages.dev' });
  assert.equal(calls.invite[0][1].redirectTo, 'https://abc.onconic.pages.dev/fr/nouveau-mot-de-passe.html');
  reset();
  await post({ ...base, mode: 'invite' }, { origin: 'https://evil.example.com' });
  assert.equal(calls.invite[0][1].redirectTo, 'https://onconic.ch/fr/nouveau-mot-de-passe.html');
});

test('si member_create_apply échoue : 500 profile_failed, le compte reste en attente, aucune suppression', async () => {
  for (const mode of ['password', 'invite']) for (const code of ['P0001', '42501', '57014', undefined]) {
    reset(); applyError = { code, message: 'Alice.Martin@Example.com' };
    const r = await post({ ...base, mode });
    assert.equal(r.status, 500); assert.equal((await r.json()).error, 'profile_failed');
    assert.equal(calls.apply.length, 1);
    assert.ok(!/alice|martin|example\.com/i.test(logs.join('\n')));
  }
});

test('« déjà un rôle » (OC003) : 409 user_exists sans suppression', async () => {
  for (const mode of ['password', 'invite']) {
    reset(); applyError = { code: 'OC003', message: 'Ce compte a déjà un rôle.' };
    const r = await post({ ...base, mode });
    assert.equal(r.status, 409); assert.equal((await r.json()).error, 'user_exists');
  }
});

test('compte plus ancien renvoyé par l\'invitation : jamais supprimé, apply tranche', async () => {
  reset(); createdAt = new Date(Date.now() - 3600 * 1000).toISOString(); applyError = { code: '42501' };
  const r = await post({ ...base, mode: 'invite' });
  assert.equal(r.status, 500);
});

test('e-mail existant : 409 user_exists, rien n\'est appliqué ; autres échecs : 502', async () => {
  reset(); authError = { code: 'email_exists', status: 422, message: 'already registered' };
  let r = await post(base);
  assert.equal(r.status, 409); assert.equal((await r.json()).error, 'user_exists');
  assert.equal(calls.apply.length, 0);
  reset(); authError = { code: 'unexpected', status: 500, message: 'boom' };
  r = await post({ ...base, mode: 'invite' });
  assert.equal(r.status, 502); assert.equal((await r.json()).error, 'invite_failed');
  reset(); authError = { code: 'unexpected', status: 500, message: 'boom' };
  r = await post(base);
  assert.equal(r.status, 502); assert.equal((await r.json()).error, 'create_failed');
});

test('entrées invalides : e-mail, nom, institution', async () => {
  for (const [patch, code] of [[{ email: 'pas-un-mail' }, 'invalid_email'], [{ email: 'a b@example.com' }, 'invalid_email'], [{ last_name: '  ' }, 'invalid_name'],
    [{ first_name: '' }, 'invalid_name'], [{ institution: 'Ailleurs' }, 'invalid_institution']]) {
    reset();
    const r = await post({ ...base, ...patch });
    assert.equal(r.status, 400, code); assert.equal((await r.json()).error, code);
    assert.equal(calls.create.length + calls.invite.length, 0);
  }
  reset();
  await post({ ...base, institution: undefined });
  assert.equal(calls.apply[0].p_institution, 'CHUV', 'défaut CHUV');
});

test('journaux : ni mot de passe ni adresse ni nom, y compris en cas d\'échec', async () => {
  reset();
  const ok = await (await post(base)).json();
  reset(); applyError = { code: 'P0001', message: 'Alice.Martin@Example.com Alice Martin' };
  await post(base);
  reset(); authError = { code: 'email_exists', status: 422, message: 'alice.martin@example.com already registered' };
  await post(base);
  reset(); authError = { code: 'email_exists', status: 422, message: 'alice.martin@example.com already registered' };
  await post({ ...base, mode: 'invite' });
  const all = logs.join('\n');
  assert.ok(ok.password);
  assert.ok(!all.includes(ok.password));
  assert.ok(!/alice|martin|example\.com/i.test(all), all);
});

test('contrôle préalable : clinique ou institution refusée par la base, aucun compte ni invitation créé', async () => {
  for (const [code, err] of [['OC002', 'invalid_clinics'], ['OC001', 'invalid_institution']]) {
    reset(); checkError = { code, message: 'x' };
    const r = await post({ ...base, mode: 'invite' });
    assert.equal(r.status, 400); assert.equal((await r.json()).error, err);
    assert.equal(calls.create.length + calls.invite.length + calls.apply.length, 0);
  }
  reset(); checkError = { code: '42501', message: 'x' };
  assert.equal((await post(base)).status, 403);
  reset();
  await post({ ...base, role: 'cadre', cdc_clinics: ['ORL'] });
  assert.deepEqual(calls.check, [{ p_role: 'cadre', p_clinics: ['ORL', 'ION'], p_cdc_clinics: ['ORL'], p_institution: 'CHUV' }]);
});

test('adresse déjà prise : 409 sans appel à Auth (ni invitation, ni création, ni suppression), adresse normalisée', async () => {
  for (const mode of ['invite', 'password']) {
    reset(); taken = true;
    const r = await post({ ...base, mode });
    assert.equal(r.status, 409); assert.equal((await r.json()).error, 'user_exists');
    assert.equal(calls.create.length + calls.invite.length + calls.del.length + calls.apply.length, 0);
    assert.deepEqual(calls.taken, [{ p_email: 'alice.martin@example.com' }]);
  }
});

test('deux requêtes concurrentes sur le même compte : la seconde échoue en OC003, aucune suppression', async () => {
  reset();
  let n = 0;
  applyHook = async () => (++n === 1 ? { error: null } : { error: { code: 'OC003', message: 'Ce compte a déjà un rôle.' } });
  const [r1, r2] = await Promise.all([post({ ...base, mode: 'invite' }), post({ ...base, mode: 'invite' })]);
  const statuses = [r1.status, r2.status].sort();
  assert.deepEqual(statuses, [200, 409]);
  assert.equal(calls.del.length, 0, 'le compte doté d\'un rôle par l\'autre requête n\'est jamais supprimé');
  assert.ok(!logs.join('\n').match(/alice|example\.com/i));
});


test.afterEach(() => { assert.equal(calls.del.length, 0, 'deleteUser n\'a jamais été appelé'); });
