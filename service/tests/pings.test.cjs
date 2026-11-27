const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../src/db.cjs');
const pings = require('../src/pings.cjs');
const { buildContent } = require('../src/ping-message.cjs');

const t = s => Date.parse(`${s}+07:00`);
const rules = {
  P01: { every_working_hours: 4, backup_from_ping: 3, daily_after_ping: 3 },
  P02: { every_working_days: 1 },
  P03: { every_working_days: 1 },
};
const people = { po: '111111111111111111', poBackup: '222222222222222222', qa: '333333333333333333', devOnCall: '444444444444444444' };
const project = { key: 'AAP1', people };
const memDb = () => openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dz-pings-')), 'dz.db'));
const due = (db, now, proj = project) => pings.duePings(db, { project: proj, rules, now });
const open = (db, subject, at, role = 'po', extra = {}) => pings.openWait(db, { project: 'AAP1', role, subject, ...extra }, at);
const ping = (db, group, now) => pings.recordPing(db, group.waitIds, now, { ok: true });

test('a new PO wait is announced at once; after that 10:00 notice the reminder is due 14:00, not 13:59', () => {
  const db = memDb();
  open(db, 'spec', t('2026-11-25T10:00:00'));
  const [notice] = due(db, t('2026-11-25T10:00:00'));
  assert.deepEqual(notice.mentions, [people.po]);
  ping(db, notice, t('2026-11-25T10:00:00'));
  assert.equal(due(db, t('2026-11-25T13:59:00')).length, 0);
  assert.equal(due(db, t('2026-11-25T14:00:00')).length, 1);
});

test('a PO wait opened Thursday 18:30 is announced at 18:30 with its link; the reminder waits for Friday 13:00', () => {
  const db = memDb();
  open(db, 'quiz', t('2026-11-26T18:30:00'), 'po', { link: 'http://10.0.0.5:8788/quiz/abc' });
  const [notice] = due(db, t('2026-11-26T18:30:00'));
  assert.match(notice.content, /quiz http:\/\/10\.0\.0\.5:8788\/quiz\/abc/);
  ping(db, notice, t('2026-11-26T18:30:00'));
  assert.equal(due(db, t('2026-11-26T22:00:00')).length, 0);
  assert.equal(due(db, t('2026-11-27T12:59:00')).length, 0);
  assert.equal(due(db, t('2026-11-27T13:00:00')).length, 1);
});

test('outside working hours a new PO wait is announced alone, older reminders still wait for the opening', () => {
  const db = memDb();
  const old = open(db, 'spec cũ', t('2026-11-25T09:00:00'));
  db.prepare('UPDATE waits SET ping_count = 1, last_ping_at = ? WHERE id = ?').run(t('2026-11-25T09:00:00'), old);
  const fresh = open(db, 'quiz mới', t('2026-11-26T20:00:00'));
  const groups = due(db, t('2026-11-26T20:00:00'));
  assert.deepEqual(groups.map(g => g.waitIds), [[fresh]]);
  assert.doesNotMatch(groups[0].content, /spec cũ/);
});

test('a new dev wait is announced at once, even outside working hours; QA waits are not', () => {
  const db = memDb();
  open(db, 'bug', t('2026-11-26T20:00:00'), 'dev');
  open(db, 'test', t('2026-11-26T20:00:00'), 'qa');
  const groups = due(db, t('2026-11-26T20:00:00'));
  assert.deepEqual(groups.map(g => g.role), ['dev']);
  assert.deepEqual(groups[0].mentions, [people.devOnCall]);
});

test('third ping mentions PO and backup; no backup configured → PO only', () => {
  const db = memDb();
  const id = open(db, 'spec', t('2026-11-25T09:00:00'));
  const at = t('2026-11-25T13:00:00');
  const setCount = n => db.prepare('UPDATE waits SET ping_count = ?, last_ping_at = ? WHERE id = ?').run(n, t('2026-11-25T09:00:00'), id);
  setCount(0);
  assert.deepEqual(due(db, at)[0].mentions, [people.po]);
  setCount(1);
  assert.deepEqual(due(db, at)[0].mentions, [people.po]);
  setCount(2);
  assert.deepEqual(due(db, at)[0].mentions, [people.po, people.poBackup]);
  const solo = { key: 'AAP1', people: { po: people.po, qa: people.qa, devOnCall: people.devOnCall } };
  assert.deepEqual(due(db, at, solo)[0].mentions, [people.po]);
});

