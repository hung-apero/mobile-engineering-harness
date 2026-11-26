const test = require('node:test');
const assert = require('node:assert/strict');
const { g, commit } = require('./bugs-git-fixtures.cjs');
const { setup, approve } = require('./bugs-machine-fixtures.cjs');

const TWO = ['AAP1-1', 'AAP1-2'];
const isLane = (lane, key) => lane.keys.includes(key);
const merged = s => s.files().filter(f => f.startsWith('AAP1-'));
const notesOf = s => JSON.parse(s.rows('SELECT data FROM batches')[0].data).notes;
const notes = (s, round) => JSON.parse(s.rows("SELECT payload FROM jobs WHERE kind = 'bug' AND key LIKE ?", `%#r${round}`)[0].payload).notes;

test('a commit that is not on the mirror is never merged', async t => {
  const s = setup(t, {
    keys: TWO,
    kinds: {
      ticket: (key, { payload }) => {
        if (key !== 'AAP1-1') return null;
        if (payload.round === 1) s.lane(payload.batchId, key);
        return { key, verdict: 'confirmed', status: 'approved', branch: `fix/aap1-1-${payload.batchId}`, commit: '1'.repeat(40) };
      },
    },
  });
  await s.until(await s.open());
  assert.equal(s.ticket('AAP1-1').state, 'dev');
  assert.deepEqual(merged(s), ['AAP1-2.txt']);
  assert.equal(s.codes('AAP1-1').at(-1), 'F01 give-dev');
  assert.match(notes(s, 2)[0].text, /mirror/);
});

test('a lane that does not descend from startSha is never merged', async t => {
  const kinds = {
    ticket: (key, job) => {
      if (key !== 'AAP1-1' || job.payload.round > 1) return null;
      const repo = s.repo(job.payload.batchId);
      const orphan = g(repo, 'commit-tree', '-m', 'x', 'HEAD^{tree}');
      const branch = `fix/aap1-1-${job.payload.batchId}`;
      g(repo, 'push', '-q', 'origin', `${orphan}:refs/heads/${branch}`);
      return { key, verdict: 'confirmed', status: 'approved', branch, commit: orphan };
    },
  };
  const s = setup(t, { keys: TWO, kinds });
  await s.until(await s.open(), b => b.data.round === 2);
  assert.match(notesOf(s)[0].text, /commit gốc/);
});

for (const [name, files, code] of [
  ['a forbidden file', { '.github/workflows/x.yml': 'x\n' }, 'forbidden'],
  ['a new permission', { 'app/AndroidManifest.xml': '<uses-permission/>\n' }, 'permission'],
  ['a secret', { 'K.kt': 'val k = "ghp_abcdefghijklmnop"\n' }, 'secret'],
]) {
  test(`${name} drops the lane to dev (F02) and the other lane lands`, async t => {
    const s = setup(t, { keys: TWO, kinds: { ticket: (key, job) => key === 'AAP1-1' && s.approved(job.payload.batchId, key, files) } });
    await s.until(await s.open());
    assert.equal(s.ticket('AAP1-1').state, 'dev');
    assert.ok(s.codes('AAP1-1').includes('F02 give-dev'));
    assert.match(s.rows("SELECT evidence FROM decisions WHERE code = 'F02'")[0].evidence, new RegExp(code));
    assert.equal(s.waits('dev').length, 1);
    assert.deepEqual(merged(s), ['AAP1-2.txt']);
    assert.doesNotMatch(JSON.stringify(s.comments('AAP1-1')), /ghp_/);
  });
}

