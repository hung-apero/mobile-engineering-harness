const fs = require('node:fs');
const path = require('node:path');
const { firstLine } = require('../redact.cjs');
const { lastResultText, readTail } = require('../bugs/result-log.cjs');
const { expectedCases, CASE_ID } = require('./expected.cjs');
const { readJournal, upgraded } = require('./journal.cjs');
const { fail, requireObject, requireList, oneOf, textOf, optional, parseJson, lastJsonBlock, attempt } = require('../bugs/result-fields.cjs');

const STATUSES = ['done', 'blocked'];
const UPGRADES = ['pass', 'fail', 'blocked', 'none'];
const CASE_STATUSES = ['pass', 'fail', 'cannot_execute', 'skip', 'out_of_date_spec'];
const REPORT_MAX = 8 * 1024 * 1024;
const MAX_CASES = 5000;
const text = { type: 'string', maxLength: 2000 };
const object = properties => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });

const E2E_SCHEMA = object({
  status: { type: 'string', enum: STATUSES },
  round: { type: 'integer', minimum: 0, maximum: 9999 },
  reason: text,
  upgrade: object({ status: { type: 'string', enum: UPGRADES }, reason: text }),
});

const free = value => optional(value, item => textOf(String(item).slice(0, 2000), 'text'));

function parseWorker(input) {
  return attempt(() => {
    const raw = typeof input === 'string' ? lastJsonBlock(input) ?? parseJson(input) : input;
    const doc = requireObject(raw, ['status', 'round', 'reason', 'upgrade'], 'JSON');
    const up = requireObject(doc.upgrade, ['status', 'reason'], 'upgrade');
    if (!Number.isInteger(doc.round) || doc.round < 0) fail('round phải là số nguyên');
    return {
      status: oneOf(doc.status, STATUSES, 'status'), round: doc.round, reason: free(doc.reason),
      upgrade: { status: oneOf(up.status, UPGRADES, 'upgrade.status'), reason: free(up.reason) },
    };
  });
}

function readCase(value) {
  if (value === null || typeof value !== 'object') fail('case phải là object');
  if (typeof value.id !== 'string' || !CASE_ID.test(value.id)) fail('case.id không hợp lệ');
  return {
    id: value.id, status: oneOf(value.status, CASE_STATUSES, `${value.id}: status`),
    reason: free(value.reason), expect: free(value.expect), triage: typeof value.triage?.class === 'string' ? value.triage.class : null,
  };
}

function readReport({ root, round, since }) {
  const file = path.join(root, '.android-app', 'rounds', String(round), 'report.json');
  return attempt(() => {
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!stat?.isFile() || fs.realpathSync(file) !== file) fail('không có report.json của vòng');
    if (stat.mtimeMs < since) fail('report.json có từ trước lần chạy này');
    if (stat.size > REPORT_MAX) fail('report.json quá lớn');
    const doc = parseJson(readTail(file, REPORT_MAX).data.toString('utf8'));
    const cases = requireList(doc?.scenarios, 'scenarios').flatMap(s => requireList(s?.cases, 'cases')).map(readCase);
    if (cases.length === 0 || cases.length > MAX_CASES) fail('report.json không có test case hợp lệ');
    return { cases };
  });
}

const bug = item => item.status === 'fail' && (item.triage === null || item.triage === 'app_bug');

function missingCases(root, cases) {
  const judged = new Set(cases.map(item => item.id));
  try {
    return { missing: expectedCases(root).filter(id => !judged.has(id)) };
  } catch (error) {
    return { missing: [], error: firstLine(error) };
  }
}

function outcomeOf(worker, cases, storeApk, verified = true) {
  const failures = cases.filter(bug).map(({ id, reason, expect }) => ({ id, reason, expect }));
  const incomplete = cases.filter(item => item.status !== 'pass' && !bug(item)).map(item => item.id);
  const { status, reason } = worker.upgrade;
  if (storeApk && status === 'fail') failures.push({ id: 'NANG-CAP', reason, expect: 'Nâng cấp từ bản store giữ dữ liệu và mở được app' });
  if (storeApk && status !== 'fail' && !(status === 'pass' && verified)) incomplete.push('NANG-CAP');
  const clean = failures.length === 0 && incomplete.length === 0;
  return { status: clean ? 'pass' : 'fail', failures, incomplete, total: cases.length };
}

function judgeE2e(job, { now } = {}) {
  const blocked = reason => ({ status: 'blocked', reason });
  if (job.state !== 'done') return blocked(job.parkReason ?? job.result?.error ?? 'việc E2E không có kết quả');
  const last = lastResultText(job.logFile);
  if (!last) return blocked('log E2E không có kết quả');
  const worker = parseWorker(last.structuredOutput ?? last.text);
  if (!worker.ok) return blocked(`kết quả E2E không đọc được: ${worker.error}`);
  if (worker.status === 'blocked') return blocked(worker.reason ?? 'harness không chạy được');
  const report = readReport({ root: job.payload.root, round: worker.round, since: job.startedAt ?? now ?? 0 });
  if (!report.ok) return blocked(report.error);
  const { root, storeApk, apk } = job.payload;
  const listed = missingCases(root, report.cases);
  if (listed.error) return blocked(listed.error);
  if (listed.missing.length) return blocked(`${listed.missing.length} test case chưa có kết quả: ${listed.missing.slice(0, 10).join(', ')}`);
  return outcomeOf(worker, report.cases, storeApk, upgraded(readJournal(root), { storeApk, apk }));
}

module.exports = { judgeE2e, parseWorker, readReport, outcomeOf, E2E_SCHEMA };
