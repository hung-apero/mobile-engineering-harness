const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setupBuild, coded, smoked, put, SMOKE, SERIAL, OK } = require('./specs-build-fixtures.cjs');
const { readSmoke } = require('../../src/specs/smoke-report.cjs');

const MIN = 60000;
const FIGMA = 'https://www.figma.com/design/abc123/App';
const ERR = (title, stack = 'không có') => `### 1. ${title}\nplan: 01-path\nStack:\n${stack}\n`;
const screen = (slug, score, verdict, findings = []) => ({ slug, score, verdict, findings });

function withFigma(t) {
  const s = setupBuild(t, { figma: FIGMA });
  fs.writeFileSync(path.join(s.h.dzHome, 'secrets', 'figma-read.json'), JSON.stringify({ mcpServers: { 'framelink-figma': { command: 'x' } } }), { mode: 0o600 });
  return s;
}

const ui = (s, screens) => s.finish(null, { kind: 'uidiff', event: { ...OK, result: '', structured_output: { screens } } });

async function toUi(t) {
  const s = withFigma(t);
  await s.toBuilding();
  await s.code();
  await s.finish(repo => {
    put(repo, { 'figma/home.json': { slug: 'home', node: '1:2', name: 'Home' }, 'figma/popup.json': { slug: 'popup', kind: 'popup' } });
    smoked(repo);
  });
  return s;
}

test('without a device nothing is tried and no install is sent: the spec waits and pings dev (F05)', async t => {
  const s = setupBuild(t);
  s.devices.free = [];
  await s.toBuilding();
  await s.code();
  await s.tick(10 * MIN);
  await s.tick(10 * MIN);
  assert.equal(s.spec().state, 'smoking');
  assert.equal(s.running('spec').length, 0);
  assert.match(s.waits().find(wait => wait.role === 'dev').subject, /thiếu thiết bị nên chưa chạy thử và chưa gửi bản cài \(F05\)/);
  assert.equal(s.decisions('spec-no-device').length, 1);
  assert.deepEqual([s.would(), s.spec().data.build.candidate ?? null], [[], null]);
  s.devices.free = [SERIAL];
  await s.tick(5 * MIN);
  await s.until(() => s.running('spec').length === 1);
  assert.equal(s.waits().length, 0);
});

test('a worker that reports a passed smoke without a device, or on another one, is not believed', async t => {
  const s = setupBuild(t);
  await s.toBuilding();
  await s.finish(repo => {
    coded(repo);
    smoked(repo);
  });
  assert.equal(s.spec().state, 'parked');
  assert.match(s.spec().data.parked.reason, /khi chưa được cấp thiết bị/);
  const other = setupBuild(t);
  await other.toBuilding();
  await other.code();
  await other.smoke(SMOKE().replace(SERIAL, 'emulator-9999'));
  assert.equal(other.spec().state, 'parked');
  assert.match(other.spec().data.parked.reason, /không phải kết quả chạy thử trên emu-1/);
  assert.equal(other.devices.held.size, 0);
});

test('small errors left after the smoke rounds are sent along at the top, heavy ones hold the install (S05)', async t => {
  const s = setupBuild(t);
  await s.toBuilding();
  await s.toTrial({ smoke: SMOKE('fail', ERR('Vào nhầm màn kết quả')) });
  assert.ok(s.facade.review(s.id).trial.notes.includes('Lỗi nhỏ khi chạy thử: Vào nhầm màn kết quả'));
  const heavy = setupBuild(t);
  await heavy.toBuilding();
  await heavy.code();
  await heavy.smoke(SMOKE('fail', ERR('Nút học không phản hồi', 'java.lang.NullPointerException')));
  assert.equal(heavy.spec().state, 'parked');
  assert.match(heavy.spec().data.parked.reason, /lỗi nặng, không gửi bản cài: Nút học/);
  assert.deepEqual(heavy.would(), []);
});

test('a smoke report is read line by line', t => {
  const s = setupBuild(t);
  const repo = path.join(s.h.root, 'r');
  fs.mkdirSync(path.join(repo, '.learn-app', 'smoke'), { recursive: true });
  put(repo, { 'smoke/report.md': SMOKE('fail', `${ERR('App crash khi mở')}${ERR('Thiếu nút bắt buộc')}`) });
  assert.deepEqual(readSmoke(repo).errors.map(item => item.severe), [true, false]);
});

test('the screens are compared with Figma up to three rounds, then what is left is listed (S05)', async t => {
  const s = await toUi(t);
  for (const round of [1, 2, 3]) {
    await s.until(() => s.running('uidiff').length === 1);
    const { payload } = s.running('uidiff')[0];
    assert.deepEqual([payload.round, payload.screens, payload.serial], [round, [{ slug: 'home', deepLink: 'learnapp-debug://screen/home' }], SERIAL]);
    assert.equal(payload.notes.length, round === 1 ? 0 : 1);
    assert.equal(s.devices.held.size, 1);
    await ui(s, [screen('home', 80, 'fail', [{ text: `lệch ${round}`, severity: 'medium' }])]);
  }
  assert.deepEqual([s.spec().state, s.devices.held.size], ['reviewing', 0]);
  assert.deepEqual(s.spec().data.build.notes.ui, ['home (80/100): lệch 3']);
  assert.equal(s.decisions('spec-ui-left').length, 1);
});

test('screens that all match go straight to the review', async t => {
  const s = await toUi(t);
  await ui(s, [screen('home', 98, 'pass')]);
  assert.equal(s.spec().state, 'reviewing');
  assert.deepEqual(s.spec().data.build.notes.ui, []);
});

test('a compare without a readable result is tried once more and then parked', async t => {
  const s = await toUi(t);
  await ui(s, []);
  assert.equal(s.spec().state, 'uidiff');
  await ui(s, [screen('lạ', 98, 'pass')]);
  assert.equal(s.spec().state, 'parked');
  assert.equal(s.devices.held.size, 0);
  await s.cmd('retry', String(s.id));
  await ui(s, [screen('home', 98, 'pass')]);
  assert.equal(s.spec().state, 'reviewing');
});

test('a smoke worker that is parked gives its device back and retry takes it again', async t => {
  const s = setupBuild(t);
  await s.toBuilding();
  await s.code();
  const denied = { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'x', permission_denials: [{ tool_name: 'Bash', tool_input: { command: 'emulator -avd x' } }] };
  await s.finish(null, { event: denied });
  assert.equal(s.spec().state, 'parked');
  assert.equal(s.devices.held.size, 0);
  await s.cmd('retry', String(s.id));
  await s.until(() => s.running('spec').length === 1);
  assert.equal(s.devices.held.size, 1);
  await s.smoke();
  assert.equal(s.spec().state, 'reviewing');
});
