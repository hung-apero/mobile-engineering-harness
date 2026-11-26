const { test } = require('node:test');
const assert = require('node:assert/strict');
const kv = require('../src/kv.cjs');
const store = require('../src/bugs/store.cjs');
const { readReviews, attachNotes, answerNotes } = require('../src/bugs/pr-review.cjs');
const { setup, NOW, VERSION } = require('./e2e-fixtures.cjs');

const user = login => ({ login, type: 'User' });
const row = (id, login, body, extra = {}) => ({ id, user: user(login), body, html_url: `https://github.com/x/${id}`, ...extra });

async function world(t, { live = true, rows = {}, permission = { dev: 'write', guest: 'read' }, status = 'Resolved' } = {}) {
  const s = await setup(t, { live, build: false });
  const lane = s.lane('fix/aap1-1-1', { 'one.txt': '1\n' });
  const data = { pr: { number: 7, url: 'u' }, delivered: true, startSha: s.startSha, lanes: [{ branch: 'fix/aap1-1-1', commit: lane, keys: ['AAP1-1'] }] };
  s.db.prepare("INSERT INTO batches (id, project, version, kind, state, keys, data, opened_at, updated_at) VALUES (1, 'AAP1', ?, 'normal', 'done', '[\"AAP1-1\"]', ?, 1, 1)").run(VERSION, JSON.stringify(data));
  s.status = status;
  s.writes = [];
  s.jira.issue = async key => ({ key, status: { name: s.status } });
  s.jira.transitions = async () => [{ to_status: 'Reopened' }];
  s.jira.transition = async (key, to) => { s.writes.push([key, to]); s.status = to; };
  s.ctx.bugs.gh = async args => {
    s.gh.push(args);
    const route = args[3] ?? '';
    const login = route.match(/collaborators\/([^/]+)\/permission/)?.[1];
    if (login) return { stdout: JSON.stringify({ permission: permission[login] ?? 'none' }) };
    const kind = route.includes('pulls/7/comments') ? 'inline' : route.includes('/reviews') ? 'review' : 'comment';
    return { stdout: JSON.stringify(rows[kind] ?? []) };
  };
  s.read = () => readReviews(s.ctx, s.project, s.version(), NOW);
  s.note = id => kv.get(s.db, `pr-note:AAP1:${VERSION}:${id}`);
  return s;
}

const INLINE = { inline: [row(1, 'dev', 'đổi tên hàm này', { path: 'one.txt', line: 3 })] };

test('F06: a writer comment on a delivered file reopens its ticket once and queues a note', async t => {
  const s = await world(t, { rows: INLINE });
  assert.equal(await s.read(), 1);
  assert.equal(await s.read(), 0);
  assert.deepEqual(s.writes, [['AAP1-1', 'Reopened']]);
  assert.deepEqual([s.note('inline-1').state, s.note('inline-1').keys], ['queued', ['AAP1-1']]);
  assert.match(s.note('inline-1').text, /one\.txt:3 đổi tên/);
  assert.deepEqual(s.actions('F06'), ['fix-round']);
});

test('F06: people without write, bots, our own posts, approvals and empty bodies make no note; reading is GET only', async t => {
  const s = await world(t, { rows: {
    inline: [row(1, 'guest', 'x', { path: 'one.txt' }), { ...row(2, 'ci', 'x'), user: { login: 'ci', type: 'Bot' } }, row(3, 'dev', '[Claude] đã sửa')],
    review: [row(4, 'dev', 'ok', { state: 'APPROVED' }), row(5, 'dev', ' ', { state: 'CHANGES_REQUESTED' })],
  } });
  assert.equal(await s.read(), 0);
  assert.deepEqual(s.actions('F06'), ['noted-only']);
  assert.deepEqual(s.writes, []);
  assert.ok(s.gh.every(args => args[0] === 'api' && args[2] === 'GET'));
});

test('F06: naming a ticket without /fix or CHANGES_REQUESTED never reopens it, dev is told how', async t => {
  const s = await world(t, { rows: { comment: [row(1, 'dev', 'AAP1-1 looks good')], review: [row(2, 'dev', 'AAP1-1 ổn rồi', { state: 'COMMENTED' })], inline: [row(3, 'dev', 'AAP1-1 looks good', { path: 'la.txt' })] } });
  await s.read();
  assert.deepEqual(s.writes, []);
  assert.deepEqual(['comment-1', 'review-2', 'inline-3'].map(id => s.note(id).state), ['dev', 'dev', 'dev']);
  assert.match(s.waits('dev').join(), /\/fix/);
});

