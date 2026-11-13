import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMessage, deadlineText, esc } from '../../supabase/functions/notify-oncoodle/message.ts';
import { buildIcs } from '../../supabase/functions/notify-oncoodle/ics.ts';
import { workerAuthorized } from '../../supabase/functions/notify-oncoodle/delivery.ts';

const options = [{ id: 1, day: '2026-11-20', start: '12:00', end: '13:00' }, { id: 2, day: '2026-11-24', start: null, end: null }];
const data = (over = {}) => ({
  poll: { id: 7, kind: 'slots', title: 'Colloque <b>thoracique</b>', location: 'Salle 12, BH10', status: 'open', deadline: '2026-11-18T16:30:00Z', creator: 'Test 3', final_option_id: null, final_message: null, ...over.poll },
  options, invitee: { required: true, responded: false, answer_on_final: null, ...over.invitee }, counts: { invited: 4, responded: 2 },
});

test('invitation : titre échappé, lien, échéance à l\'heure de Zurich, push sans texte libre', () => {
  for (const lang of ['fr', 'en']) {
    const m = buildMessage({ lang, kind: 'invite', data: data() });
    assert.match(m.subject, /thoracique/);
    assert.match(m.text, /20\.11\.2026, 12:00–13:00/); assert.match(m.text, /24\.11\.2026/);
    assert.match(m.text, /https:\/\/onconic\.ch\/app\/oncoodle\.html#p=7/);
    assert.match(m.text, /17:30/, 'échéance 16:30 UTC = 17:30 à Zurich en novembre');
    assert.doesNotMatch(m.html, /<b>thoracique/); assert.match(m.html, /&lt;b&gt;thoracique/);
    assert.doesNotMatch(JSON.stringify(m.push), /thoracique|Salle|Test 3/);
    assert.equal(m.push.url, '/app/oncoodle.html#p=7');
  }
  assert.match(buildMessage({ lang: 'fr', kind: 'invite', data: data() }).text, /obligatoire/);
  assert.doesNotMatch(buildMessage({ lang: 'fr', kind: 'invite', data: data({ invitee: { required: false } }) }).text, /obligatoire/);
});

test('fuseau de Zurich : heure d\'été et d\'hiver', () => {
  assert.equal(deadlineText('2026-11-20T10:30:00Z', 'fr'), '20.11.2026 à 11:30');
  assert.equal(deadlineText('2026-07-01T10:30:00Z', 'en'), '01.07.2026 at 12:30');
  assert.equal(deadlineText(null, 'fr'), '');
});

test('clôture : date retenue, lieu, message ; rappel du fichier agenda sauf si la réponse était « non »', () => {
  const closed = data({ poll: { status: 'closed', final_option_id: 1, final_message: 'Apportez vos cas' }, invitee: { answer_on_final: 'yes' } });
  const m = buildMessage({ lang: 'fr', kind: 'closed', data: closed });
  assert.match(m.text, /Date retenue : 20\.11\.2026, 12:00–13:00/); assert.match(m.text, /Lieu : Salle 12, BH10/); assert.match(m.text, /Apportez vos cas/); assert.match(m.text, /fichier joint/);
  const no = buildMessage({ lang: 'fr', kind: 'closed', data: data({ poll: { status: 'closed', final_option_id: 1 }, invitee: { answer_on_final: 'no' } }) });
  assert.doesNotMatch(no.text, /fichier joint/);
  assert.match(buildMessage({ lang: 'fr', kind: 'closed', data: data({ poll: { kind: 'rsvp', status: 'closed', final_option_id: 1 } }) }).subject, /Confirmé/);
});

test('autres messages : annulation, tout le monde a répondu, échéance, proposition d\'agenda', () => {
  assert.match(buildMessage({ lang: 'fr', kind: 'cancelled', data: data({ poll: { status: 'cancelled', final_message: 'Reporté' } }) }).text, /annulé[\s\S]*Reporté/);
  assert.match(buildMessage({ lang: 'en', kind: 'all_responded', data: data() }).text, /All 4 invited/);
  assert.match(buildMessage({ lang: 'fr', kind: 'deadline', data: data() }).text, /2 sur 4/);
  const p = buildMessage({ lang: 'fr', kind: 'calendar_proposal', by: 'Test 8', data: data({ poll: { status: 'closed', final_option_id: 2 } }) });
  assert.match(p.text, /Test 8 demande/); assert.match(p.text, /approbation/); assert.match(p.text, /24\.11\.2026/); assert.equal(p.push.body, '');
});

test('fichier agenda : heures de Zurich avec fuseau, journée entière, échappement, pliage, CRLF', () => {
  const now = new Date('2026-11-13T10:00:00Z');
  const t = buildIcs({ id: 7, title: 'Colloque, thoracique; salle', location: 'BH10', day: '2026-11-20', start: '12:00', end: '13:00' }, now);
  assert.match(t, /^BEGIN:VCALENDAR\r\n/); assert.match(t, /TZID:Europe\/Zurich/); assert.match(t, /DTSTART;TZID=Europe\/Zurich:20261120T120000\r\n/);
  assert.match(t, /DTEND;TZID=Europe\/Zurich:20261120T130000\r\n/); assert.match(t, /SUMMARY:Colloque\\, thoracique\\; salle\r\n/); assert.match(t, /UID:oncoodle-7@onconic\.ch/);
  assert.match(t, /DTSTAMP:20261113T100000Z/); assert.ok(!/[^\r]\n/.test(t), 'fins de ligne CRLF uniquement');
  const a = buildIcs({ id: 8, title: 'x'.repeat(200), day: '2026-12-31' }, now);
  assert.match(a, /DTSTART;VALUE=DATE:20261231\r\n/); assert.match(a, /DTEND;VALUE=DATE:20270101\r\n/); assert.ok(!a.includes('VTIMEZONE'));
  assert.ok(a.split('\r\n').every((l) => l.length <= 75), 'lignes de 75 caractères au plus');
  assert.match(a.replace(/\r\n /g, ''), /SUMMARY:x{200}\r\n/);
});

test('échappement HTML et jeton du traitement autonome', async () => {
  assert.equal(esc('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  const secret = 'x'.repeat(48);
  assert.equal(await workerAuthorized(secret, secret), true);
  assert.equal(await workerAuthorized(secret + 'y', secret), false);
  assert.equal(await workerAuthorized(null, secret), false);
  assert.equal(await workerAuthorized('court', 'court'), false);
});
