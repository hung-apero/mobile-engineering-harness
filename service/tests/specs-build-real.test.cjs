const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tick } = require('../src/tick.cjs');
const { setupBuild, g, VERSION, SERIAL } = require('./specs-build-fixtures.cjs');
const { writeScript, sleep } = require('./service-fixtures.cjs');

const WORKER = path.join(__dirname, 'fixtures', 'fake-learn-app-worker.cjs');

function gradle(root) {
  const bin = path.join(root, 'fake-bin', 'gradlew');
  writeScript(bin, 'echo "$@" >> "$(dirname "$0")/gradle.log"\ncase "$1" in assemble) mkdir -p out && cp feature.txt out/app.apk;; esac');
  return bin;
}

test('from a pasted spec to would: PR with real worker processes, a worker that dies in its worktree, and a fake gradle', { timeout: 120000 }, async t => {
  const s = setupBuild(t, { workers: false });
  const rulesFor = s.ctx.rulesFor;
  s.ctx.rulesFor = key => {
    const rules = rulesFor(key);
    return { ...rules, limits: { ...rules.limits, code_agents_working: rules.limits.code_agents_off } };
  };
  const bin = gradle(s.h.root);
  const commands = { compile: [bin, 'compile'], unitTest: [bin, 'test'], assemble: [bin, 'assemble'], apkGlob: 'out/*.apk' };
  s.h.project('ABC1', { live: false, forbidden: ['billing/**'], commands });
  writeScript(path.join(s.h.root, 'fake-claude'), `exec "${process.execPath}" "${WORKER}" "$@"`);
  let now = s.now;
  const to = async name => {
    for (let i = 0; i < 400; i++) {
      if (s.spec().state === name) return;
      if (s.spec().state === 'parked') break;
      now = Math.max(now + 100, Date.now());
      await tick(s.ctx, now);
      await Promise.all([s.ctx.specStepPending, s.ctx.bugStepPending]);
      await sleep(50);
    }
    assert.equal(s.spec().state, name, JSON.stringify([s.spec().data.parked, s.log()]));
  };
  await to('quiz');
  s.facade.saveDraft(s.id, { qid: 'Q1', choice: 'B', text: '' }, 'po', now);
  s.facade.submit(s.id, 'po', now);
  await to('review');
  await s.facade.approve(s.id, { sha: s.facade.review(s.id).sha, quote: 'Tôi duyệt' }, 'po', now);
  await s.cmd('build', String(s.id), '--version', VERSION);
  await to('po-trial');

  const notes = fs.readFileSync(path.join(s.repo(), '.git', 'fake-worker.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const [died, again] = notes.filter(note => note.worktrees);
  assert.deepEqual([died.started, died.worktrees, died.parallel], [['01-path'], 2, '2']);
  assert.deepEqual([again.started, again.running, again.worktrees, again.half], [[], ['01-path'], 2, true]);
  assert.equal(notes.at(-1).serial, SERIAL);
  const { candidate } = s.spec().data.build;
  assert.deepEqual(s.tree(candidate.sha), ['.gitignore', 'app.txt', 'feature.txt', 'half.txt', 'merged.txt']);
  assert.ok(s.would().some(text => /gh pr create --draft dz\/feature-ABC1-1 -> main/.test(text)));
  assert.equal(g(s.github, 'for-each-ref', '--format=%(refname)'), 'refs/heads/main');
  assert.match(fs.readFileSync(path.join(s.h.root, 'fake-bin', 'gradle.log'), 'utf8'), /compile\ntest\nassemble/);

  await s.facade.approve(s.id, { sha: candidate.sha, quote: 'Tôi duyệt bản cài' }, 'po', now);
  await to('landed-dry');
  assert.deepEqual(s.tree(`refs/heads/dz/release-${VERSION}`), ['.gitignore', 'app.txt', 'feature.txt', 'half.txt', 'merged.txt']);
});
