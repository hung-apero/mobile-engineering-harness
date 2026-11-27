const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../src/db.cjs');
const store = require('../src/specs/store.cjs');
const { createFacade } = require('../src/specs/facade.cjs');

test('openSpecs lists every open spec of a state, however many newer ones exist', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dz-wf-'));
  const db = openDb(path.join(dir, 'dz.db'));
  t.after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const first = store.createSpec(db, { project: 'ABC1', title: 'cũ', source: { type: 'pasted', text: 'x' }, figma: null }, 1);
  db.prepare("UPDATE specs SET state = 'review' WHERE id = ?").run(first.id);
  for (let i = 0; i < 40; i += 1) store.createSpec(db, { project: 'ABC1', title: `mới ${i}`, source: { type: 'pasted', text: 'x' }, figma: null }, 2 + i);
  const facade = createFacade({ db, dzHome: dir, projectsDir: path.join(dir, 'projects') });
  const open = facade.openSpecs('ABC1', 'review');
  assert.deepEqual(open.map(spec => spec.id), [first.id]);
  assert.equal(open[0].state, 'review');
  assert.equal(open[0].project, 'ABC1');
  assert.deepEqual(facade.openSpecs('ZZZ9', 'review'), []);
});
