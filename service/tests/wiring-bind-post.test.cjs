const { test } = require('node:test');
const assert = require('node:assert/strict');
const { tick } = require('../src/tick.cjs');
const { openWait } = require('../src/pings.cjs');
const inbox = require('../src/inbox.cjs');
const store = require('../src/specs/store.cjs');
const { quizUrl, reviewUrl } = require('../src/web/links.cjs');
const { makeHome } = require('./service-fixtures.cjs');

const DAY = 24 * 60 * 60000;
const NOW = Date.parse('2026-11-25T10:00:00+07:00');
const MESSAGE = '900000000000000011';
const CHANNEL = '900000000000000002';

function setup(t, { live = true } = {}) {
  const h = makeHome(t);
  h.project('ABC1', { live });
  h.webhook('ABC1');
  const ctx = h.context();
  ctx.facade = { quiz: async () => ({ round: 2 }), review: async () => ({ sha: 'f'.repeat(64) }) };
  ctx.send = async () => ({ ok: true, messageId: MESSAGE, channelId: CHANNEL });
  return { h, ctx };
}

function wait(ctx, kind, subject) {
  const spec = store.createSpec(ctx.db, { project: 'ABC1', title: 't', source: { type: 'pasted', text: 'x' }, figma: null }, NOW - 3 * DAY);
  const token = store.issueToken(ctx.db, { specId: spec.id, purpose: kind, ttlMs: 10 * DAY }, NOW - 3 * DAY);
  const link = (kind === 'quiz' ? quizUrl : reviewUrl)('http://127.0.0.1:8787', token);
  openWait(ctx.db, { project: 'ABC1', role: 'po', subject, link }, NOW - 3 * DAY);
  return spec.id;
}

test('a posted quiz link and a posted review link are each bound to their message with the round and the sha', async t => {
  const quiz = setup(t);
  const quizId = wait(quiz.ctx, 'quiz', 'quiz A');
  await tick(quiz.ctx, NOW);
  const row = quiz.ctx.db.prepare('SELECT * FROM inbox_posts').get();
  assert.deepEqual([row.message_id, row.channel_id, row.project, row.kind, row.spec_id, row.version], [MESSAGE, CHANNEL, 'ABC1', 'quiz', quizId, '2']);
  const review = setup(t);
  const reviewId = wait(review.ctx, 'review', 'review B');
  await tick(review.ctx, NOW);
  const post = inbox.postOf(review.ctx.db, MESSAGE);
  assert.deepEqual([post.channelId, post.project, post.kind, post.specId, post.version], [CHANNEL, 'ABC1', 'review', reviewId, 'f'.repeat(64)]);
});

test('a message carrying two different quiz or review links is left unbound, never guessed', async t => {
  const { ctx } = setup(t);
  wait(ctx, 'quiz', 'quiz A');
  wait(ctx, 'review', 'review B');
  await tick(ctx, NOW);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM inbox_posts').get().n, 0);
  assert.equal(ctx.db.prepare('SELECT ping_count FROM waits').get().ping_count, 1);
});

test('a failed send, a dry project and a link without a valid token bind nothing', async t => {
  const failed = setup(t);
  wait(failed.ctx, 'quiz', 'q');
  failed.ctx.send = async () => ({ ok: false, retryAt: NOW + 60000, error: 'x' });
  await tick(failed.ctx, NOW);
  assert.equal(failed.ctx.db.prepare('SELECT COUNT(*) AS n FROM inbox_posts').get().n, 0);

  const dry = setup(t, { live: false });
  wait(dry.ctx, 'quiz', 'q');
  await tick(dry.ctx, NOW);
  assert.equal(dry.ctx.db.prepare('SELECT COUNT(*) AS n FROM inbox_posts').get().n, 0);

  const bad = setup(t);
  openWait(bad.ctx.db, { project: 'ABC1', role: 'po', subject: 'q', link: quizUrl('http://127.0.0.1:8787', 'x'.repeat(40)) }, NOW - 3 * DAY);
  await tick(bad.ctx, NOW);
  assert.equal(bad.ctx.db.prepare('SELECT COUNT(*) AS n FROM inbox_posts').get().n, 0);
});

test('a facade error while binding is logged and does not fail the ping', async t => {
  const { ctx, h } = setup(t);
  wait(ctx, 'quiz', 'q');
  ctx.facade.quiz = async () => {
    throw new Error('boom');
  };
  await tick(ctx, NOW);
  assert.equal(ctx.db.prepare('SELECT ping_count FROM waits').get().ping_count, 1);
  assert.equal(h.logs('bind-post-failed').length, 1);
});
