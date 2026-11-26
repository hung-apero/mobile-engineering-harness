const { test } = require('node:test');
const assert = require('node:assert/strict');
const { NOW, MIN, CHANNEL, ELSEWHERE, PO, BACKUP, OTHER, SHA, SHA2, idAt, project, review, setup } = require('./mcp-fixtures.cjs');
const { bind, say, refused } = require('./mcp-approve-fixtures.cjs');

const one = { specs: [review(1)] };
test('a message that replies to no review post is never an approval, whenever it was sent', async t => {
  const s = setup(t, one);
  for (const time of [NOW - 61 * MIN, NOW - 30 * MIN, NOW - MIN]) await refused(s, s.discord.post('duyệt', {}, time), 'CHOOSE');
  const post = bind(s.db, 1);
  await refused(s, s.discord.post('duyệt'), 'CHOOSE');
  assert.equal((await s.call('approve', s.discord.post('duyệt', s.discord.replyTo(post)))).ok, true);
});

test('replay: an older message cannot come after a newer one that was used', async t => {
  const s = setup(t, one);
  const old = say(s, 'duyệt', {}, NOW - 5 * MIN);
  assert.equal((await s.call('approve', say(s, 'khoan, sửa màn 2'))).result.decision, 'feedback');
  assert.equal((await s.call('approve', old)).error.code, 'STALE');
  assert.deepEqual(s.facade.names(), ['feedback']);
});

test('a reply to the review of an older version is stale', async t => {
  const s = setup(t, { specs: [review(1, 'AAP864', { sha: SHA2 })] });
  const post = bind(s.db, 1, SHA);
  await refused(s, s.discord.post('duyệt', s.discord.replyTo(post)), 'STALE');
});

test('a reply to something else is never taken as approval of the only open review', async t => {
  const s = setup(t, one);
  await refused(s, s.discord.post('duyệt', s.discord.replyTo(idAt(NOW - 2 * MIN))), 'CHOOSE');
  await refused(s, s.discord.post('duyệt', s.discord.replyTo(bind(s.db, 1, '1', NOW, { kind: 'quiz' }))), 'CHOOSE');
  await refused(s, s.discord.post('duyệt', s.discord.replyTo(bind(s.db, 1, SHA, NOW, { channelId: ELSEWHERE }))), 'CHOOSE');
  await refused(s, s.discord.post('duyệt', s.discord.replyTo(bind(s.db, 1), ELSEWHERE)), 'REFUSED');
});

test('two open reviews: must reply to one of them', async t => {
  const s = setup(t, { specs: [review(1), review(2, 'AAP864', { sha: SHA2 })] });
  await refused(s, s.discord.post('duyệt'), 'CHOOSE');
  const post = bind(s.db, 2, SHA2);
  assert.equal((await s.call('approve', s.discord.post('duyệt', s.discord.replyTo(post)))).result.specId, 2);
});

test('no open review, an approved one or a spec of another project is refused', async t => {
  const s = setup(t, { specs: [review(1, 'AAP864', { state: 'quiz' })] });
  await refused(s, say(s, 'duyệt'), 'STATE');
  await refused(s, s.discord.post('duyệt', s.discord.replyTo(bind(s.db, 1))), 'STATE');
  const other = setup(t, { specs: [review(1, 'ZZZ999')] });
  await refused(other, other.discord.post('duyệt', other.discord.replyTo(bind(other.db, 1))), 'REFUSED');
});

test('one channel, two apps: never guessed, chosen by key or by reply', async t => {
  const projects = [project('AAP864'), project('AIP310'), project('AAP900', { channel: ELSEWHERE })];
  const s = setup(t, { projects, specs: [review(1), review(2, 'AIP310', { sha: SHA2 })] });
  assert.match((await refused(s, s.discord.post('duyệt'), 'CHOOSE')).message, /AAP864, AIP310/);
  await refused(s, s.discord.post('duyệt AAP864 AIP310'), 'CHOOSE');
  await refused(s, s.discord.post('duyệt AAP900'), 'REFUSED');
  await refused(s, s.discord.post('duyệt AIP310', s.discord.replyTo(bind(s.db, 1))), 'CHOOSE');
  await refused(s, s.discord.post('duyệt AIP310'), 'CHOOSE');
  assert.equal((await s.call('approve', say(s, 'duyệt AIP310', {}, NOW - MIN, { specId: 2, version: SHA2, project: 'AIP310' }))).result.specId, 2);
  assert.equal((await s.call('approve', s.discord.post('duyệt', s.discord.replyTo(bind(s.db, 1))))).result.specId, 1);
});

test('one channel, two apps: the PO of one cannot approve the other', async t => {
  const projects = [project('AAP864'), project('AIP310', { people: { po: BACKUP, qa: OTHER, devOnCall: OTHER } })];
  const s = setup(t, { projects, specs: [review(1), review(2, 'AIP310')] });
  await refused(s, s.discord.post('duyệt AIP310'), 'REFUSED');
  await refused(s, s.discord.post('duyệt', s.discord.replyTo(bind(s.db, 2, SHA, NOW - 10 * MIN, { project: 'AIP310' }))), 'REFUSED');
});

test('a bare approval in the channel is never enough, even with one open review', async t => {
  const s = setup(t, one);
  s.facade.overview = async () => ({ specs: [], waits: [], jobs: [] });
  await refused(s, s.discord.post('duyệt'), 'CHOOSE');
  assert.deepEqual(s.facade.names(), []);
});
