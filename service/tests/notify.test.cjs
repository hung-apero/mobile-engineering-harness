const { test } = require('node:test');
const assert = require('node:assert/strict');
const { tick } = require('../src/tick.cjs');
const { openWait } = require('../src/pings.cjs');
const { missingRule } = require('../src/decisions.cjs');
const { makeHome, NOW, MIN } = require('./service-fixtures.cjs');

const DAY = 24 * 60 * MIN;
const at = text => Date.parse(`${text}:00+07:00`);
const WEDNESDAY_10H = at('2026-11-25T10:00');

function setup(t, { hook = true, reply } = {}) {
  const h = makeHome(t);
  h.project('ABC1', { live: true });
  if (hook) h.webhook('ABC1');
  const ctx = h.context();
  const sent = [];
  ctx.send = async message => { sent.push(message); return reply ? reply(message) : { ok: true }; };
  return { h, ctx, sent };
}

const pinged = ctx => ctx.db.prepare('SELECT ping_count, retry_at FROM waits').get();

test('a due ping is sent with its mentions and recorded; the next tick does not repeat it', async t => {
  const { ctx, sent, h } = setup(t);
  openWait(ctx.db, { project: 'ABC1', role: 'dev', subject: 'x' }, WEDNESDAY_10H - 3 * DAY);
  await tick(ctx, WEDNESDAY_10H);
  await tick(ctx, WEDNESDAY_10H + 10000);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].mentions, ['323456789012345678']);
  assert.match(sent[0].webhookFile, /ABC1\.discord-webhook$/);
  assert.equal(pinged(ctx).ping_count, 1);
  assert.equal(h.logs('ping-sent').length, 1);
});

test('a failed ping is not counted and waits for retryAt', async t => {
  const retryAt = WEDNESDAY_10H + 5 * MIN;
  const { ctx, sent } = setup(t, { reply: () => ({ ok: false, retryAt, error: 'Discord trả về HTTP 429' }) });
  openWait(ctx.db, { project: 'ABC1', role: 'dev', subject: 'x' }, WEDNESDAY_10H - 3 * DAY);
  await tick(ctx, WEDNESDAY_10H);
  await tick(ctx, WEDNESDAY_10H + 10000);
  assert.equal(sent.length, 1);
  assert.deepEqual({ ...pinged(ctx) }, { ping_count: 0, retry_at: retryAt });
  await tick(ctx, retryAt - 1);
  assert.equal(sent.length, 1);
  await tick(ctx, retryAt);
  assert.equal(sent.length, 2);
});

test('no webhook file: nothing is sent and one log line per working day, also after a restart', async t => {
  const { h, ctx, sent } = setup(t, { hook: false });
  openWait(ctx.db, { project: 'ABC1', role: 'dev', subject: 'x' }, WEDNESDAY_10H - 3 * DAY);
  await tick(ctx, WEDNESDAY_10H);
  await tick(ctx, WEDNESDAY_10H + 10000);
  await tick(h.context(), WEDNESDAY_10H + 20000);
  assert.equal(sent.length, 0);
  assert.equal(h.logs('no-webhook').length, 1);
  await tick(ctx, WEDNESDAY_10H + DAY);
  assert.equal(h.logs('no-webhook').length, 2);
  assert.equal(pinged(ctx).ping_count, 0);
});

test('the digest is marked sent only after it was sent, and a failure waits for retryAt', async t => {
  const now = at('2026-11-25T17:35');
  let ok = false;
  const { ctx, sent } = setup(t, { reply: () => (ok ? { ok: true } : { ok: false, retryAt: now + 5 * MIN, error: 'lỗi' }) });
  openWait(ctx.db, { project: 'ABC1', role: 'qa', subject: 'x' }, now - MIN);
  const digests = () => sent.filter(m => m.content.startsWith('Tóm tắt')).length;
  await tick(ctx, now);
  await tick(ctx, now + 10000);
  await tick(ctx, now + 5 * MIN - 1);
  assert.equal(digests(), 1);
  ok = true;
  await tick(ctx, now + 5 * MIN);
  await tick(ctx, now + 5 * MIN + 10000);
  assert.equal(digests(), 2);
});

test('the weekly list is sent once, through the first project that has a webhook', async t => {
  const now = at('2026-11-27T17:35');
  const { h, ctx, sent } = setup(t);
  h.project('AAA1', { live: true });
  missingRule(ctx.db, { project: 'ABC1', situation: 's', proposal: 'p' }, now - MIN);
  await tick(ctx, now);
  await tick(ctx, now + 10000);
  assert.equal(sent.length, 1);
  assert.match(sent[0].content, /X08/);
  assert.match(sent[0].webhookFile, /ABC1\.discord-webhook$/);
});