test('a secret added then removed inside the lane drops it and its history is not pushed', async t => {
  const kinds = {
    ticket: (key, job) => {
      if (key !== 'AAP1-1') return null;
      s.lane(job.payload.batchId, key, { 'K.kt': 'val k = "ghp_abcdefghijklmnop"\n' });
      const repo = s.repo(job.payload.batchId);
      const branch = `fix/aap1-1-${job.payload.batchId}`;
      s.bad = g(repo, 'rev-parse', 'HEAD');
      const sha = commit(repo, { 'K.kt': 'val k = 1\n' });
      g(repo, 'push', '-q', 'origin', `${sha}:refs/heads/${branch}`);
      return { key, verdict: 'confirmed', status: 'approved', branch, commit: sha };
    },
  };
  const s = setup(t, { keys: TWO, kinds });
  await s.until(await s.open());
  assert.ok(s.codes('AAP1-1').includes('F02 give-dev'));
  assert.deepEqual(merged(s), ['AAP1-2.txt']);
  assert.throws(() => g(s.github, 'cat-file', '-e', s.bad));
});

test('a lane with more than 30 commits is given to dev', async t => {
  const kinds = {
    ticket: (key, job) => {
      if (key !== 'AAP1-1') return null;
      const { branch } = s.lane(job.payload.batchId, key);
      const repo = s.repo(job.payload.batchId);
      for (let i = 0; i < 30; i++) g(repo, 'commit', '-q', '--allow-empty', '-m', `c${i}`);
      g(repo, 'push', '-q', 'origin', `HEAD:refs/heads/${branch}`);
      return { key, verdict: 'confirmed', status: 'approved', branch, commit: g(repo, 'rev-parse', 'HEAD') };
    },
  };
  const s = setup(t, { keys: TWO, kinds });
  await s.until(await s.open());
  assert.match(s.rows("SELECT evidence FROM decisions WHERE code = 'F02'")[0].evidence, /31 commit/);
  assert.deepEqual(merged(s), ['AAP1-2.txt']);
});

test('other diff problems become fix notes', async t => {
  const kinds = { ticket: (key, job) => job.payload.round === 1 && s.approved(job.payload.batchId, key, { 'big.txt': 'x\n'.repeat(1600) }) };
  const s = setup(t, { kinds });
  await s.until(await s.open(), b => b.data.round === 2);
  assert.match(notesOf(s)[0].text, /too_large/);
});

test('reversesIntentional asks PO and the other lane still lands', async t => {
  const kinds = { reviewLane: l => isLane(l, 'AAP1-1') && { reversesIntentional: [{ key: 'AAP1-1', commit: '2ead732b', why: 'starts at 0' }] } };
  const s = setup(t, { keys: TWO, kinds });
  await s.until(await s.open());
  assert.equal(s.ticket('AAP1-1').state, 'concluded');
  assert.equal(s.ticket('AAP1-1').verdict, 'conflict');
  assert.match(s.comments('AAP1-1')[0], /2ead732b/);
  assert.equal(s.waits('po').length, 1);
  assert.ok(s.codes('AAP1-1').includes('B05 ask-po'));
  assert.deepEqual(merged(s), ['AAP1-2.txt']);
  assert.equal(s.ticket('AAP1-2').state, 'done');
});

for (const [name, patch] of [
  ['needsPo', l => ({ needsPo: l.keys.map(key => ({ key, question: 'bao nhiêu?' })) })],
  ['specMatch false', () => ({ specMatch: false, findings: [{ file: 'a', line: 1, severity: 'major', text: 'sai spec' }] })],
]) {
  test(`${name} in an approved lane asks PO and drops the lane`, async t => {
    const s = setup(t, { kinds: { reviewLane: patch } });
    assert.equal((await s.until(await s.open())).state, 'done');
    assert.equal(s.ticket('AAP1-1').state, 'concluded');
    assert.equal(s.waits('po').length, 1);
    assert.equal(s.calls.includes('merge.mergeBatch'), false);
  });
}

test('a lane shared by two keys is dropped as a whole when one needs PO, the other key goes to the next batch', async t => {
  const kinds = {
    bug: job => {
      const lane = s.approved(job.payload.batchId, 'AAP1-1');
      return { tickets: [lane, { ...lane, key: 'AAP1-2' }, s.approved(job.payload.batchId, 'AAP1-3')] };
    },
    reviewLane: l => isLane(l, 'AAP1-1') && { needsPo: [{ key: 'AAP1-1', question: 'q' }] },
  };
  const s = setup(t, { keys: [...TWO, 'AAP1-3'], kinds });
  await s.until(await s.open());
  assert.deepEqual(['AAP1-1', 'AAP1-2', 'AAP1-3'].map(key => s.ticket(key).state), ['concluded', 'accepted', 'done']);
  assert.deepEqual(merged(s), ['AAP1-3.txt']);
});

