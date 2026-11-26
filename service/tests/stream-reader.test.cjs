const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readEvents, summarize } = require('../src/stream-reader.cjs');

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dz-sr-')), 'log');
const line = o => `${JSON.stringify(o)}\n`;

test('a line split across two reads is delivered once', () => {
  const file = tmp();
  const full = line({ type: 'a', n: 1 });
  fs.writeFileSync(file, full.slice(0, 10));
  const first = readEvents(file, 0);
  assert.deepEqual(first.events, []);
  assert.equal(first.offset, 0);
  fs.appendFileSync(file, full.slice(10));
  const second = readEvents(file, first.offset);
  assert.deepEqual(second.events, [{ type: 'a', n: 1 }]);
  assert.equal(second.offset, Buffer.byteLength(full));
  assert.deepEqual(readEvents(file, second.offset).events, []);
});

test('a Vietnamese character split across two reads is intact', () => {
  const file = tmp();
  const full = Buffer.from(line({ type: 'a', text: 'Đã xong việc ấy' }));
  const cut = full.indexOf(Buffer.from('Đ')) + 1;
  fs.writeFileSync(file, full.subarray(0, cut));
  const first = readEvents(file, 0);
  assert.deepEqual(first.events, []);
  fs.appendFileSync(file, full.subarray(cut));
  const second = readEvents(file, first.offset);
  assert.equal(second.events[0].text, 'Đã xong việc ấy');
  assert.equal(second.offset, full.length);
});

test('garbage line counts as bad and the next event is still read', () => {
  const file = tmp();
  fs.writeFileSync(file, `not json\n${line({ type: 'ok' })}`);
  const r = readEvents(file, 0);
  assert.equal(r.bad, 1);
  assert.deepEqual(r.events, [{ type: 'ok' }]);
});

test('several result events → the last one', () => {
  const events = [{ type: 'result', n: 1 }, { type: 'x' }, { type: 'result', n: 2 }];
  assert.equal(summarize(events).result.n, 2);
  assert.equal(summarize(events).results, 2);
});

test('quota from rate_limit_event', () => {
  const event = { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 1796018400, unifiedWindows: { seven_day: { utilization: 0.08, resetsAt: 1796018400, status: 'allowed' } } } };
  assert.deepEqual(summarize([event]).quota, { utilization: 0.08, resetsAt: 1796018400, status: 'allowed' });
  assert.equal(summarize([]).quota, null);
  assert.equal(summarize([]).result, null);
});

test('denials are concatenated from all result events', () => {
  const events = [{ type: 'result', permission_denials: [{ a: 1 }] }, { type: 'result', permission_denials: [{ b: 2 }] }];
  assert.deepEqual(summarize(events).denials, [{ a: 1 }, { b: 2 }]);
});

test('missing file → no events, offset 0', () => {
  assert.deepEqual(readEvents(path.join(os.tmpdir(), 'dz-no-such-file'), 0), { events: [], offset: 0, bad: 0 });
});

test('a read is bounded by the chunk size and continues from the offset', () => {
  const file = tmp();
  fs.writeFileSync(file, [1, 2, 3, 4].map(n => line({ type: 'a', n })).join(''));
  const size = Buffer.byteLength(line({ type: 'a', n: 1 }));
  const first = readEvents(file, 0, size * 2 + 3);
  assert.equal(first.events.length, 2);
  assert.equal(first.offset, size * 2);
  const second = readEvents(file, first.offset, size * 2 + 3);
  assert.deepEqual(second.events.map(e => e.n), [3, 4]);
});

test('a line longer than the chunk is counted bad once complete and reading moves on', () => {
  const file = tmp();
  const big = `${'x'.repeat(100)}\n`;
  fs.writeFileSync(file, big.slice(0, 60));
  const partial = readEvents(file, 0, 20);
  assert.deepEqual(partial, { events: [], offset: 0, bad: 0 });
  fs.appendFileSync(file, big.slice(60) + line({ type: 'ok' }));
  const r = readEvents(file, 0, 20);
  assert.equal(r.bad, 1);
  assert.equal(r.offset, big.length);
  const next = readEvents(file, r.offset, 20);
  assert.deepEqual(next.events, [{ type: 'ok' }]);
});

test('an open error other than a missing file throws', { skip: process.getuid && process.getuid() === 0 }, () => {
  const file = tmp();
  fs.writeFileSync(file, line({ type: 'a' }));
  fs.chmodSync(file, 0o000);
  try {
    assert.throws(() => readEvents(file, 5), { code: 'EACCES' });
  } finally { fs.chmodSync(file, 0o600); }
});

test('an offset beyond the file size restarts from 0 and reports truncated', () => {
  const file = tmp();
  fs.writeFileSync(file, line({ type: 'a', n: 1 }));
  const r = readEvents(file, 9999);
  assert.equal(r.truncated, true);
  assert.deepEqual(r.events, [{ type: 'a', n: 1 }]);
  assert.equal(r.offset, Buffer.byteLength(line({ type: 'a', n: 1 })));
  assert.equal(readEvents(file, r.offset).truncated, undefined);
});

test('quota status is the overall status while utilization and resetsAt come from the highest window', () => {
  const info = { status: 'rejected', resetsAt: 10, unifiedWindows: { five_hour: { utilization: 0.2, resetsAt: 20, status: 'allowed' }, seven_day: { utilization: 0.9, resetsAt: 30, status: 'allowed' } } };
  assert.deepEqual(summarize([{ type: 'rate_limit_event', rate_limit_info: info }]).quota, { utilization: 0.9, resetsAt: 30, status: 'rejected' });
});

test('a stderr line saying the conversation is missing is reported', () => {
  const file = tmp();
  fs.writeFileSync(file, line({ type: 'assistant', text: 'No conversation found with session ID: 1' }));
  const first = readEvents(file, 0);
  assert.equal(first.missingSession, undefined);
  fs.appendFileSync(file, 'No conversation found with session ID: 1\n');
  assert.equal(readEvents(file, first.offset).missingSession, true);
});

test('summarize keeps the last background task list', () => {
  const changed = tasks => ({ type: 'system', subtype: 'background_tasks_changed', tasks });
  assert.equal(summarize([]).tasks, null);
  assert.deepEqual(summarize([changed([{ task_id: 'a' }]), { type: 'system', subtype: 'init' }]).tasks, [{ task_id: 'a' }]);
  assert.deepEqual(summarize([changed([{ task_id: 'a' }]), changed([])]).tasks, []);
});
