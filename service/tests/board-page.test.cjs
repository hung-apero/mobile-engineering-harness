const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const kv = require('../src/kv.cjs');
const specs = require('../src/specs/store.cjs');
const bugsStore = require('../src/bugs/store.cjs');
const polling = require('../src/bugs/polling.cjs');
const board = require('../src/board/store.cjs');
const tokens = require('../src/board/tokens.cjs');
const { openWait } = require('../src/pings.cjs');
const { record } = require('../src/decisions.cjs');
const { boardModel } = require('../src/board/model.cjs');
const { createWeb } = require('../src/web/server.cjs');
const { makeHome, NOW } = require('./service-fixtures.cjs');
const { send } = require('./web-fixtures.cjs');

const DAY = 24 * 60 * 60 * 1000;
const at = text => Date.parse(`${text}+07:00`);
const bad = i => `bad${String(i).padStart(40, '0')}`;

function world(t) {
  const h = makeHome(t, ['ABC1', 'XYZ2']);
  const ctx = h.context();
  const { db } = ctx;
  const spec = (project, title, state, data = {}, updatedAt = NOW) => {
    const { id } = specs.createSpec(db, { project, title, source: {} }, NOW);
    db.prepare('UPDATE specs SET state = ?, data = ?, updated_at = ? WHERE id = ?').run(state, JSON.stringify(data), updatedAt, id);
    return id;
  };
  const wait = (id, project, role, link = null) => kv.set(db, `spec-wait:${id}:w`, openWait(db, { project, role, subject: `spec ${id}`, link }, NOW), NOW);
  const repo = plans => {
    const dir = fs.mkdtempSync(path.join(h.root, 'repo-'));
    fs.mkdirSync(path.join(dir, '.harness-run'));
    fs.writeFileSync(path.join(dir, '.harness-run', 'progress.json'), JSON.stringify({ plans }));
    return dir;
  };
  const track = (project, version) => {
    bugsStore.ensureVersion(db, { project, version, now: NOW });
    polling.setPolling(db, project, version, true, NOW);
  };
  const ticket = (project, key, state, updatedAt) => db.prepare("INSERT INTO tickets (project, key, version, priority, state, fingerprint, updated_at) VALUES (?, ?, '1.9.2', 1, ?, 'f', ?)").run(project, key, state, updatedAt);
  const batch = (project, state, updatedAt, data = {}, keys = []) => db.prepare("INSERT INTO batches (project, version, kind, state, keys, data, opened_at, updated_at) VALUES (?, '1.0.0', 'normal', ?, ?, ?, ?, ?)").run(project, state, JSON.stringify(keys), JSON.stringify(data), updatedAt, updatedAt);
  const decide = (project, action, when) => record(db, { project, code: 'X', ruleVersion: 'r', evidence: {}, action }, when);
  const model = (keys = []) => boardModel(ctx, { keys }, NOW);
  const of = (key, keys) => model(keys).projects.find(item => item.key === key);
  return { h, ctx, db, spec, wait, repo, track, ticket, batch, decide, model, of };
}

