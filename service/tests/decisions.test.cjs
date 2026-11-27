const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../src/db.cjs');
const jobs = require('../src/jobs.cjs');
const pings = require('../src/pings.cjs');
const decisions = require('../src/decisions.cjs');

const t = s => Date.parse(`${s}+07:00`);
const dbFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dz-dec-')), 'dz.db');

function seed(db) {
  const a = jobs.enqueue(db, { project: 'AAP1', kind: 'bug', key: 'B-1', priority: 1, slots: 1 }, t('2026-11-25T09:00:00')).id;
  db.prepare("UPDATE jobs SET state = 'running' WHERE id = ?").run(a);
  jobs.finish(db, a, 'done', 'đã sửa\u0007\n lỗi ' + 'x'.repeat(300), t('2026-11-25T12:00:00'));
  const b = jobs.enqueue(db, { project: 'AAP1', kind: 'feature', key: 'F-2', priority: 2, slots: 1 }, t('2026-11-25T09:00:00')).id;
  db.prepare("UPDATE jobs SET state = 'running' WHERE id = ?").run(b);
  jobs.park(db, b, 'im 30 phút', t('2026-11-25T13:00:00'));
  decisions.record(db, { project: 'AAP1', jobId: b, code: 'X02', ruleVersion: 'v1', evidence: {}, action: 'park' }, t('2026-11-25T13:00:00'));
  pings.openWait(db, { project: 'AAP1', role: 'po', subject: 'spec màn hình' }, t('2026-11-25T10:00:00'));
}

test('digest lists finished, parked with reason and code, waiting people; sent once per day even after a restart', () => {
  const file = dbFile();
  let db = openDb(file);
  seed(db);
  const ask = now => decisions.digest(db, { project: 'AAP1', now });
  assert.equal(ask(t('2026-11-25T17:29:00')), null);
  const text = ask(t('2026-11-25T17:30:00'));
  assert.match(text, /B-1: xong — đã sửa lỗi x+/);
  assert.match(text, /F-2: đang đỗ — X02: im 30 phút/);
  assert.match(text, /po: spec màn hình \(chờ 7 giờ\)/);
  assert.ok(text.length <= 1800);
  assert.ok(!/[\u0000-\u0008\u000b-\u001f]/.test(text));
  assert.ok(!text.includes('x'.repeat(121)));
  assert.equal(ask(t('2026-11-25T17:30:00')) === text, true);
  decisions.markReportSent(db, 'digest', 'AAP1', t('2026-11-25T17:31:00'));
  db.close();
  db = openDb(file);
  assert.equal(ask(t('2026-11-25T23:59:00')), null);
  const next = ask(t('2026-11-26T17:30:00'));
  assert.doesNotMatch(next, /B-1/);
  assert.match(next, /F-2: đang đỗ/);
});

test('digest is null on weekends, with nothing to report, and a missed day is not sent later', () => {
  const db = openDb(dbFile());
  assert.equal(decisions.digest(db, { project: 'AAP1', now: t('2026-11-25T18:00:00') }), null);
  seed(db);
  assert.equal(decisions.digest(db, { project: { key: 'AAP1' }, now: t('2026-11-28T18:00:00') }), null);
  assert.equal(decisions.digest(db, { project: 'AAP1', now: t('2026-11-26T09:00:00') }), null);
  assert.notEqual(decisions.digest(db, { project: 'AAP1', now: t('2026-11-26T20:00:00') }), null);
});

test('digest truncates long lists to 1800 characters with a remainder line', () => {
  const db = openDb(dbFile());
  for (let i = 0; i < 60; i++) {
    const id = jobs.enqueue(db, { project: 'AAP1', kind: 'bug', key: `B-${i}`, priority: 1, slots: 1 }, 1).id;
    db.prepare("UPDATE jobs SET state = 'running' WHERE id = ?").run(id);
    jobs.finish(db, id, 'done', 'y'.repeat(100), t('2026-11-25T12:00:00'));
  }
  const text = decisions.digest(db, { project: 'AAP1', now: t('2026-11-25T17:30:00') });
  assert.ok(text.length <= 1800);
  assert.match(text, /… và \d+ việc nữa/);
});

