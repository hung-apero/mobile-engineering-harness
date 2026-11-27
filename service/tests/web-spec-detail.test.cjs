const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const specs = require('../src/specs/store.cjs');
const jobs = require('../src/jobs.cjs');
const tokens = require('../src/board/tokens.cjs');
const { record } = require('../src/decisions.cjs');
const { createWeb } = require('../src/web/server.cjs');
const { makeHome, NOW } = require('./service-fixtures.cjs');
const { send } = require('./web-fixtures.cjs');

async function detailWorld(t) {
  const h = makeHome(t, ['ABC1', 'XYZ2']);
  const ctx = h.context();
  const { db } = ctx;
  const repo = files => {
    const dir = fs.mkdtempSync(path.join(h.root, 'repo-'));
    fs.mkdirSync(path.join(dir, '.harness-run'));
    for (const [name, value] of Object.entries(files)) fs.writeFileSync(path.join(dir, '.harness-run', name), JSON.stringify(value));
    return dir;
  };
  const spec = (project, state, data = {}) => {
    const { id } = specs.createSpec(db, { project, title: 'Phase 15', source: {} }, NOW);
    db.prepare('UPDATE specs SET state = ?, data = ? WHERE id = ?').run(state, JSON.stringify(data), id);
    return id;
  };
  const web = createWeb(ctx, { facade: ctx.facade, port: 0, now: () => NOW });
  const { url } = await web.start();
  t.after(() => web.stop());
  const port = Number(new URL(url).port);
  const get = (target, headers = {}) => send(port, { url: target, headers });
  const login = async () => {
    const key = fs.readFileSync(path.join(ctx.secretsDir ?? path.join(ctx.dzHome, 'secrets'), 'web-operator-token'), 'utf8').trim();
    const cookie = (await get(`/?k=${key}`)).headers['set-cookie'][0].split(';')[0];
    return { cookie };
  };
  return { ctx, db, repo, spec, get, login, viewer: keys => tokens.issueViewer(db, { keys }, NOW).token };
}

test('detail page renders the five sections', async t => {
  const s = await detailWorld(t);
  const repo = s.repo({
    'progress.json': { plans: [{ id: '1', title: 'deps CLP', status: 'done' }] },
    'result.json': { branch: 'dz/spec-1', issues: [{ title: 'Điểm Accuracy chưa đúng', status: 'open', blocksMerge: true, owner: 'sdk', detail: 'SpeakingResult chỉ có correct/total' }] },
  });
  const id = s.spec('ABC1', 'uidiff', { repo, build: { version: '1.10.0', notes: { ui: ['b0-man-chao (90/100): khớp'] } } });
  record(s.db, { project: 'ABC1', code: 'S05', ruleVersion: 'r', evidence: { specId: id, round: 1, left: ['b0-man-chao:35'] }, action: 'spec-ui-round' }, NOW - 1000);
  record(s.db, { project: 'ABC1', code: 'S05', ruleVersion: 'r', evidence: { specId: id, round: 2, left: ['b0-man-chao:90'] }, action: 'spec-ui-round' }, NOW);
  const { id: jobId } = jobs.enqueue(s.db, { project: 'ABC1', kind: 'uidiff', key: `${id}#uidiff-1`, priority: 1, slots: 1, payload: {} }, NOW);
  s.db.prepare("UPDATE jobs SET state = 'done', result = ? WHERE id = ?").run(JSON.stringify({ costUsd: 2.5, turns: 30 }), jobId);
  const res = await s.get(`/board/${s.viewer([])}/ABC1/spec/${id}`);
  assert.equal(res.status, 200);
  for (const part of ['Tóm tắt', 'Tiến trình', 'Vấn đề', 'Giao diện', 'Kỹ thuật', '<details', 'Điểm Accuracy chưa đúng', 'Chặn merge', '1.10.0', 'deps CLP', '2.5 USD', 'khớp']) assert.ok(res.text.includes(part), part);
  assert.match(res.text, /<td>35<\/td><td>90<\/td>/);
  assert.match(res.text, /<meta http-equiv="refresh" content="60">/);
});

test('viewer of another project, or an unknown spec, gets 404', async t => {
  const s = await detailWorld(t);
  const id = s.spec('XYZ2', 'uidiff');
  assert.equal((await s.get(`/board/${s.viewer(['ABC1'])}/XYZ2/spec/${id}`)).status, 404);
  assert.equal((await s.get(`/board/${s.viewer([])}/ABC1/spec/${id}`)).status, 404);
  assert.equal((await s.get(`/board/${s.viewer([])}/ABC1/spec/999`)).status, 404);
  assert.equal((await s.get(`/board/nope/XYZ2/spec/${id}`)).status, 404);
  assert.equal((await s.get(`/board/${s.viewer(['XYZ2'])}/XYZ2/spec/${id}`)).status, 200);
});

test('job buttons show only with the operator cookie', async t => {
  const s = await detailWorld(t);
  const id = s.spec('ABC1', 'uidiff');
  const { id: jobId } = jobs.enqueue(s.db, { project: 'ABC1', kind: 'uidiff', key: `${id}#uidiff-1`, priority: 1, slots: 1, payload: {} }, NOW);
  s.db.prepare("UPDATE jobs SET state = 'running', started_at = ? WHERE id = ?").run(NOW, jobId);
  const target = `/board/${s.viewer([])}/ABC1/spec/${id}`;
  const plain = (await s.get(target)).text;
  assert.doesNotMatch(plain, /data-job-action/);
  assert.match(plain, new RegExp(`data-log="/board/[\\w-]+/ABC1/job/${jobId}/log"`));
  assert.match(plain, /<script type="module" src="\/static\/job-log\.js">/);
  assert.match((await s.get(target, await s.login())).text, /data-job-action="pause"/);
});

test('text is redacted', async t => {
  const s = await detailWorld(t);
  const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
  const repo = s.repo({ 'result.json': { issues: [{ title: `lộ ${secret}`, status: 'open', blocksMerge: false, owner: 'dev', detail: secret }] } });
  const id = s.spec('ABC1', 'reviewing', { repo });
  const res = await s.get(`/board/${s.viewer([])}/ABC1/spec/${id}`);
  assert.equal(res.status, 200);
  assert.ok(!res.text.includes(secret));
});

test('buttons only offer actions the api accepts', async t => {
  const s = await detailWorld(t);
  const login = await s.login();
  const make = (specState, jobState, parked) => {
    const id = s.spec('ABC1', specState, parked ? { parked } : {});
    const { id: jobId } = jobs.enqueue(s.db, { project: 'ABC1', kind: 'spec', key: `${id}#build-1`, priority: 1, slots: 1, payload: {} }, NOW);
    s.db.prepare('UPDATE jobs SET state = ? WHERE id = ?').run(jobState, jobId);
    if (parked) s.db.prepare('UPDATE specs SET data = ? WHERE id = ?').run(JSON.stringify({ parked: { ...parked, jobId } }), id);
    return id;
  };
  const page = async id => (await s.get(`/board/${s.viewer([])}/ABC1/spec/${id}`, login)).text;
  assert.doesNotMatch(await page(make('building', 'queued')), /data-job-action/);
  assert.doesNotMatch(await page(make('building', 'failed')), /data-job-action/);
  assert.doesNotMatch(await page(make('parked', 'parked', null)), /data-job-action/);
  assert.match(await page(make('parked', 'parked', { reason: 'tạm dừng từ board', from: 'building', mode: 'pause' })), /data-job-action="start"/);
});
