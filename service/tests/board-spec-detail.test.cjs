const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const kv = require('../src/kv.cjs');
const specs = require('../src/specs/store.cjs');
const jobs = require('../src/jobs.cjs');
const { openWait } = require('../src/pings.cjs');
const { record } = require('../src/decisions.cjs');
const { specDetail, specSummary } = require('../src/board/spec-detail.cjs');
const { makeHome, NOW } = require('./service-fixtures.cjs');

const MIN = 60 * 1000;

function world(t) {
  const h = makeHome(t, ['ABC1', 'XYZ2']);
  const ctx = h.context();
  const { db } = ctx;
  const spec = (state, data = {}, project = 'ABC1') => {
    const { id } = specs.createSpec(db, { project, title: 'Phase 15', source: {} }, NOW);
    db.prepare('UPDATE specs SET state = ?, data = ? WHERE id = ?').run(state, JSON.stringify(data), id);
    return id;
  };
  const decide = (id, action, at, evidence = {}) => record(db, { project: 'ABC1', code: 'S05', ruleVersion: 'r', evidence: { specId: id, ...evidence }, action }, at);
  const repo = files => {
    const dir = fs.mkdtempSync(path.join(h.root, 'repo-'));
    fs.mkdirSync(path.join(dir, '.harness-run'));
    for (const [name, value] of Object.entries(files)) fs.writeFileSync(path.join(dir, '.harness-run', name), typeof value === 'string' ? value : JSON.stringify(value));
    return dir;
  };
  const job = (id, kind, state, { startedAt = null, result = null } = {}) => {
    const { id: jobId } = jobs.enqueue(db, { project: 'ABC1', kind, key: `${id}#${kind}-${Math.random()}`, priority: 1, slots: 1, payload: {} }, NOW);
    db.prepare('UPDATE jobs SET state = ?, started_at = ?, result = ? WHERE id = ?').run(state, startedAt, result && JSON.stringify(result), jobId);
    return jobId;
  };
  const wait = (id, role, subject) => kv.set(db, `spec-wait:${id}:w`, openWait(db, { project: 'ABC1', role, subject }, NOW - 30 * MIN), NOW);
  const detail = (id, key = 'ABC1') => specDetail(ctx, key, id, NOW);
  return { db, spec, decide, repo, job, wait, detail };
}

test('steps follow the spec state and decision times', t => {
  const s = world(t);
  const id = s.spec('uidiff');
  s.decide(id, 'spec-quiz-opened', NOW - 50 * MIN);
  s.decide(id, 'spec-approved', NOW - 40 * MIN);
  s.decide(id, 'spec-coded', NOW - 30 * MIN);
  s.decide(id, 'spec-smoke-passed', NOW - 20 * MIN);
  for (const round of [1, 2, 3]) s.decide(id, 'spec-ui-round', NOW - (10 - round) * MIN, { round, left: ['b0:35'] });
  s.decide(id, 'spec-unknown-thing', NOW);
  const steps = s.detail(id).steps;
  assert.deepEqual(steps.map(step => step.status), ['done', 'done', 'done', 'done', 'done', 'done', 'done', 'current', 'todo', 'todo', 'todo', 'todo']);
  assert.deepEqual(steps.map(step => step.name), ['Đọc', 'Hỏi', 'PO trả lời', 'Làm rõ', 'Duyệt', 'Code', 'Chạy thử', 'So giao diện', 'Kiểm code', 'Bản cài', 'PO thử', 'Gộp']);
  assert.equal(steps[7].note, '3 vòng');
  assert.equal(steps[4].at, NOW - 40 * MIN);
  assert.match(specSummary(s.detail(id)).stepLine, /✓Code ✓Chạy thử ●So giao diện ○Kiểm code/);
});