test('weekly lists missing rules on Friday 17:30 once per ISO week', () => {
  const db = openDb(dbFile());
  const ask = now => decisions.weeklyMissing(db, { now });
  assert.equal(ask(t('2026-11-27T18:00:00')), null);
  decisions.missingRule(db, { project: 'AAP1', situation: 'ví hết', proposal: 'dừng' }, t('2026-11-26T10:00:00'));
  assert.equal(ask(t('2026-11-26T18:00:00')), null);
  assert.equal(ask(t('2026-11-27T17:29:00')), null);
  assert.match(ask(t('2026-11-27T17:30:00')), /\[AAP1\] ví hết \(1 lần\) — đề xuất: dừng/);
  decisions.markReportSent(db, 'weekly', null, t('2026-11-27T17:31:00'));
  assert.equal(ask(t('2026-11-27T23:00:00')), null);
});

test('the same missing situation twice → one row with a count', () => {
  const db = openDb(dbFile());
  decisions.missingRule(db, { project: 'AAP1', situation: 's', proposal: 'p' }, 100);
  assert.equal(decisions.missingRule(db, { project: 'AAP1', situation: 's', proposal: 'p' }, 200), 2);
  const rows = db.prepare('SELECT * FROM missing_rules').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].count, 2);
  assert.equal(rows[0].first_seen, 100);
  assert.equal(rows[0].last_seen, 200);
});

test('record stores evidence as JSON capped at 4000 chars', () => {
  const db = openDb(dbFile());
  const id = decisions.record(db, { project: 'AAP1', code: 'X01', ruleVersion: 'v1', evidence: { a: 1 }, action: 'close' }, 5);
  assert.deepEqual(JSON.parse(db.prepare('SELECT evidence FROM decisions WHERE id = ?').get(id).evidence), { a: 1 });
  const big = decisions.record(db, { project: 'AAP1', code: 'X01', ruleVersion: 'v1', evidence: { a: 'z'.repeat(9000) }, action: 'close' }, 5);
  const stored = db.prepare('SELECT evidence FROM decisions WHERE id = ?').get(big).evidence;
  assert.ok(stored.length <= 4000);
  assert.equal(JSON.parse(stored).truncated, true);
});

test('evidence heavy in quotes, backslashes or surrogate pairs stays valid JSON within 4000 chars', () => {
  const db = openDb(dbFile());
  for (const text of ['"\\'.repeat(5000), '😀'.repeat(3000), 'a\n"'.repeat(4000)]) {
    const id = decisions.record(db, { project: 'AAP1', code: 'X01', ruleVersion: 'v1', evidence: { text }, action: 'close' }, 5);
    const stored = db.prepare('SELECT evidence FROM decisions WHERE id = ?').get(id).evidence;
    assert.ok(stored.length <= 4000);
    assert.equal(JSON.parse(stored).truncated, true);
  }
});

test('markReportSent uses the build-time now, so a send finishing after midnight does not suppress the next day', () => {
  const db = openDb(dbFile());
  seed(db);
  const built = t('2026-11-25T23:59:00');
  assert.notEqual(decisions.digest(db, { project: 'AAP1', now: built }), null);
  decisions.markReportSent(db, 'digest', 'AAP1', built);
  assert.notEqual(decisions.digest(db, { project: 'AAP1', now: t('2026-11-26T17:30:00') }), null);
  assert.equal(decisions.digest(db, { project: 'AAP1', now: t('2026-11-25T23:59:30') }), null);
});

