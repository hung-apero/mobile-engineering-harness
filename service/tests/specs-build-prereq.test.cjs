const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parsePrereqs, suggestPrereqs } = require('../src/specs/prereq.cjs');
const { validSpec } = require('../src/spec-commands.cjs');
const { setupBuild, VERSION } = require('./specs-build-fixtures.cjs');

const MIN = 60000;
const replies = open => args => {
  if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ state: open.pr ? 'OPEN' : 'MERGED', mergedAt: null });
  if (args[0] === 'pr') return open.branch ? '[]' : '[{"number":9}]';
  if (args[0] === 'repo') return '{"defaultBranchRef":{"name":"develop"}}';
  return open.ahead ?? '3\n';
};

test('waiting-prereq names PR #272 and the SDK branch, pings dev, and rechecks every 15 minutes', async t => {
  const s = setupBuild(t);
  const open = { pr: true, branch: true };
  s.ghReply = replies(open);
  await s.toApproved();
  const lines = await s.cmd('prereq', String(s.id), '--pr', '272', '--branch', 'apero/learn-sdk:feat/clp-host-hooks');
  assert.match(lines.join('\n'), /PR #272 \(apero\/learn-app\)/);
  await s.cmd('build', String(s.id), '--version', VERSION);
  await s.tick();
  assert.equal(s.spec().state, 'waiting-prereq');
  const [wait] = s.waits();
  assert.equal(wait.role, 'dev');
  assert.match(wait.subject, /PR #272 \(apero\/learn-app\) chưa merge \(open\)/);
  assert.match(wait.subject, /nhánh feat\/clp-host-hooks \(apero\/learn-sdk\) chưa vào develop/);
  const calls = s.ghCalls.length;
  await s.tick(5 * MIN);
  assert.equal(s.ghCalls.length, calls);
  open.pr = false;
  await s.tick(11 * MIN);
  assert.ok(s.ghCalls.length > calls);
  assert.doesNotMatch(s.waits()[0].subject, /#272/);
  open.branch = false;
  await s.tick(16 * MIN);
  await s.until(() => s.running('spec').length === 1);
  assert.equal(s.spec().state, 'building');
  assert.equal(s.waits().length, 0);
  const verbs = s.ghCalls.map(args => `${args[0]} ${args[1]}`);
  assert.ok(verbs.every(verb => ['pr view', 'pr list', 'repo view', 'api --method'].includes(verb)));
  assert.ok(s.ghCalls.filter(args => args[0] === 'api').every(args => args[2] === 'GET'));
});

test('a branch fully behind the default branch counts as merged, and a gh error never does', async t => {
  const s = setupBuild(t);
  s.ghReply = replies({ pr: false, branch: true, ahead: '0\n' });
  await s.toApproved();
  await s.cmd('prereq', String(s.id), '--branch', 'apero/learn-sdk:feat/x');
  await s.cmd('build', String(s.id), '--version', VERSION);
  s.ghReply = () => { throw new Error('gh: HTTP 401'); };
  await s.tick();
  assert.equal(s.spec().state, 'waiting-prereq');
  assert.match(s.waits()[0].subject, /không kiểm được: gh: HTTP 401/);
  s.ghReply = replies({ pr: false, branch: true, ahead: '0\n' });
  await s.tick(16 * MIN);
  await s.until(() => s.running('spec').length === 1);
});

test('the text of the spec only gives suggestions, and the list can be changed or cleared at any time', async t => {
  const s = setupBuild(t);
  s.ghReply = replies({ pr: true, branch: true });
  await s.toApproved();
  const shown = (await s.cmd('prereq', String(s.id))).join('\n');
  assert.match(shown, /Chưa đặt điều kiện trước nào/);
  assert.match(shown, /--pr apero\/learn-app#272/);
  assert.match(shown, /--branch <owner\/repo>:feat\/clp-host-hooks/);
  await s.cmd('prereq', String(s.id), '--pr', '272');
  await s.cmd('build', String(s.id), '--version', VERSION);
  await s.tick();
  assert.equal(s.spec().state, 'waiting-prereq');
  await s.cmd('prereq', String(s.id), '--clear');
  assert.equal(s.waits().length, 0);
  await s.until(() => s.running('spec').length === 1);
});

test('a changed clarified spec stops the build before any code is written', async t => {
  const s = setupBuild(t);
  await s.toApproved();
  require('./specs-flow-fixtures.cjs').put(s.repo(), { 'inputs/spec-v3.md': '# Spec khác\n' });
  await s.cmd('build', String(s.id), '--version', VERSION);
  await s.tick();
  assert.equal(s.spec().state, 'parked');
  assert.match(s.spec().data.parked.reason, /không phải bản PO đã duyệt/);
  assert.equal(s.running('spec').length, 0);
});

test('with less than 40 GB free only one plan is coded at a time, and the reserved bug slot stays free', async t => {
  const s = setupBuild(t);
  s.ctx.freeGb = () => 30;
  await s.toBuilding();
  assert.equal(s.calls.at(-1).env.LEARN_APP_PARALLEL, '1');
  const roomy = setupBuild(t);
  await roomy.toBuilding();
  assert.equal(roomy.calls.at(-1).env.LEARN_APP_PARALLEL, '2');
});

test('prereq arguments are checked', async t => {
  for (const args of [['prereq', '1', '--pr', '272', '--branch', 'a/b:c/d'], ['prereq', '1'], ['prereq', '1', '--clear'], ['build', '1', '--version', '1.9.2']]) assert.equal(validSpec(args), true, args.join(' '));
  for (const args of [['prereq'], ['prereq', '1', '--pr'], ['prereq', '1', '--x', '1'], ['prereq', '1', '--clear', '--pr', '2'], ['build', '1'], ['build', '1', '--version', 'abc'], ['build', 'x', '--version', '1.0']]) assert.equal(validSpec(args), false, args.join(' '));
  for (const bad of [{ prs: ['x'], branches: [] }, { prs: ['a b#1'], branches: [] }, { prs: [], branches: ['a/b'] }, { prs: [], branches: ['a/b:../x'] }, { prs: [], branches: ['a/b:--x'] }, { prs: [], branches: ['--x:y'] }]) assert.throws(() => parsePrereqs(bad, 'o/r'), JSON.stringify(bad));
  assert.deepEqual(parsePrereqs({ prs: ['3', 'o/r#3'], branches: [] }, 'o/r'), [{ type: 'pr', repo: 'o/r', number: 3 }]);
  assert.deepEqual(suggestPrereqs('không có gì', 'o/r'), []);
  const s = setupBuild(t);
  await assert.rejects(s.cmd('build', String(s.id), '--version', VERSION), /chỉ bắt đầu code spec đã duyệt/);
});
