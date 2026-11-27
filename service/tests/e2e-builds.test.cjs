const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { listBuilds, buildFor } = require('../src/e2e/builds.cjs');
const { setup, VERSION } = require('./e2e-fixtures.cjs');

test('builds keep the two newest APKs and a batch is kept once', async t => {
  const s = await setup(t);
  for (const id of [1, 2, 3]) await s.addBuild(id);
  const list = listBuilds(s.db, 'AAP1', VERSION);
  assert.deepEqual(list.map(b => [b.batchId, Boolean(b.apk)]), [[1, false], [2, true], [3, true]]);
  assert.equal(buildFor(s.db, 'AAP1', VERSION, list[2].tree).batchId, 3);
  assert.equal(fs.readdirSync(path.dirname(list[2].apk)).length, 2);
  fs.rmSync(list[2].apk);
  assert.equal(buildFor(s.db, 'AAP1', VERSION, list[2].tree), null);
});
