const { test } = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/specs/store.cjs');
const commands = require('../src/spec-commands.cjs');
const { setup, asked, clarified } = require('./specs-flow-fixtures.cjs');

function online(s, text) {
  const page = { markdown: text, reads: 0, comments: [] };
  s.ctx.specs.confluence = () => ({
    page: async () => ({ id: '9', title: '[ABC1] Phase 15', markdown: page.markdown, version: ++page.reads, url: '' }),
    commentOnce: async (ref, marker, body) => { page.comments.push([ref, marker, body]); return { skipped: false }; },
  });
  return page;
}

const url = { source: { type: 'url', ref: '332470208' } };
const approve = s => s.facade.approve(s.id, { sha: s.facade.review(s.id).sha, quote: 'Duyệt' }, 'po', s.now);

test('refresh with the same source changes nothing', async t => {
  const s = setup(t, url);
  online(s, '# a');
  await s.toQuiz();
  assert.match((await commands.spec(s.ctx, ['refresh', String(s.id)], s.now))[0], /không đổi/);
  assert.equal(s.spec().state, 'quiz');
});

test('refresh after the source changed starts a fresh clone with the old answers as notes and voids the approval', async t => {
  const s = setup(t, url);
  const page = online(s, '# a');
  await s.toReview();
  assert.equal((await approve(s)).ok, true);
  const first = s.repo();
  page.markdown = '# a mới';
  await commands.spec(s.ctx, ['refresh', String(s.id)], s.now);
  assert.deepEqual([s.spec().state, s.spec().approvedSha, s.spec().specSha], ['reading', null, null]);
  assert.equal(s.decisions('spec-refreshed')[0].code, 'S04');
  await s.until(() => s.running().length === 1);
  assert.notEqual(s.repo(), first);
  assert.deepEqual(s.clones.map(c => [c.specId, c.markdown]), [[`${s.id}`, '# a'], [`${s.id}-r2`, '# a mới']]);
  assert.equal(JSON.parse(s.read('inputs/headless.json')).notes, 'inputs/po-notes-prev.md');
  assert.match(s.read('inputs/po-notes-prev.md'), /\.harness-run\/inputs\/previous-spec\.md/);
  assert.ok(s.read('inputs/previous-spec.md').length > 0);
  assert.match(s.read('inputs/po-notes-prev.md'), /Q1 Change path đi đâu\? \(PO trả lời, 2026-11-25\): B — "Ở lại"/);
  assert.match(s.read('inputs/previous-spec.md'), /Q1: B/);
  await s.finish(repo => asked(repo));
  assert.deepEqual([s.spec().state, s.spec().round], ['quiz', 2]);
  assert.deepEqual(s.facade.quiz(s.id).ask.map(q => [q.id, q.draft, q.answered]), [['Q1', null, false], ['Q3', null, false]]);
  s.answer();
  await s.finish(repo => clarified(repo));
  assert.equal(s.spec().state, 'review');
  assert.equal((await approve(s)).ok, true);
});

test('drafts of the open round are carried over as PO drafts, an unmerged submit as answers (I5)', async t => {
  for (const submitted of [false, true]) {
    const s = setup(t, url);
    const page = online(s, '# a');
    await s.toQuiz();
    s.facade.saveDraft(s.id, { qid: 'Q1', choice: 'B', text: 'nháp Q1' }, 'po', s.now);
    s.facade.saveDraft(s.id, { qid: 'Q3', choice: 'Khác', text: 'chữ nghiêng' }, 'po', s.now);
    s.facade.changeAuto(s.id, 'Q2', { choice: 'B', text: '' }, 'po', s.now);
    if (submitted) {
      s.facade.submit(s.id, 'po', s.now);
      store.transitionSpec(s.ctx.db, s.id, ['clarifying'], 'parked', s.now, { data: { parked: { reason: 'x', from: 'clarifying' } } });
    }
    page.markdown = '# a mới';
    await commands.spec(s.ctx, ['refresh', String(s.id)], s.now);
    await s.until(() => s.running().length === 1);
    const notes = s.read('inputs/po-notes-prev.md');
    const kind = submitted ? 'PO trả lời' : 'PO nháp, chưa nộp';
    for (const row of [`Q1 Change path đi đâu? (${kind}, 2026-11-25): B — "Ở lại — nháp Q1"`, `Q3 Kiểu chữ (${kind}, 2026-11-25): Khác — "chữ nghiêng"`, `Q2 Màu nút (${kind}, 2026-11-25): B — "Đỏ"`]) assert.ok(notes.includes(row), `${row}\n${notes}`);
  }
});

test('refresh is refused while a segment is running', async t => {
  const s = setup(t, url);
  online(s, '# a');
  await s.until(() => s.running().length === 1);
  await assert.rejects(async () => commands.spec(s.ctx, ['refresh', String(s.id)], s.now), /asking/);
});

test('a live approval comments once on the page, a dry one only records what it would do', async t => {
  for (const live of [true, false]) {
    const s = setup(t, { ...url, live });
    const page = online(s, '# a');
    await s.toReview();
    assert.equal((await approve(s)).ok, true);
    await s.tick();
    await s.tick();
    assert.equal(page.comments.length, live ? 1 : 0);
    if (live) assert.doesNotMatch(page.comments[0][2], /\/review\/|http/);
    else assert.match(s.decisions('would').at(-1).evidence, /confluence comment/);
    assert.equal(s.spec().data.commented, s.spec().approvedSha);
  }
});

test('a comment only recorded in a dry run is posted once the project is live (M6)', async t => {
  const s = setup(t, url);
  const page = online(s, '# a');
  await s.toReview();
  await approve(s);
  await s.tick();
  assert.equal(page.comments.length, 0);
  s.h.project('ABC1', { live: true });
  await s.tick();
  await s.tick();
  assert.equal(page.comments.length, 1);
});

test('a comment that keeps failing does not touch the approval and calls the dev', async t => {
  const s = setup(t, { ...url, live: true });
  online(s, '# a');
  const { page } = s.ctx.specs.confluence();
  s.ctx.specs.confluence = () => ({ page, commentOnce: async () => { throw new Error('403'); } });
  await s.toReview();
  await approve(s);
  for (let i = 0; i < 6; i++) await s.tick(16 * 60000);
  assert.equal(s.spec().state, 'approved');
  assert.deepEqual(s.waits().map(w => w.role), ['dev']);
});

test('dry run: only local commands, no Discord, no Confluence write, no push', async t => {
  const s = setup(t);
  const ran = [];
  const real = s.ctx.specs.runState;
  s.ctx.specs.runState = (project, repo, args) => { ran.push(args[0]); return real(project, repo, args); };
  s.h.webhook('ABC1');
  await s.toReview();
  await approve(s);
  await s.tick(10 * 3600000);
  assert.deepEqual(s.sends, []);
  assert.deepEqual(ran, []);
  for (const { args, env } of s.calls) {
    assert.ok(args.includes('Bash(git push:*)'));
    assert.ok(args.includes('AskUserQuestion'));
    assert.equal(args.includes('--mcp-config'), false);
    assert.equal(env.HARNESS_HEADLESS, '1');
    assert.equal(env.GIT_SSH_COMMAND, '/usr/bin/false');
    assert.equal(Object.keys(env).some(name => /^(?:LEARN_APP_)?DISCORD_|GH_TOKEN|JIRA_API/.test(name)), false);
  }
  assert.equal(store.getSpec(s.ctx.db, s.id).state, 'approved');
});
