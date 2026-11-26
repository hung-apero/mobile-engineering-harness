const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const tokens = require('../src/board/tokens.cjs');
const { viewer, validViewer } = require('../src/board/viewer-commands.cjs');
const kv = require('../src/kv.cjs');
const { makeHome, NOW } = require('./service-fixtures.cjs');

const DAY = 24 * 60 * 60 * 1000;
const END = new Date(NOW + 90 * DAY + 7 * 3600000).toISOString().slice(0, 10);

function world(t) {
  const h = makeHome(t, ['ABC1', 'XYZ2']);
  const ctx = h.context();
  kv.set(ctx.db, 'web:url', 'http://10.0.0.5:8788', NOW);
  return { h, ctx, db: ctx.db };
}

test('viewer token is random, stored hashed and resolves to its keys', t => {
  const { db } = world(t);
  const a = tokens.issueViewer(db, { keys: ['ABC1'] }, NOW);
  const b = tokens.issueViewer(db, { keys: [] }, NOW);
  assert.notEqual(a.token, b.token);
  assert.ok(a.token.length >= 40);
  const rows = db.prepare('SELECT hash FROM viewer_tokens').all().map(row => row.hash);
  assert.ok(!rows.includes(a.token));
  assert.ok(rows.includes(crypto.createHash('sha256').update(a.token).digest('hex')));
  assert.deepEqual(tokens.resolveViewer(db, a.token, NOW), { id: a.id, keys: ['ABC1'] });
  assert.deepEqual(tokens.resolveViewer(db, b.token, NOW), { id: b.id, keys: [] });
  assert.equal(tokens.resolveViewer(db, 'x'.repeat(43), NOW), null);
});

test('an expired or revoked token resolves to nothing', t => {
  const { db } = world(t);
  const short = tokens.issueViewer(db, { keys: [], days: 1 }, NOW);
  assert.ok(tokens.resolveViewer(db, short.token, NOW + DAY - 1));
  assert.equal(tokens.resolveViewer(db, short.token, NOW + DAY), null);
  const kept = tokens.issueViewer(db, { keys: [] }, NOW);
  assert.ok(tokens.resolveViewer(db, kept.token, NOW + 89 * DAY));
  assert.equal(tokens.revokeViewer(db, kept.id, NOW), true);
  assert.equal(tokens.resolveViewer(db, kept.token, NOW + 1), null);
  assert.equal(tokens.revokeViewer(db, 999, NOW), false);
});

test('dz web viewer prints a board link and rejects unknown keys and bad days', t => {
  const { ctx, db } = world(t);
  const [line] = viewer(ctx, ['viewer', 'ABC1'], NOW);
  const token = line.match(/^http:\/\/10\.0\.0\.5:8788\/board\/([\w-]+)$/)[1];
  assert.deepEqual(tokens.resolveViewer(db, token, NOW).keys, ['ABC1']);
  const all = viewer(ctx, ['viewer', '--days', '7'], NOW)[0].split('/').at(-1);
  assert.deepEqual(tokens.resolveViewer(db, all, NOW).keys, []);
  assert.equal(tokens.resolveViewer(db, all, NOW + 7 * DAY), null);
  assert.throws(() => viewer(ctx, ['viewer', 'NOPE9'], NOW), /NOPE9/);
  for (const args of [['viewer', '--days', '0'], ['viewer', '--days', '366'], ['viewer', '--days', 'x'], ['viewer', 'abc'], ['viewer', '--revoke'], ['viewer', '--list', 'ABC1'], ['other']]) {
    assert.equal(validViewer(args), false, args.join(' '));
  }
  for (const args of [['viewer'], ['viewer', 'ABC1', 'XYZ2'], ['viewer', 'ABC1', '--days', '30'], ['viewer', '--list'], ['viewer', '--revoke', '3']]) assert.equal(validViewer(args), true, args.join(' '));
});

test('dz web viewer --list and --revoke', t => {
  const { ctx, db } = world(t);
  viewer(ctx, ['viewer', 'ABC1'], NOW);
  viewer(ctx, ['viewer'], NOW);
  const listed = viewer(ctx, ['viewer', '--list'], NOW);
  assert.match(listed[0], new RegExp(`^#1 ABC1 hết hạn ${END}$`));
  assert.match(listed[1], new RegExp(`^#2 mọi project hết hạn ${END}$`));
  assert.deepEqual(viewer(ctx, ['viewer', '--revoke', '1'], NOW), ['Đã thu hồi link xem #1']);
  assert.match(viewer(ctx, ['viewer', '--list'], NOW)[0], new RegExp(`^#1 ABC1 hết hạn ${END} \\(đã thu hồi\\)$`));
  assert.throws(() => viewer(ctx, ['viewer', '--revoke', '9'], NOW), /#9/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM viewer_tokens').get().n, 2);
});

test('dz web without arguments still prints the operator link and dz web viewer is reachable', t => {
  const { h } = world(t);
  assert.equal(h.dz('web').status, 1);
  assert.equal(h.dz('web', 'viewer', 'abc').status, 2);
  const out = h.dz('web', 'viewer', 'ABC1');
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /\/board\/[\w-]{40,}\n$/);
});