test('a sender that throws counts as a failed ping', async t => {
  const { h, ctx } = setup(t, { reply: () => { throw new Error('https://discord.com/api/webhooks/1/secret'); } });
  openWait(ctx.db, { project: 'ABC1', role: 'dev', subject: 'x' }, WEDNESDAY_10H - 3 * DAY);
  await tick(ctx, WEDNESDAY_10H);
  await tick(ctx, WEDNESDAY_10H + 10000);
  assert.equal(h.logs('ping-failed').length, 1);
  assert.deepEqual({ ...pinged(ctx) }, { ping_count: 0, retry_at: WEDNESDAY_10H + 60000 });
  assert.ok(!JSON.stringify(h.logs()).includes('secret'));
});

test('outside working hours nothing is pinged', async t => {
  const { ctx, sent } = setup(t);
  openWait(ctx.db, { project: 'ABC1', role: 'dev', subject: 'x' }, NOW - 5 * DAY);
  await tick(ctx, at('2026-11-25T08:00'));
  assert.equal(sent.length, 0);
});

test('a database that refuses writes: six ticks send nothing and log one line', async t => {
  for (const now of [WEDNESDAY_10H, at('2026-11-25T17:35'), at('2026-11-27T17:35')]) {
    const { h, ctx, sent } = setup(t);
    if (now === WEDNESDAY_10H) openWait(ctx.db, { project: 'ABC1', role: 'dev', subject: 'x' }, now - 3 * DAY);
    else if (now === at('2026-11-25T17:35')) openWait(ctx.db, { project: 'ABC1', role: 'qa', subject: 'x' }, now - MIN);
    else missingRule(ctx.db, { project: 'ABC1', situation: 's', proposal: 'p' }, now - MIN);
    ctx.boot = false;
    ctx.db.exec('PRAGMA query_only = ON');
    for (let i = 0; i < 6; i++) await tick(ctx, now + i * 10000);
    assert.equal(sent.length, 0);
    assert.equal(h.logs('notify-error').length, 1);
    ctx.db.exec('PRAGMA query_only = OFF');
    await tick(ctx, now + 60000);
    assert.equal(sent.length, 1);
  }
});

test('a ping sent just before the database refuses writes is not repeated while it still refuses', async t => {
  const { ctx, sent } = setup(t);
  const send = ctx.send;
  ctx.send = async message => {
    ctx.db.exec('PRAGMA query_only = ON');
    return send(message);
  };
  openWait(ctx.db, { project: 'ABC1', role: 'dev', subject: 'x' }, WEDNESDAY_10H - 3 * DAY);
  for (let i = 0; i < 20; i++) await tick(ctx, WEDNESDAY_10H + i * 10000);
  assert.equal(sent.length, 1);
});

test('a service told to stop during one send starts no other send', async t => {
  const now = at('2026-11-27T17:35');
  const { ctx, sent } = setup(t, { reply: () => { ctx.stopping = true; return { ok: true }; } });
  for (const role of ['po', 'qa', 'dev']) openWait(ctx.db, { project: 'ABC1', role, subject: 'x' }, now - 5 * DAY);
  missingRule(ctx.db, { project: 'ABC1', situation: 's', proposal: 'p' }, now - MIN);
  await tick(ctx, now);
  assert.equal(sent.length, 1);
  assert.match(sent[0].content, /^<@/);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM waits WHERE ping_count = 1').get().n, 1);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM sent_reports').get().n, 0);
});

test('a service told to stop during the last ping sends neither digest nor weekly', async t => {
  const now = at('2026-11-27T17:35');
  let stop = true;
  const { ctx, sent } = setup(t, { reply: () => { ctx.stopping = stop; return { ok: true }; } });
  openWait(ctx.db, { project: 'ABC1', role: 'dev', subject: 'x' }, now - 5 * DAY);
  missingRule(ctx.db, { project: 'ABC1', situation: 's', proposal: 'p' }, now - MIN);
  await tick(ctx, now);
  assert.equal(sent.length, 1);
  stop = ctx.stopping = false;
  await tick(ctx, now + 10000);
  assert.deepEqual(sent.slice(1).map(m => m.content.split(' ')[0]), ['Tóm', 'Tuần']);
});

test('live:false never calls send: a would line once per working day per project instead', async t => {
  const { h, ctx, sent } = setup(t);
  h.project('ABC1', { live: false });
  openWait(ctx.db, { project: 'ABC1', role: 'dev', subject: 'x' }, WEDNESDAY_10H - 3 * DAY);
  await tick(ctx, WEDNESDAY_10H);
  await tick(ctx, WEDNESDAY_10H + 10000);
  assert.equal(sent.length, 0);
  assert.equal(h.logs('would').length, 1);
  assert.equal(h.logs('would')[0].project, 'ABC1');
  assert.equal(pinged(ctx).ping_count, 0);
  await tick(ctx, WEDNESDAY_10H + DAY);
  assert.equal(h.logs('would').length, 2);
});

test('live:false weekly list is not sent either', async t => {
  const now = at('2026-11-27T17:35');
  const { h, ctx, sent } = setup(t);
  h.project('ABC1', { live: false });
  missingRule(ctx.db, { project: 'ABC1', situation: 's', proposal: 'p' }, now - MIN);
  await tick(ctx, now);
  assert.equal(sent.length, 0);
});
