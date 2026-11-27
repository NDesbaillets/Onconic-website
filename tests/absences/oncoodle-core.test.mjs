import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { buildIcs as serverIcs } from '../../supabase/functions/notify-oncoodle/ics.ts';
const require_ = createRequire(import.meta.url);
const core = require_('../../assets/js/oncoodle-core.js');

test('jours fériés vaudois 2026 et 2027 (Pâques, Ascension, Jeûne fédéral)', () => {
  const h = (y) => Object.fromEntries([...core.holidays(y)].map(([d, l]) => [l, d]));
  assert.deepEqual(h(2026), { 'Nouvel An': '2026-01-01', '2 janvier': '2026-01-02', 'Vendredi saint': '2026-04-03', 'Lundi de Pâques': '2026-04-06', Ascension: '2026-05-14',
    'Lundi de Pentecôte': '2026-05-25', 'Fête nationale': '2026-08-01', 'Lundi du Jeûne fédéral': '2026-09-21', Noël: '2026-12-25' });
  assert.equal(core.holidayOf('2027-03-26'), 'Vendredi saint');
  assert.equal(core.holidayOf('2026-11-20'), null);
});

test('générateur de créneaux : jours de semaine, heures, fériés, passé, plafond', () => {
  const g = core.generateSlots({ from: '2026-11-16', to: '2026-11-27', weekdays: [2, 4], starts: ['12:00'], duration: 60 });
  assert.deepEqual(g.slots.map((s) => `${s.day} ${s.start}-${s.end}`), ['2026-11-17 12:00-13:00', '2026-11-19 12:00-13:00', '2026-11-24 12:00-13:00', '2026-11-26 12:00-13:00']);
  const noel = core.generateSlots({ from: '2026-12-24', to: '2027-01-05', weekdays: [1, 2, 3, 4, 5], starts: ['08:00'], duration: 30 });
  assert.ok(!noel.slots.some((s) => ['2026-12-25', '2027-01-01'].includes(s.day)));
  assert.ok(core.generateSlots({ from: '2026-12-24', to: '2027-01-05', skipHolidays: false, weekdays: [5], starts: ['08:00'], duration: 30 }).slots.some((s) => s.day === '2026-12-25'));
  assert.ok(core.generateSlots({ from: '2026-11-10', to: '2026-11-20', today: '2026-11-18', weekdays: [1, 2, 3, 4, 5], starts: ['09:00'], duration: 60 }).slots.every((s) => s.day >= '2026-11-18'));
  const day = core.generateSlots({ from: '2026-11-17', to: '2026-11-17', weekdays: [2], duration: 0 });
  assert.deepEqual(day.slots, [{ day: '2026-11-17', start: null, end: null }]);
  const big = core.generateSlots({ from: '2026-11-16', to: '2027-02-10', weekdays: [1, 2, 3, 4, 5], starts: ['08:00', '09:00'], duration: 30 });
  assert.equal(big.slots.length, 40); assert.equal(big.truncated, true);
  assert.match(core.generateSlots({ from: '2026-11-16', to: '2027-12-31' }).error, /trop longue/);
  assert.match(core.generateSlots({ from: '2026-11-20', to: '2026-11-16' }).error, /invalide/);
  assert.equal(core.generateSlots({ from: '2026-11-17', to: '2026-11-17', weekdays: [2], starts: ['23:30'], duration: 60 }).slots.length, 0, 'un créneau ne déborde pas sur le lendemain');
});

test('fusion de créneaux : sans doublon, triés, plafonnés', () => {
  const a = [{ day: '2026-11-24', start: '12:00', end: '13:00' }];
  const m = core.mergeSlots(a, [{ day: '2026-11-24', start: '12:00', end: '13:00' }, { day: '2026-11-20', start: null, end: null }, { day: '2026-11-20', start: '08:00', end: '09:00' }]);
  assert.deepEqual(m.map(core.slotKey), ['2026-11-20||', '2026-11-20|08:00|09:00', '2026-11-24|12:00|13:00']);
  assert.equal(core.mergeSlots(a, [{ day: '2026-12-01', start: null, end: null }], 1).length, 1);
});