test('digest cleans kind, role and key, caps the parked reason at 120 with its code, and drops whole lines', () => {
  const db = openDb(dbFile());
  const now = t('2026-11-25T17:30:00');
  const id = jobs.enqueue(db, { project: 'AAP1', kind: 'bug', key: 'K\n\u0007-1', priority: 1, slots: 1 }, 1).id;
  db.prepare("UPDATE jobs SET state = 'running' WHERE id = ?").run(id);
  jobs.park(db, id, '😀'.repeat(200), 2);
  decisions.record(db, { project: 'AAP1', jobId: id, code: 'X03', ruleVersion: 'v1', evidence: {}, action: 'park' }, 2);
  const line = decisions.digest(db, { project: 'AAP1', now }).split('\n').find(l => l.startsWith('- ') && l.includes('đang đỗ'));
  assert.match(line, /^- bug K -1: đang đỗ — X03: /);
  assert.ok(line.split(' — ')[1].length <= 120);
  for (let i = 0; i < 60; i++) pings.openWait(db, { project: 'AAP1', role: 'qa', subject: `${'😀'.repeat(60)}${i}` }, 3);
  const text = decisions.digest(db, { project: 'AAP1', now });
  assert.ok(text.length <= 1800);
  assert.doesNotMatch(text, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
  for (const l of text.split('\n').slice(1)) assert.match(l, /^(- |… và \d+ việc nữa$|[^-… ][^\n]*:$)/);
});

test('weekly window: only rules seen since the previous sent weekly appear', () => {
  const db = openDb(dbFile());
  decisions.missingRule(db, { project: 'AAP1', situation: 'cũ', proposal: 'p' }, t('2026-11-26T10:00:00'));
  decisions.markReportSent(db, 'weekly', null, t('2026-11-27T17:30:00'));
  assert.equal(decisions.weeklyMissing(db, { now: t('2026-12-04T17:30:00') }), null);
  decisions.missingRule(db, { project: 'AAP1', situation: 'mới', proposal: 'q' }, t('2026-12-01T10:00:00'));
  const text = decisions.weeklyMissing(db, { now: t('2026-12-04T17:30:00') });
  assert.match(text, /mới/);
  assert.doesNotMatch(text, /cũ/);
});

test('evidence is never cut in the middle of a surrogate pair', () => {
  const db = openDb(dbFile());
  for (let pad = 0; pad < 4; pad++) {
    const id = decisions.record(db, { project: 'AAP1', code: 'X01', ruleVersion: 'v1', evidence: { text: 'a'.repeat(pad) + '😀'.repeat(3000) }, action: 'close' }, 5);
    const stored = db.prepare('SELECT evidence FROM decisions WHERE id = ?').get(id).evidence;
    assert.ok(stored.length <= 4000 && stored.length > 3900);
    const { text } = JSON.parse(stored);
    assert.ok(text.isWellFormed(), `đệm ${pad}`);
    assert.ok(text.endsWith('😀'), `đệm ${pad}`);
  }
});

test('digest shows the text of a job result, at most 120 characters, never raw JSON', () => {
  const db = openDb(dbFile());
  const done = (key, state, result) => {
    const { id } = jobs.enqueue(db, { project: 'AAP1', kind: 'bug', key, priority: 1, slots: 1 }, 1);
    db.prepare("UPDATE jobs SET state = 'running' WHERE id = ?").run(id);
    jobs.finish(db, id, state, result, t('2026-11-25T12:00:00'));
  };
  done('B-1', 'done', { text: 'đã sửa\nlỗi', costUsd: 1, turns: 2, denials: [] });
  done('B-2', 'failed', { error: 'no_result', text: '', costUsd: null, turns: null, denials: [] });
  done('B-3', 'done', { text: 'z'.repeat(300), costUsd: 1, turns: 2, denials: [] });
  done('B-4', 'done', { text: '', costUsd: 1, turns: 2, denials: [] });
  const text = decisions.digest(db, { project: 'AAP1', now: t('2026-11-25T17:30:00') });
  assert.match(text, /^- bug B-1: xong — đã sửa lỗi$/m);
  assert.match(text, /^- bug B-2: lỗi — no_result$/m);
  assert.match(text, /^- bug B-3: xong — z{119}…$/m);
  assert.match(text, /^- bug B-4: xong$/m);
  assert.doesNotMatch(text, /[{}"]|costUsd/);
});

test('digest renders mentions and masked links in free text as plain text', () => {
  const db = openDb(dbFile());
  pings.openWait(db, { project: 'AAP1', role: 'po', subject: 'xem <@123> <#9> [a](https://e.com)' }, t('2026-11-25T10:00:00'));
  const text = decisions.digest(db, { project: 'AAP1', now: t('2026-11-25T17:30:00') });
  assert.doesNotMatch(text, /<[@#]|\]\(/);
  assert.match(text.replaceAll('\u200b', ''), /xem <@123> <#9> \[a\]\(https:\/\/e\.com\)/);
});