test('F06: a CHANGES_REQUESTED review naming its ticket, or an inline comment of one, reopens it', async t => {
  const s = await world(t, { rows: { review: [row(1, 'dev', 'AAP1-1 chưa đúng', { state: 'CHANGES_REQUESTED' })] } });
  await s.read();
  assert.deepEqual([s.note('review-1').state, s.writes], ['queued', [['AAP1-1', 'Reopened']]]);
});

test('F06: a reply that could not be posted is posted on the next reading, once', async t => {
  const s = await world(t, { rows: INLINE });
  await s.read();
  const lane = { keys: ['AAP1-1'], commit: 'c'.repeat(40) };
  s.db.prepare("INSERT INTO batches (id, project, version, kind, state, keys, data, opened_at, updated_at) VALUES (2, 'AAP1', ?, 'normal', 'done', '[\"AAP1-1\"]', ?, 1, 1)").run(VERSION, JSON.stringify({ phase: 'done', delivered: true, pr: { number: 7, url: 'u' }, prNotes: [`pr-note:AAP1:${VERSION}:inline-1`], startSha: s.startSha, lanes: [lane] }));
  const gh = s.ctx.bugs.gh;
  let mode = 'down';
  const replies = [];
  s.ctx.bugs.gh = async args => {
    if (args[2] !== 'POST') return args[3].includes('pulls/7/comments') ? { stdout: JSON.stringify([...INLINE.inline, ...replies]) } : gh(args);
    if (mode === 'down') throw new Error('502');
    replies.push({ id: 90 + replies.length, user: user('bot'), body: args.at(-1).slice('body='.length), in_reply_to_id: 1 });
    if (mode === 'lost') throw new Error('timeout');
    return { stdout: '{}' };
  };
  await assert.rejects(answerNotes(s.ctx, s.project, store.getBatch(s.db, 2), NOW), /502/);
  assert.equal(s.note('inline-1').state, 'queued');
  mode = 'lost';
  await assert.rejects(s.read(), /timeout/);
  mode = 'up';
  await s.read();
  await s.read();
  assert.equal(replies.length, 1);
  assert.equal(s.note('inline-1').state, 'answered');
});

test('F06: a comment with /fix naming its ticket is mapped without a path; one that maps nowhere goes to dev', async t => {
  const s = await world(t, { rows: { comment: [row(1, 'dev', '/fix AAP1-1 chưa đúng'), row(2, 'dev', 'nhìn chung ổn chưa?')], inline: [row(3, 'dev', 'x', { path: 'la.txt' })] } });
  await s.read();
  assert.equal(s.note('comment-1').state, 'queued');
  assert.equal(s.note('comment-2').state, 'dev');
  assert.equal(s.waits('dev').length, 2);
});

test('F06: a ticket QA already closed is not reopened, dev is told', async t => {
  const s = await world(t, { rows: INLINE, status: 'Closed' });
  await s.read();
  assert.deepEqual(s.writes, []);
  assert.match(s.waits('dev')[0], /F06/);
});

test('F06: a dry project reads nothing', async t => {
  const s = await world(t, { live: false, rows: INLINE });
  assert.equal(await s.read(), 0);
  assert.equal(s.gh.length, 0);
});

test('F06: the notes enter the first fix round of the next batch once, and the reply is posted once after delivery', async t => {
  const s = await world(t, { rows: INLINE });
  await s.read();
  const data = { phase: 'fixing', round: 1, todo: ['AAP1-1'], notes: [], lanes: [] };
  s.db.prepare("INSERT INTO batches (id, project, version, kind, state, keys, data, opened_at, updated_at) VALUES (2, 'AAP1', ?, 'normal', 'running', '[\"AAP1-1\"]', ?, 1, 1)").run(VERSION, JSON.stringify(data));
  const first = attachNotes(s.ctx, store.getBatch(s.db, 2), NOW);
  const again = attachNotes(s.ctx, store.getBatch(s.db, 2), NOW);
  assert.equal(first.data.notes.length, 1);
  assert.equal(first.data.notes[0].key, 'AAP1-1');
  assert.deepEqual(again.data.notes, first.data.notes);
  const batch = { ...first, data: { ...first.data, delivered: true, lanes: [{ keys: ['AAP1-1'], commit: 'c'.repeat(40) }] } };
  const before = s.gh.length;
  await answerNotes(s.ctx, { ...s.project, live: false }, batch, NOW);
  assert.equal(s.gh.length, before);
  await answerNotes(s.ctx, s.project, batch, NOW);
  await answerNotes(s.ctx, s.project, batch, NOW);
  assert.deepEqual(s.gh.slice(before).map(args => args[3]), ['repos/Apero/AAP1/pulls/7/comments/1/replies']);
  assert.equal(s.note('inline-1').state, 'answered');
});