test('classement : obligatoires d\'abord, puis score, non, absents, date', () => {
  const o = (id, day, yes, maybe, no, req_no = 0, absent = 0) => ({ id, day, start: '12:00', yes, maybe, no, req_no, absent });
  const r = core.rank([o(1, '2026-11-20', 5, 0, 1, 1), o(2, '2026-11-24', 4, 2, 0), o(3, '2026-11-26', 4, 2, 0, 0, 2), o(4, '2026-11-27', 3, 0, 0)]);
  assert.deepEqual(r.map((x) => x.id), [2, 3, 4, 1]);
  assert.deepEqual(r.filter((x) => x.best).map((x) => x.id), [2], 'le créneau avec moins d\'absents est seul retenu');
  assert.equal(r.find((x) => x.id === 1).eligible, false);
  assert.equal(r.find((x) => x.id === 1).score, 5);
  const tie = core.rank([o(1, '2026-11-20', 2, 0, 0), o(2, '2026-11-24', 2, 0, 0)]);
  assert.deepEqual(tie.filter((x) => x.best).map((x) => x.id), [1, 2], 'égalité parfaite : les deux sont signalés');
  assert.deepEqual(core.rank([o(1, '2026-11-20', 0, 0, 0)]).filter((x) => x.best), [], 'aucune réponse : pas de meilleur créneau');
  assert.deepEqual(core.rank([o(1, '2026-11-20', 3, 0, 0, 1)]).filter((x) => x.best), [], 'seul créneau refusé par un obligatoire : pas de meilleur');
});

test('fichier agenda : identique côté page et côté serveur', () => {
  const now = new Date('2026-11-13T10:00:00Z');
  for (const e of [{ id: 7, title: 'Colloque, thoracique; salle', location: 'BH10', day: '2026-11-20', start: '12:00', end: '13:00' }, { id: 8, title: 'x'.repeat(150), day: '2026-12-31' }])
    assert.equal(core.buildIcs(e, now), serverIcs(e, now));
});

test('destinataires : nettoyage et libellés', () => {
  const a = core.cleanAudience({ rules: [{ clinics: [], roles: [] }, { clinics: ['Thoracique', 'Thoracique'], roles: ['nurse'] }, { all: true, clinics: ['X'] }], users: ['a', 'a', 'b'] });
  assert.deepEqual(a, { rules: [{ clinics: ['Thoracique'], roles: ['nurse'] }, { all: true }], users: ['a', 'b'], exclude: [] });
  assert.equal(core.isEmptyAudience({ rules: [{ clinics: [] }], users: [] }), true);
  assert.equal(core.isEmptyAudience({ rules: [], users: ['a'] }), false);
  assert.equal(core.ruleLabel({ clinics: ['Thoracique', 'ORL'], roles: ['nurse'] }), 'Thoracique, ORL · Infirmier·ères');
  assert.equal(core.ruleLabel({ all: true }), 'Tous les membres');
});

test('libellés de dates', () => {
  assert.equal(core.fmtLong('2026-11-20'), 'vendredi 20 novembre 2026');
  assert.equal(core.fmtShort('2026-11-20'), 'ven. 20.11');
  assert.equal(core.optionLabel({ day: '2026-11-20', start: '12:00', end: '13:00' }), 'ven. 20.11, 12:00–13:00');
  assert.equal(core.optionLabel({ day: '2026-11-20' }), 'ven. 20.11, Journée');
});

test('fériés ajoutés à la main : holidayOf et générateur de créneaux les reçoivent en paramètre', () => {
  const extra = new Map([['2026-11-24', 'Pont fictif'], ['2026-11-28', 'Samedi fictif'], ['2026-11-26', 'Fermeture fictive'], ['2026-11-27', 'Fermeture fictive']]);
  assert.equal(core.holidayOf('2026-11-24'), null, 'sans fériés manuels : inchangé');
  assert.equal(core.holidayOf('2026-11-24', extra), 'Pont fictif');
  assert.equal(core.holidayOf('2026-12-25', extra), 'Noël', 'les fériés vaudois restent calculés');
  assert.equal(core.holidayOf('2026-11-25', extra), null);
  const days = (o) => core.generateSlots({ from: '2026-11-23', to: '2026-11-28', weekdays: [1, 2, 3, 4, 5, 6], starts: ['12:00'], duration: 60, ...o }).slots.map((s) => s.day);
  assert.deepEqual(days({}), ['2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27', '2026-11-28'], 'sans fériés manuels : comportement inchangé');
  assert.deepEqual(days({ extraHolidays: null }), days({}));
  assert.deepEqual(days({ extraHolidays: extra }), ['2026-11-23', '2026-11-25'], 'jour seul, plage de deux jours et samedi sautés');
  assert.deepEqual(days({ extraHolidays: extra, skipHolidays: false }), days({}), 'sans « sauter les fériés » : tout est proposé');
  // férié manuel un week-end : aucun effet sur les jours de semaine choisis, les jours de semaine voisins restent proposés
  assert.deepEqual(core.generateSlots({ from: '2026-11-27', to: '2026-11-30', weekdays: [1, 5], starts: [], duration: 0, extraHolidays: new Map([['2026-11-28', 'Samedi fictif']]) }).slots.map((s) => s.day), ['2026-11-27', '2026-11-30']);
  // le calcul reste identique au module partagé
  assert.deepEqual([...core.holidays(2027)], [...require_('../../assets/js/vd-holidays.js').holidays(2027)]);
});