test('after the third, next is the next working day, not 4 hours', () => {
  const db = memDb();
  const id = open(db, 'spec', t('2026-11-24T09:00:00'));
  db.prepare('UPDATE waits SET ping_count = 3, last_ping_at = ? WHERE id = ?').run(t('2026-11-25T10:00:00'), id);
  assert.equal(due(db, t('2026-11-25T14:00:00')).length, 0);
  assert.equal(due(db, t('2026-11-25T17:59:00')).length, 0);
  assert.equal(due(db, t('2026-11-26T09:59:00')).length, 0);
  assert.equal(due(db, t('2026-11-26T10:00:00')).length, 1);
});

test('two waits for one PO → one message listing both, when the first is due', () => {
  const db = memDb();
  const a = open(db, 'spec A', t('2026-11-25T09:00:00'), 'po', { link: 'https://example.com/a' });
  const b = open(db, 'spec B', t('2026-11-25T12:00:00'));
  const groups = due(db, t('2026-11-25T13:00:00'));
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].waitIds, [a, b]);
  assert.match(groups[0].content, /spec A https:\/\/example\.com\/a/);
  assert.match(groups[0].content, /spec B/);
  ping(db, groups[0], t('2026-11-25T13:00:00'));
  assert.equal(due(db, t('2026-11-25T16:00:00')).length, 0);
  assert.equal(due(db, t('2026-11-25T17:00:00')).length, 1);
});

test('resolved wait is never pinged', () => {
  const db = memDb();
  const id = open(db, 'spec', t('2026-11-25T09:00:00'));
  assert.equal(pings.resolveWait(db, id, t('2026-11-25T10:00:00')), true);
  assert.equal(due(db, t('2026-11-26T12:00:00')).length, 0);
  assert.equal(open(db, 'spec', t('2026-11-26T12:00:00')) !== id, true);
});

test('send failure or 429 leaves ping_count unchanged and is retried, not before retryAt; success is not resent on the next tick', () => {
  const db = memDb();
  const id = open(db, 'spec', t('2026-11-25T09:00:00'));
  const now = t('2026-11-25T13:00:00');
  const [group] = due(db, now);
  pings.recordPing(db, group.waitIds, now, { ok: false });
  pings.recordPingFailure(db, group.waitIds, now + 90000);
  assert.equal(db.prepare('SELECT ping_count FROM waits WHERE id = ?').get(id).ping_count, 0);
  assert.equal(due(db, now + 89999).length, 0);
  const [retry] = due(db, now + 90000);
  assert.equal(retry.key, group.key);
  ping(db, retry, now + 90000);
  assert.equal(due(db, now + 90000 + 60000).length, 0);
  assert.equal(db.prepare('SELECT ping_count, retry_at FROM waits WHERE id = ?').get(id).ping_count, 1);
});

test('outside working hours nothing is due; overdue one is delivered at the next opening; 18:00 deadline waits for opening', () => {
  const db = memDb();
  const id = open(db, 'spec', t('2026-11-25T14:00:00'));
  db.prepare('UPDATE waits SET ping_count = 1, last_ping_at = ? WHERE id = ?').run(t('2026-11-25T14:00:00'), id);
  assert.equal(due(db, t('2026-11-25T18:00:00')).length, 0);
  assert.equal(due(db, t('2026-11-26T08:59:00')).length, 0);
  assert.equal(due(db, t('2026-11-26T09:00:00')).length, 1);
});