async function serve(t, s) {
  const web = createWeb(s.ctx, { facade: s.ctx.facade, port: 0, now: () => NOW });
  const { url } = await web.start();
  t.after(() => web.stop());
  const port = Number(new URL(url).port);
  return {
    get: (target, extra = {}) => send(port, { url: target, ...extra }),
    post: (target, extra = {}) => send(port, { method: 'POST', url: target, body: '{}', ...extra, headers: { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' } }),
  };
}

test('the board shows each spec step and who it waits for', t => {
  const s = world(t);
  s.wait(s.spec('ABC1', 'Màn path', 'quiz'), 'ABC1', 'po', 'http://x/quiz/abc');
  s.wait(s.spec('ABC1', 'Màn quiz', 'review'), 'ABC1', 'po');
  s.wait(s.spec('ABC1', 'Màn hồ sơ', 'parked'), 'ABC1', 'dev');
  s.spec('ABC1', 'Đã xong', 'done', {}, NOW - DAY);
  s.spec('ABC1', 'Đã gộp khô', 'landed-dry', {}, NOW - DAY);
  s.spec('ABC1', 'Bỏ', 'cancelled');
  assert.deepEqual(s.of('ABC1').specs.map(item => [item.title, item.state, item.label, item.waitingFor]), [
    ['Màn path', 'quiz', 'Chờ PO trả lời', 'PO'], ['Màn quiz', 'review', 'Chờ PO duyệt', 'PO'], ['Màn hồ sơ', 'parked', 'Tạm gác', 'dev'],
  ]);
});

test('each active spec lists only the products of the steps it went through', async t => {
  const s = world(t);
  const questions = [{ id: 'Q1', mode: 'ask' }, { id: 'Q2', mode: 'ask' }, { id: 'Q3', mode: 'auto' }];
  const answered = { Q1: { kind: 'po' }, Q3: { kind: 'agent' } };
  const references = [{ kind: 'kb' }, { kind: 'linked' }];
  s.spec('ABC1', 'Mới nhận', 'reading');
  s.spec('ABC1', '', 'needs-input', { needs: { kind: 'figma', role: 'po', reason: 'spec không có link Figma' } });
  s.spec('ABC1', 'Gác', 'parked', { parked: { reason: 'đoạn clarify dừng giữa chừng 2 lần' } });
  s.spec('ABC1', 'Đang hỏi', 'quiz', { questions, answered });
  s.spec('ABC1', 'Chờ duyệt', 'review', { questions, answered, references, reviewVersion: 2 });
  s.spec('ABC1', 'Đã duyệt', 'approved', { questions, answered, reviewVersion: 1, approvedAt: at('2026-11-25T19:02:00') });
  s.spec('ABC1', 'Đang thử', 'po-trial', {
    reviewVersion: 1, approvedAt: at('2026-11-24T09:30:00'), repo: s.repo([{ status: 'done' }, { status: 'done' }]),
    build: { version: '1.9.2', candidate: { sha: 'a'.repeat(40), n: 2 }, trial: { at: at('2026-11-25T18:40:00') } },
  });
  assert.deepEqual(s.of('ABC1').specs.map(item => [item.title, item.products]), [
    ['Mới nhận', []],
    ['Spec #2', ['Cần bổ sung: spec không có link Figma']],
    ['Gác', ['Tạm gác: đoạn clarify dừng giữa chừng 2 lần']],
    ['Đang hỏi', ['3 câu hỏi: PO trả lời 1, còn 1 câu chờ PO, agent tự chốt 1']],
    ['Chờ duyệt', ['3 câu hỏi: PO trả lời 1, PO bỏ qua 1 câu không bắt buộc, agent tự chốt 1', '2 tài liệu tham chiếu', 'Spec làm rõ v2 chờ PO duyệt']],
    ['Đã duyệt', ['3 câu hỏi: PO trả lời 1, PO bỏ qua 1 câu không bắt buộc, agent tự chốt 1', 'Spec làm rõ v1 PO duyệt lúc 19:02']],
    ['Đang thử', ['Spec làm rõ v1 PO duyệt lúc 09:30 ngày 24/11', 'Code cho bản 1.9.2: 2/2 plan xong', 'Bản cài #2 gửi PO lúc 18:40']],
  ]);
  const { token } = tokens.issueViewer(s.db, { keys: [] }, NOW);
  const text = (await (await serve(t, s)).get(`/board/${token}/ABC1`)).text;
  assert.match(text, /Spec làm rõ v1 PO duyệt lúc 19:02/);
  assert.match(text, /Bản cài #2 gửi PO lúc 18:40/);
});

test('a building spec shows done over total plans from progress.json', async t => {
  const s = world(t);
  s.spec('ABC1', 'Màn A', 'building', { repo: s.repo([{ id: '01', status: 'done' }, { id: '02', status: 'running' }, { id: '03' }]) });
  s.spec('ABC1', 'Màn B', 'quiz', { repo: s.repo([{ status: 'done' }]) });
  s.spec('ABC1', 'Màn C', 'building', { repo: path.join(s.h.root, 'missing') });
  assert.deepEqual(s.of('ABC1').specs.map(item => item.products), [['Code: 1/3 plan xong'], [], []]);
  const { token } = tokens.issueViewer(s.db, { keys: [] }, NOW);
  assert.match((await (await serve(t, s)).get(`/board/${token}/ABC1`)).text, /Code: 1\/3 plan xong/);
});

test('bugs are grouped by Jira status, sorted by priority, and loop bugs are marked', t => {
  const s = world(t);
  s.track('ABC1', '1.9.2');
  const row = (key, status, priority, updatedAt, assignee = null) => ({ key, summary: `bug ${key}`, status, priority, assignee, updatedAt });
  board.replaceBugs(s.db, {
    project: 'ABC1', version: '1.9.2', bugs: [
      row('ABC1-1', 'To Do', 'Low', '2026-11-25T10:00:00.000+0700'), row('ABC1-2', 'To Do', 'Highest', '2026-11-24T10:00:00.000+0700'),
      row('ABC1-3', 'To Do', 'Highest', '2026-11-25T09:00:00.000+0700'), row('ABC1-4', 'Done', 'Medium', '2026-11-25T09:00:00.000+0700', 'Lan'),
    ],
  }, NOW);
  s.ticket('ABC1', 'ABC1-2', 'batched', NOW);
  const [version] = s.of('ABC1').bugs;
  assert.equal(version.version, '1.9.2');
  assert.deepEqual(version.groups.map(group => [group.status, group.bugs.map(item => item.key)]), [['Done', ['ABC1-4']], ['To Do', ['ABC1-3', 'ABC1-2', 'ABC1-1']]]);
  assert.deepEqual(version.groups[1].bugs.map(item => item.loop), [false, true, false]);
  assert.equal(version.groups[0].bugs[0].assignee, 'Lan');
});

test('a key-scoped token sees only its projects, including waits, batches and activity', async t => {
  const s = world(t);
  for (const key of ['ABC1', 'XYZ2']) {
    s.wait(s.spec(key, `Spec ${key}`, 'review'), key, 'po');
    s.batch(key, 'running', NOW, { phase: 'fixing' }, [`${key}-9`]);
    s.decide(key, 'spec-approved', NOW);
  }
  assert.deepEqual(s.model(['XYZ2']).projects.map(item => item.key), ['XYZ2']);
  const xyz = s.of('XYZ2', ['XYZ2']);
  assert.deepEqual(xyz.specs.map(item => [item.title, item.waitingFor]), [['Spec XYZ2', 'PO']]);
  assert.deepEqual(xyz.batches.map(item => [item.version, item.state, item.phase, item.keys]), [['1.0.0', 'running', 'fixing', ['XYZ2-9']]]);
  assert.equal(xyz.activity.at(-1).approved, 1);
  const { token } = tokens.issueViewer(s.db, { keys: ['XYZ2'] }, NOW);
  const web = await serve(t, s);
  const list = await web.get(`/board/${token}`);
  assert.equal(list.status, 200);
  assert.match(list.text, /Spec XYZ2/);
  assert.doesNotMatch(list.text, /ABC1/);
  const detail = await web.get(`/board/${token}/XYZ2`);
  assert.equal(detail.status, 200);
  assert.match(detail.text, /Spec XYZ2/);
  assert.match(detail.text, /XYZ2-9/);
  assert.doesNotMatch(detail.text, /ABC1/);
  assert.equal((await web.get(`/board/${token}/ABC1`)).status, 404);
});

test('the board lists every project with its current status and a project opens its active phases', async t => {
  const s = world(t);
  s.wait(s.spec('ABC1', 'Phase 15 path', 'review', { reviewVersion: 1 }), 'ABC1', 'po');
  s.spec('ABC1', 'Phase 16 streak', 'building', { repo: s.repo([{ status: 'done' }, {}]) });
  s.spec('ABC1', 'Phase 9 cũ', 'done');
  s.track('ABC1', '1.9.2');
  board.replaceBugs(s.db, { project: 'ABC1', version: '1.9.2', bugs: [{ key: 'ABC1-1', summary: 'a', status: 'To Do', priority: 'High', assignee: null, updatedAt: '' }] }, NOW);
  const { token } = tokens.issueViewer(s.db, { keys: [] }, NOW);
  const web = await serve(t, s);
  const list = (await web.get(`/board/${token}`)).text;
  assert.match(list, new RegExp(`<a href="/board/${token}/ABC1">ABC1</a>`));
  assert.match(list, new RegExp(`<a href="/board/${token}/XYZ2">XYZ2</a>`));
  assert.match(list, /2 phase đang làm/);
  assert.match(list, /Phase 15 path · Chờ PO duyệt/);
  assert.match(list, /Phase 16 streak · Đang code/);
  assert.match(list, /1 bug bản 1\.9\.2/);
  assert.match(list, /Không có phase nào đang làm/);
  assert.doesNotMatch(list, /Phase 9 cũ|Spec làm rõ v1|7 ngày qua/);
  const detail = await web.get(`/board/${token}/ABC1`);
  assert.equal(detail.status, 200);
  assert.match(detail.text, /Phase 15 path/);
  assert.match(detail.text, /Spec làm rõ v1 chờ PO duyệt/);
  assert.match(detail.text, /Phase 16 streak/);
  assert.match(detail.text, /Code: 1\/2 plan xong/);
  assert.match(detail.text, /7 ngày qua/);
  assert.match(detail.text, new RegExp(`<a href="/board/${token}">`));
  assert.doesNotMatch(detail.text, /XYZ2/);
  assert.equal((await web.get(`/board/${token}/NOPE9`)).status, 404);
});

test('activity counts the last 7 days by Vietnam day', t => {
  const s = world(t);
  s.decide('ABC1', 'spec-approved', at('2026-11-25T06:00:00'));
  s.decide('ABC1', 'spec-approved', at('2026-11-24T23:30:00'));
  s.decide('ABC1', 'spec-coded', at('2026-11-19T00:30:00'));
  s.decide('ABC1', 'spec-coded', at('2026-11-18T23:30:00'));
  s.decide('ABC1', 'spec-trial-sent', NOW);
  s.decide('ABC1', 'spec-parked', NOW);
  s.decide('XYZ2', 'spec-approved', NOW);
  s.ticket('ABC1', 'ABC1-1', 'done', at('2026-11-25T01:00:00'));
  s.ticket('ABC1', 'ABC1-2', 'accepted', NOW);
  s.ticket('ABC1', 'ABC1-3', 'done', NOW - 8 * DAY);
  s.batch('ABC1', 'done', at('2026-11-20T12:00:00'));
  s.batch('ABC1', 'abandoned', NOW);
  const { activity } = s.of('ABC1');
  assert.deepEqual(activity.map(day => day.day), ['2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22', '2026-11-23', '2026-11-24', '2026-11-25']);
  assert.deepEqual(activity.map(day => [day.approved, day.coded, day.trial, day.bugs, day.batches]), [
    [0, 1, 0, 0, 0], [0, 0, 0, 0, 1], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [1, 0, 0, 0, 0], [1, 0, 1, 1, 0],
  ]);
});

test('the page refreshes every 60 seconds and has no form, button, script or quiz link', async t => {
  const s = world(t);
  s.wait(s.spec('ABC1', '<b>Màn</b>', 'quiz'), 'ABC1', 'po', `http://10.0.0.5:8788/quiz/${'q'.repeat(43)}`);
  s.wait(s.spec('ABC1', 'Màn duyệt', 'review'), 'ABC1', 'po', `http://10.0.0.5:8788/review/${'r'.repeat(43)}`);
  const { token } = tokens.issueViewer(s.db, { keys: [] }, NOW);
  const web = await serve(t, s);
  for (const url of [`/board/${token}`, `/board/${token}/ABC1`]) {
    const res = await web.get(url);
    assert.equal(res.status, 200, url);
    assert.match(res.text, /<meta http-equiv="refresh" content="60">/);
    assert.doesNotMatch(res.text, /<form|<button|<script|\/quiz\/|\/review\/|<b>/i);
    assert.match(res.text, /&lt;b&gt;Màn&lt;\/b&gt;/);
    assert.match(res.text, /Chờ PO duyệt/);
    assert.match(res.text, /Suất chạy/);
    assert.equal((await web.get(url, { method: 'HEAD' })).status, 200);
    assert.equal((await web.post(url)).status, 405);
  }
});

test('a sync error shows on the board with the last good time', async t => {
  const s = world(t);
  for (const version of ['1.9.2', '2.0.0', '2.1.0']) s.track('ABC1', version);
  board.saveSync(s.db, 'ABC1', '1.9.2', { at: NOW, ok: false, error: 'Jira 503', lastOkAt: at('2026-11-25T19:15:00') }, NOW);
  board.saveSync(s.db, 'ABC1', '2.0.0', { at: at('2026-11-25T19:45:00'), ok: true, count: 200, capped: true }, NOW);
  assert.deepEqual(s.of('ABC1').bugs.map(item => [item.version, item.sync]), [
    ['1.9.2', 'chưa đồng bộ được: Jira 503, lần cuối 19:15'], ['2.0.0', 'đồng bộ Jira lúc 19:45, còn nữa'], ['2.1.0', 'chưa đồng bộ lần nào'],
  ]);
  const { token } = tokens.issueViewer(s.db, { keys: [] }, NOW);
  assert.match((await (await serve(t, s)).get(`/board/${token}/ABC1`)).text, /chưa đồng bộ được: Jira 503, lần cuối 19:15/);
});

test('a viewer token cannot open home, quiz, review or any api route, and a bad token is 404 and rate limited', async t => {
  const s = world(t);
  const { token } = tokens.issueViewer(s.db, { keys: [] }, NOW);
  const expired = tokens.issueViewer(s.db, { keys: [], days: 1 }, NOW - 2 * DAY).token;
  const revoked = tokens.issueViewer(s.db, { keys: [] }, NOW);
  tokens.revokeViewer(s.db, revoked.id, NOW);
  const web = await serve(t, s);
  assert.equal((await web.get(`/board/${token}`)).status, 200);
  assert.equal((await web.get(`/?k=${token}`)).status, 403);
  for (const url of ['/spec/new', '/app/new', '/release/ABC1/1.0.0']) assert.equal((await web.get(url)).status, 403, url);
  for (const url of [`/quiz/${token}`, `/review/${token}`, `/api/quiz/${token}/state`, `/board/${expired}`, `/board/${revoked.token}`, `/board/${expired}/ABC1`]) assert.equal((await web.get(url)).status, 404, url);
  for (const url of [`/api/quiz/${token}/submit`, `/api/review/${token}/approve`]) assert.equal((await web.post(url)).status, 404, url);
  const statuses = [];
  for (let i = 0; i < 20; i += 1) statuses.push((await web.get(`/board/${bad(i)}`)).status);
  assert.equal(statuses[0], 404);
  assert.equal((await web.get(`/board/${bad(99)}`)).status, 429);
  assert.equal((await web.get(`/board/${token}`)).status, 200);
});

test('spec card shows steps, now line, issues and a detail link', async t => {
  const s = world(t);
  const repo = s.repo([{ status: 'done' }]);
  fs.writeFileSync(path.join(repo, '.harness-run', 'result.json'), JSON.stringify({ issues: [{ title: 'Accuracy sai', status: 'open', blocksMerge: true, owner: 'sdk', detail: 'd' }] }));
  const id = s.spec('ABC1', 'Phase 15', 'uidiff', { repo });
  s.wait(id, 'ABC1', 'po');
  const { token } = tokens.issueViewer(s.db, { keys: [] }, NOW);
  const text = (await (await serve(t, s)).get(`/board/${token}/ABC1`)).text;
  assert.match(text, /✓Code ✓Chạy thử ●So giao diện ○Kiểm code/);
  assert.match(text, /Đang chờ PO: spec \d+/);
  assert.match(text, /⚠ 1 vấn đề chặn merge/);
  assert.match(text, new RegExp(`href="/board/${token}/ABC1/spec/${id}"`));
});
