const { test } = require('node:test');
const assert = require('node:assert/strict');
const commands = require('../src/spec-commands.cjs');
const { ExpectedError } = require('../src/run.cjs');
const { setup } = require('./specs-flow-fixtures.cjs');

test('spec build is refused on v2', async t => {
  const s = setup(t);
  await s.toReview();
  assert.equal((await s.facade.approve(s.id, { sha: s.facade.review(s.id).sha, quote: 'Duyệt' }, 'po', s.now)).ok, true);
  await assert.rejects(commands.spec(s.ctx, ['build', String(s.id), '--version', '1.0.0'], s.now), error => error instanceof ExpectedError && /đoạn build chưa có ở v2/.test(error.message));
  assert.equal(s.spec().state, 'approved');
});
