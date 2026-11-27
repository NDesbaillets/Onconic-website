// Tri des listes de personnes (assets/js/name-sort.js) : module pur, sans base de données.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const S = require('../../assets/js/name-sort.js');
const names = (list, mode, ctx) => S.sortPeople(list, { mode, ctx });

test('splitName : particules, prénoms composés, titres, mot unique, vide', () => {
  assert.deepEqual(S.splitName('Maria de la Cruz'), { first: 'Maria', last: 'de la Cruz', empty: false });
  assert.equal(S.splitName('Jean-Pierre Müller').last, 'Müller');
  assert.equal(S.splitName('Jean-Pierre Müller').first, 'Jean-Pierre');
  assert.equal(S.splitName('Hans von Arx').last, 'von Arx');
  assert.equal(S.splitName('Dr Sophie Martin').last, 'Martin');
  assert.equal(S.splitName('Dr Sophie Martin').first, 'Sophie');
  assert.equal(S.splitName('Prof. Dr med. Paul Roch').first, 'Paul');
  assert.equal(S.splitName('PD Luc Blanc').last, 'Blanc');
  assert.equal(S.splitName('Dre Eva Noir').last, 'Noir');
  assert.equal(S.splitName('Madonna').last, 'Madonna');
  assert.equal(S.splitName('Dr').last, 'Dr', 'un titre seul reste un nom');
  assert.equal(S.splitName('').empty, true);
  assert.equal(S.splitName(null).empty, true);
  assert.equal(S.splitName('(sans nom)').empty, true);
  assert.equal(S.splitName('Jean DE LA Tour').last, 'DE LA Tour', 'insensible à la casse');
});

test('splitName : objet avec first et last, ou name seul', () => {
  assert.deepEqual(S.splitName({ first: 'Anne', last: 'de Rham', name: 'Anne de Rham' }), { first: 'Anne', last: 'de Rham', empty: false });
  assert.equal(S.splitName({ first_name: 'Paul', last_name: 'Van Gogh' }).last, 'Van Gogh');
  assert.equal(S.splitName({ name: 'Eva Blanc' }).last, 'Blanc');
  assert.equal(S.splitName({ first: 'Eva', last: '', name: 'Eva Blanc' }).last, 'Blanc');
  assert.equal(S.splitName({ name: '' }).empty, true);
});

test('tri par famille : Dupond avant Dupont malgré les accents du prénom, vides en dernier dans tous les modes', () => {
  const list = ['Émile Dupont', 'Eric Dupond', '', 'Anna Zed', '(sans nom)'];
  for (const m of ['family', 'first', 'role', 'clinic']) {
    const out = names(list, m);
    assert.deepEqual(out.slice(-2).sort(), ['', '(sans nom)'], m);
  }
  assert.deepEqual(names(list, 'family').slice(0, 3), ['Eric Dupond', 'Émile Dupont', 'Anna Zed']);
  assert.deepEqual(names(list, 'first').slice(0, 3), ['Anna Zed', 'Émile Dupont', 'Eric Dupond']);
});

test('tri sans paramètre : par défaut famille, copie sans modifier la liste', () => {
  const list = ['Zoé Arnaud', 'Alice Zimmer', 'Bob Martin'];
  const copy = list.slice();
  assert.deepEqual(S.sortPeople(list), ['Zoé Arnaud', 'Bob Martin', 'Alice Zimmer']);
  assert.deepEqual(list, copy);
  assert.deepEqual(S.sortPeople(list, { mode: 'first' }), ['Alice Zimmer', 'Bob Martin', 'Zoé Arnaud']);
});

test('modes role et clinic, accesseur get, égalités départagées par identifiant', () => {
  const rows = [
    { id: 'c', who: { id: 'c', name: 'Cécile Roy', role: 'nurse', clinics: ['ORL'] } },
    { id: 'a', who: { id: 'a', name: 'Alain Roy', role: 'cadre', clinics: ['Urologie', 'ORL'] } },
    { id: 'b', who: { id: 'b', name: 'Boris Adam', role: 'cadre', clinics: [] } },
    { id: 'd', who: { id: 'd', name: 'Dora Abel', role: 'inconnu', clinics: ['Thoracique'] } },
  ];
  const get = (x) => x.who;
  const ids = (mode, ctx) => S.sortPeople(rows, { mode, get, ctx }).map((x) => x.id);
  assert.deepEqual(ids('role', { roleOrder: { cadre: 1, nurse: 5 } }), ['b', 'a', 'c', 'd']);
  assert.deepEqual(ids('role', { roleOrder: ['cadre', 'nurse'] }), ['b', 'a', 'c', 'd']);
  assert.deepEqual(ids('clinic'), ['c', 'd', 'a', 'b'], 'première clinique ; sans clinique en dernier');
  assert.deepEqual(ids('family'), ['d', 'b', 'a', 'c']);
  const twins = [{ id: '2', name: 'Eva Blanc' }, { id: '1', name: 'Eva Blanc' }, { id: '3', name: 'Eva Blanc' }];
  assert.deepEqual(S.sortPeople(twins).map((x) => x.id), ['1', '2', '3']);
  assert.deepEqual(S.sortPeople(twins.slice().reverse()).map((x) => x.id), ['1', '2', '3']);
});

test('tri famille avec objets first/last', () => {
  const list = [{ id: '1', first: 'Zoé', last: 'Abel' }, { id: '2', first: 'Anne', last: 'Zed' }, { id: '3', first: 'Anne', last: 'Abel' }];
  assert.deepEqual(S.sortPeople(list).map((x) => x.id), ['3', '1', '2']);
  assert.deepEqual(S.sortPeople(list, { mode: 'first' }).map((x) => x.id), ['3', '2', '1']);
});

function fakeStorage(store) {
  return { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
}

test('préférence : stockage, valeur corrompue, stockage indisponible', () => {
  const store = {};
  globalThis.localStorage = fakeStorage(store);
  try {
    assert.equal(S.getMode('x'), 'family');
    assert.equal(S.setMode('x', 'first'), true);
    assert.equal(store['onconic.sort.x'], 'first');
    assert.equal(S.getMode('x'), 'first');
    assert.equal(S.getMode('x', ['family']), 'family', 'mode non proposé par la liste');
    assert.equal(S.setMode('x', 'nimporte'), false);
    store['onconic.sort.x'] = '<script>';
    assert.equal(S.getMode('x'), 'family');
    globalThis.localStorage = { getItem() { throw new Error('indisponible'); }, setItem() { throw new Error('plein'); } };
    assert.equal(S.getMode('x'), 'family');
    assert.equal(S.setMode('x', 'first'), false);
  } finally { delete globalThis.localStorage; }
  assert.equal(S.getMode('y'), 'family', 'aucun localStorage du tout');
});

test('le module ne passe jamais par innerHTML ni par un style en ligne', () => {
  const src = readFileSync(new URL('../../assets/js/name-sort.js', import.meta.url), 'utf8');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\.style\b|setAttribute\(\s*["']style/.test(src));
});