test('changes go back with notes, only for the failing lane, and are reviewed again', async t => {
  const kinds = {
    ticket: (key, job) => job.payload.round === 2 && { ...s.approved(job.payload.batchId, key, { 'again.txt': 'x\n' }, { from: `fix/aap1-1-${job.payload.batchId}` }) },
    reviewLane: (l, job) => isLane(l, 'AAP1-1') && job.key.endsWith('v1') && { verdict: 'changes', findings: [{ file: 'A.kt', line: 3, severity: 'major', text: 'thiếu test' }] },
  };
  const s = setup(t, { keys: TWO, kinds });
  const id = (await s.until(await s.open())).id;
  assert.deepEqual(notes(s, 2), [{ key: 'AAP1-1', text: 'major A.kt:3 thiếu test' }]);
  const second = JSON.parse(s.rows("SELECT payload FROM jobs WHERE key LIKE '%#v2'")[0].payload);
  assert.deepEqual(second.lanes.map(l => l.keys), [['AAP1-1']]);
  assert.deepEqual(s.jobKeys().slice(0, 4), [`bug ${id}#r1`, `review ${id}#v1`, `bug ${id}#r2`, `review ${id}#v2`]);
  assert.deepEqual(merged(s), ['AAP1-1.txt', 'AAP1-2.txt']);
  assert.ok(s.files().includes('again.txt'));
});

test('an approval with a blocker finding counts as changes', async t => {
  const s = setup(t, { kinds: { reviewLane: () => ({ findings: [{ file: 'A.kt', line: 3, severity: 'blocker', text: 'crash' }] }) } });
  await s.until(await s.open(), b => b.data.round === 2);
  assert.match(notesOf(s)[0].text, /crash/);
});

test('changes stop after two fix rounds and the bug goes to dev', async t => {
  const kinds = {
    ticket: (key, job) => s.approved(job.payload.batchId, key, { [`r${job.payload.round}.txt`]: 'x\n' }, job.payload.round > 1 ? { from: `fix/aap1-1-${job.payload.batchId}` } : {}),
    reviewLane: () => ({ verdict: 'changes', findings: [{ file: 'A.kt', line: 3, severity: 'major', text: 'vẫn sai' }] }),
  };
  const s = setup(t, { kinds });
  const id = await s.open();
  assert.equal((await s.until(id)).state, 'done');
  assert.deepEqual(s.jobKeys().filter(k => k.startsWith('bug')), [`bug ${id}#r1`, `bug ${id}#r2`, `bug ${id}#r3`]);
  assert.equal(s.ticket('AAP1-1').state, 'dev');
  assert.ok(s.codes('AAP1-1').includes('F01 give-dev'));
});

test('an unreadable review is tried once more, then the batch is parked', async t => {
  const s = setup(t, { kinds: { review: () => ({ lanes: [] }) } });
  const id = await s.open();
  assert.equal((await s.until(id)).state, 'abandoned');
  assert.deepEqual(s.jobKeys().filter(k => k.startsWith('review')), [`review ${id}#v1`, `review ${id}#v2`]);
});

test('the review runs in a detached tree of the mirror at startSha, not in the clone', async t => {
  let tree;
  const kinds = { review: job => {
    tree = job.payload.repo;
    s.seen = [g(tree, 'rev-parse', 'HEAD'), g(tree, 'rev-parse', '--path-format=absolute', '--git-common-dir'), job.payload.lanes.every(l => g(tree, 'cat-file', '-t', l.commit) === 'commit')];
    return { lanes: job.payload.lanes.map(approve) };
  } };
  const s = setup(t, { kinds });
  await s.until(await s.open());
  assert.equal(tree.endsWith('/review'), true);
  assert.deepEqual(s.seen, [s.batch(1).data.startSha, s.mirror, true]);
});