test('QA: first due after every_working_days; dev: announced at once, then the same daily interval', () => {
  const db = memDb();
  open(db, 'qa item', t('2026-11-25T10:00:00'), 'qa');
  open(db, 'dev item', t('2026-11-25T10:00:00'), 'dev');
  const [notice] = due(db, t('2026-11-25T10:00:00'));
  assert.equal(notice.role, 'dev');
  ping(db, notice, t('2026-11-25T10:00:00'));
  assert.equal(due(db, t('2026-11-26T09:59:00')).length, 0);
  const groups = due(db, t('2026-11-26T10:00:00'));
  assert.deepEqual(groups.map(g => g.role), ['qa', 'dev']);
  assert.deepEqual(groups[0].mentions, [people.qa]);
  assert.deepEqual(groups[1].mentions, [people.devOnCall]);
  groups.forEach(g => ping(db, g, t('2026-11-26T10:00:00')));
  assert.equal(due(db, t('2026-11-27T09:59:00')).length, 0);
  assert.equal(due(db, t('2026-11-27T10:00:00')).length, 2);
});

test('openWait is idempotent on project, role, subject while open', () => {
  const db = memDb();
  const a = open(db, 'spec', t('2026-11-25T09:00:00'));
  assert.equal(open(db, 'spec', t('2026-11-25T10:00:00')), a);
  assert.notEqual(open(db, 'spec', t('2026-11-25T10:00:00'), 'qa'), a);
});

test('subject containing @everyone or <@123> is delivered as plain text with no extra mentions', () => {
  const db = memDb();
  open(db, 'hi @everyone <@123>\nline\u0007two', t('2026-11-25T09:00:00'));
  const [group] = due(db, t('2026-11-25T13:00:00'));
  assert.deepEqual(group.mentions, [people.po]);
  assert.doesNotMatch(group.content.split('\n')[1], /<@/);
  assert.match(group.content.replaceAll('\u200b', ''), /• hi @everyone <@123> line two — chờ/);
  assert.equal(group.content.split('\n').length, 2);
});

test('content: link only if http(s), subject max 200, 15 bullets then remainder, total within 1900, mentions kept', () => {
  const now = t('2026-11-26T10:00:00');
  const mk = (i, extra = {}) => ({ id: i, subject: `s${i} ${'x'.repeat(300)}`, opened_at: t('2026-11-25T09:00:00'), ...extra });
  const waits = Array.from({ length: 20 }, (_, i) => mk(i, { link: i === 0 ? 'javascript:alert(1)' : 'https://e.com/' + 'p'.repeat(250) }));
  const text = buildContent({ mentions: [people.po, people.poBackup], projectKey: 'AAP1', waits, now });
  assert.ok(text.length <= 1900);
  assert.ok(text.startsWith(`<@${people.po}> <@${people.poBackup}>`));
  assert.doesNotMatch(text, /javascript:/);
  assert.match(text, /… và \d+ việc nữa$/);
  const bullets = text.split('\n').filter(l => l.startsWith('• '));
  assert.ok(bullets.length <= 15 && bullets.length >= 1);
  assert.match(bullets[0], /^• s0 x{197} — chờ/);
  assert.match(bullets[0], /— chờ 1 ngày làm việc 1 giờ$/);
});

test('subject and link never render as a mention, a channel or a masked link; the real tag stays', () => {
  const now = t('2026-11-26T10:00:00');
  const wait = (subject, link) => ({ id: 1, subject, link, opened_at: t('2026-11-25T09:00:00') });
  const waits = [wait('a <@1> <@&2> <#3> [b](https://e.com)'), wait('[c', 'https://e.com/x](https://evil.com)')];
  const [header, ...bullets] = buildContent({ mentions: [people.po], projectKey: 'AAP1', waits, now }).split('\n');
  assert.ok(header.startsWith(`<@${people.po}>`));
  for (const line of bullets) assert.doesNotMatch(line, /<[@#]|\]\(/);
  assert.match(bullets[0].replaceAll('\u200b', ''), /^• a <@1> <@&2> <#3> \[b\]\(https:\/\/e\.com\) — chờ/);
});
