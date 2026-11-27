const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { g } = require('./bugs-git-fixtures.cjs');
const { setup, BRANCH, VERSION } = require('./bugs-machine-fixtures.cjs');
const store = require('../src/bugs/store.cjs');

test('one lane goes from open to done with the exact effects in order', async t => {
  const s = setup(t);
  const id = await s.open();
  const before = s.calls.length;
  const batch = await s.until(id);
  assert.equal(batch.state, 'done');
  assert.deepEqual(s.jobKeys(), [`bug ${id}#r1`, `review ${id}#v1`, `gate ${id}#g1`, `build ${id}#b1`, `build ${id}#d1`]);
  const wanted = /^(jira\.(transition|addLabels|removeLabels|comment)$|merge\.(?!revert)|gh\.create|cleanup\.)/;
  assert.deepEqual(s.calls.slice(before).filter(name => wanted.test(name) || name === 'workspace.ensureClone'), [
    'cleanup.pruneAbandoned', 'jira.transition', 'jira.addLabels', 'workspace.ensureClone', 'merge.mergeBatch', 'merge.pushVersion', 'gh.create', 'merge.ensurePr',
    'jira.comment', 'jira.removeLabels', 'jira.transition', 'cleanup.releaseDevices', 'cleanup.removeBatchFiles',
  ]);
  assert.deepEqual(s.rows('SELECT id, state FROM effects ORDER BY rowid').map(r => `${r.id} ${r.state}`), [
    `${id}:AAP1-1:claim done`, `${id}:AAP1-1:label done`, `${id}:-:decide-fixed-r1 done`, `${id}:-:decide-review-v1 done`, `${id}:-:merge-1 done`,
    `${id}:-:merged done`, `${id}:-:decide-gate-green done`, `${id}:-:build-green done`, `${id}:-:push done`, `${id}:-:pr done`,
    `${id}:-:decide-published done`, `${id}:-:decide-distributed done`, `${id}:AAP1-1:comment-resolved done`, `${id}:AAP1-1:unlabel done`,
    `${id}:AAP1-1:resolve done`, `${id}:AAP1-1:fixed done`, `${id}:-:qa-wait done`,
  ]);
});

test('the delivered ticket, version and waits are in their final state', async t => {
  const s = setup(t);
  const id = await s.open();
  const batch = await s.until(id);
  const issue = s.fake.issues['AAP1-1'];
  assert.equal(issue.status, 'Resolved');
  assert.deepEqual(issue.labels, []);
  const [comment, ...more] = issue.comments;
  assert.deepEqual(more, []);
  assert.match(comment, /^\[Claude\] /);
  assert.ok(comment.endsWith(`dz:${id}:AAP1-1:resolved`));
  assert.match(comment, /pull\/1/);
  assert.match(comment, /sha256 [0-9a-f]{12}\n/);
  assert.equal(s.ticket('AAP1-1').state, 'done');
  assert.equal(s.ticket('AAP1-1').verdict, 'fixed');
  assert.equal(store.getVersion(s.db, 'AAP1', VERSION).polling, true);
  assert.deepEqual(s.waits('qa'), [`Kiểm bản cài AAP1 ${VERSION}`]);
  assert.deepEqual(s.waits('dev'), []);
  assert.equal(s.ref(BRANCH, s.github), s.ref(BRANCH));
  assert.ok(s.files(s.github).includes('AAP1-1.txt'));
  assert.deepEqual(fs.readdirSync(path.dirname(s.repo(id))), ['start-sha']);
  assert.equal(g(s.mirror, 'worktree', 'list').split('\n').length, 1);
  assert.equal(batch.data.landing, false);
  assert.equal(g(s.github, 'rev-parse', 'develop'), g(s.dev, 'rev-parse', 'develop'));
});

test('job payloads hold what the handlers require', async t => {
  const s = setup(t);
  const id = await s.open();
  await s.until(id, b => b.data.phase === 'distributing');
  const prepare = (kind, key) => {
    const row = s.rows('SELECT * FROM jobs WHERE kind = ? AND key = ?', kind, key)[0];
    const job = { ...row, kind, payload: JSON.parse(row.payload), slotsGranted: 1 };
    fs.mkdirSync(path.join(s.dzHome, 'secrets'), { recursive: true });
    const tools = 'jira_get_issue,jira_search,jira_get_transitions,jira_download_attachments';
    fs.writeFileSync(path.join(s.dzHome, 'secrets', 'jira-read.json'), JSON.stringify({ mcpServers: { jira: { command: 'x', args: [], env: { READ_ONLY_MODE: 'true', ENABLED_TOOLS: tools } } } }), { mode: 0o600 });
    return require(`../src/handlers/${kind}.cjs`).prepare(job, { dzHome: s.dzHome, project: s.project });
  };
  assert.match(prepare('bug', `${id}#r1`).prompt, /AAP1-1/);
  const review = prepare('review', `${id}#v1`);
  assert.equal(path.basename(review.cwd), 'review');
  assert.equal(fs.existsSync(path.join(review.cwd, '.claude')), false);
  assert.equal(path.basename(prepare('gate', `${id}#g1`).cwd), 'gate');
  assert.ok(prepare('build', `${id}#b1`).command);
});

test('a bug job takes two slots for two keys and priority 0 in a highest batch', async t => {
  const s = setup(t, { keys: ['AAP1-1', 'AAP1-2'] });
  const id = await s.open();
  await s.until(id, b => b.data.phase === 'fixing');
  await s.advance(id);
  assert.deepEqual(s.rows('SELECT slots, priority FROM jobs'), [{ slots: 2, priority: 1 }]);
  const h = setup(t, { issues: { 'AAP1-1': { priority: 'Highest' } } });
  const high = await h.open();
  await h.until(high, b => b.data.phase === 'fixing');
  await h.advance(high);
  assert.deepEqual(h.rows('SELECT slots, priority FROM jobs'), [{ slots: 1, priority: 0 }]);
});

test('dry run writes only would rows and calls no write tool', async t => {
  const s = setup(t, { live: false });
  const id = await s.open();
  const batch = await s.until(id);
  assert.equal(batch.state, 'done');
  assert.deepEqual(s.writes(), []);
  assert.equal(s.calls.includes('gh.create'), false);
  assert.equal(g(s.github, 'for-each-ref', '--format=%(refname)'), 'refs/heads/develop');
  const would = s.rows("SELECT evidence FROM decisions WHERE action = 'would' ORDER BY id").map(r => JSON.parse(r.evidence).text.replace(/[0-9a-f]{40}/, 'SHA'));
  assert.deepEqual(would, [
    'jira transition AAP1-1 -> In Progress', 'jira addLabels AAP1-1', `git push SHA:refs/heads/${BRANCH} (Apero/AAP1)`,
    `gh pr create --draft ${BRANCH} -> develop (Apero/AAP1)`, 'firebase distribute SHA', `jira comment AAP1-1 dz:${id}:AAP1-1:resolved`,
    'jira removeLabels AAP1-1', 'jira transition AAP1-1 -> Resolved',
  ]);
  assert.ok(s.rows('SELECT id FROM effects').every(r => r.id.startsWith('dry:')));
  assert.equal(s.ticket('AAP1-1').state, 'done');
  assert.equal(s.jobKeys().some(k => k.endsWith('#d1')), false);
});