test('waiting and running come from waits and jobs', t => {
  const s = world(t);
  const id = s.spec('po-trial');
  s.wait(id, 'po', 'Thử bản cài #3');
  s.job(id, 'uidiff', 'running', { startedAt: NOW - 12 * MIN });
  const detail = s.detail(id);
  assert.deepEqual([detail.waiting.role, detail.waiting.subject, detail.waiting.pings], ['PO', 'Thử bản cài #3', 0]);
  assert.equal(detail.running.kind, 'uidiff');
  assert.match(specSummary(detail).nowLine, /^Đang chờ PO: Thử bản cài #3/);
  s.db.prepare("UPDATE waits SET state = 'resolved'").run();
  assert.match(specSummary(s.detail(id)).nowLine, /^Đang chạy: so giao diện · 12 phút/);
});

test('issues prefer structured result.json issues', t => {
  const s = world(t);
  const issue = (status, blocksMerge) => ({ title: `Vấn đề ${status}`, status, blocksMerge, owner: 'sdk', detail: 'd' });
  const withIssues = s.spec('reviewing', { repo: s.repo({ 'result.json': { issues: [issue('open', true), issue('open', false), issue('fixed', false)], review: { findings: [{ message: 'x' }] } } }) });
  const issues = s.detail(withIssues).issues;
  assert.deepEqual([issues.source, issues.blocking.length, issues.open.length, issues.fixed.length], ['issues', 1, 1, 1]);
  assert.match(specSummary(s.detail(withIssues)).issueLine, /⚠ 1 vấn đề chặn merge · 1 còn mở/);
  const findings = s.spec('reviewing', { repo: s.repo({ 'result.json': { review: { findings: [{ severity: 'high', message: 'leak - chua sua' }] } } }) });
  assert.deepEqual([s.detail(findings).issues.source, s.detail(findings).issues.raw], ['findings', ['leak - chua sua']]);
  assert.equal(s.detail(s.spec('reviewing', { repo: s.repo({}) })).issues.source, 'none');
});

test('provisional lists PO-skipped questions with their proposal', t => {
  const s = world(t);
  const questions = [
    { id: 'Q1', blocking: true, mode: 'ask', options: [{ label: 'A', text: 'Có' }], proposal: { label: 'A' } },
    { id: 'Q14', blocking: false, mode: 'ask', options: [{ label: 'A', text: 'Trừ 15⚡ khi bấm' }, { label: 'B', text: 'Miễn phí' }], proposal: { label: 'A' } },
    { id: 'Q15', blocking: false, mode: 'ask', options: [{ label: 'A', text: 'x' }], proposal: { label: 'A' } },
    { id: 'Q20', blocking: false, mode: 'auto', options: [{ label: 'A', text: 'y' }], proposal: { label: 'A' } },
  ];
  const id = s.spec('reviewing', { questions, rounds: [{ round: 1, ask: ['Q1', 'Q14', 'Q15'], auto: ['Q20'] }], answered: { Q1: { kind: 'po' }, Q15: { kind: 'po' }, Q20: { kind: 'agent' } } });
  assert.deepEqual(s.detail(id).provisional, [{ id: 'Q14', label: 'A', text: 'Trừ 15⚡ khi bấm' }]);
  assert.match(specSummary(s.detail(id)).issueLine, /1 câu tạm theo đề xuất/);
});

test('ui table keeps the last 4 rounds per screen', t => {
  const s = world(t);
  const id = s.spec('uidiff', { build: { notes: { ui: ['b0-man-chao (50/100): Nút Continue lệch 8px', 'a3-card (90/100): khớp'] } } });
  const left = [['b0-man-chao:30', 'a3-card:60'], ['b0-man-chao:35', 'a3-card:82'], ['b0-man-chao:35', 'a3-card:88'], ['b0-man-chao:50', 'a3-card:90'], ['b0-man-chao:50']];
  left.forEach((items, i) => s.decide(id, 'spec-ui-round', NOW - (10 - i) * MIN, { round: i + 1, left: items }));
  const { ui } = s.detail(id);
  assert.deepEqual(ui.rounds, [2, 3, 4, 5]);
  assert.deepEqual(ui.screens, [
    { name: 'b0-man-chao', scores: [35, 35, 50, 50], last: 'Nút Continue lệch 8px' },
    { name: 'a3-card', scores: [82, 88, 90, 'ok'], last: 'khớp' },
  ]);
});

test('jobs sum their cost and plans come from progress.json', t => {
  const s = world(t);
  const id = s.spec('reviewing', { repo: s.repo({ 'progress.json': { plans: [{ id: '1', title: 'deps', status: 'done' }] } }) });
  s.job(id, 'spec', 'done', { result: { costUsd: 1.5, turns: 10 } });
  s.job(id, 'uidiff', 'done', { result: { costUsd: 2, turns: 20 } });
  const detail = s.detail(id);
  assert.equal(detail.totalUsd, 3.5);
  assert.deepEqual(detail.jobs.map(job => [job.kind, job.costUsd, job.turns]), [['uidiff', 2, 20], ['spec', 1.5, 10]]);
  assert.deepEqual(detail.plans, [{ id: '1', title: 'deps', status: 'done' }]);
});

test('bad json files do not throw', t => {
  const s = world(t);
  const id = s.spec('reviewing', { repo: s.repo({ 'progress.json': '{', 'result.json': '[' }) });
  const detail = s.detail(id);
  assert.deepEqual([detail.plans, detail.issues.source], [[], 'none']);
});

test("another project's spec or an unknown spec is null", t => {
  const s = world(t);
  const id = s.spec('reviewing', {}, 'XYZ2');
  assert.equal(s.detail(id, 'ABC1'), null);
  assert.equal(s.detail(9999, 'ABC1'), null);
  assert.notEqual(s.detail(id, 'XYZ2'), null);
});

test('a parked spec keeps showing the step it was parked from', t => {
  const s = world(t);
  const id = s.spec('parked', { parked: { reason: 'tạm dừng từ board', from: 'building', jobId: 1 } });
  s.decide(id, 'spec-approved', NOW - 10 * MIN);
  assert.equal(s.detail(id).steps.find(step => step.status === 'current').name, 'Code');
});
