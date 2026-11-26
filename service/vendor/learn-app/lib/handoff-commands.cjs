const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const S = require('./learn-app-state.cjs');
const { readRequests } = require('./sdk-requests.cjs');
const { git, fail, print, option } = require('./cli-io.cjs');
const { readVerdict, reviewKeys } = require('./verdicts.cjs');
const { specVersions, read } = require('./looper-parse.cjs');
const { mockSection } = require('./mock-be-planning.cjs');
const { autoDecisionLines, writeAutoDecisions } = require('./auto-decisions-log.cjs');
const { isHeadless } = require('./headless.cjs');
const { checkStep } = require('./looper-checks.cjs');

function defaultBranch(root) {
  try {
    return git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).replace(/^origin\//, '');
  } catch {
    return null;
  }
}

function reviewNotes(root) {
  const notes = reviewKeys(root).flatMap(key => ((readVerdict(root, key) || {}).reasons || [])
    .filter(reason => /^nên sửa/i.test(reason))
    .map(reason => `- \`${key.slice('review:'.length)}\` ${reason.replace(/^nên sửa:?\s*/i, '')}`));
  return notes.length ? notes : ['- (không có)'];
}

function requestLines(root) {
  const requests = readRequests(root);
  return requests.length ? requests.map(r => `- **${r.feature}** — cần ${r.need} · app vẽ thay ở \`${r.where}\``) : ['- (không có)'];
}

function mockBeLines(root) {
  if (!fs.existsSync(path.join(root, 'mock-be', 'contract.json'))) return [];
  const versions = specVersions(root);
  const section = versions.length ? mockSection(read(root, `inputs/spec-v${versions[versions.length - 1]}.md`)) : null;
  const consent = section && (section.match(/^- PO đồng ý.*$/m) || [])[0];
  return [
    '',
    '## Chạy với dữ liệu mẫu (tạm — bỏ khi có hệ thống thật)',
    consent || '- PO đồng ý: (không tìm thấy trong spec đã làm rõ)',
    '- `node mock-be/server.cjs`',
    '- `adb reverse tcp:8787 tcp:8787`',
    '- `./gradlew assembleDevDebug -PmockBe` (không có cờ → CMS/API thật; bản release không bao giờ trỏ mock)',
    '',
    '## Hợp đồng API cho BE',
    '- `mock-be/contract.json` — route + file dữ liệu mẫu; schema đầy đủ ở `.learn-app/api-contract.json`.',
  ];
}

function prBody(root, state) {
  const approvals = fs.readFileSync(path.join(root, S.DIR, 'gates', 'approvals.md'), 'utf8').replace(/^# .*\n/, '').trim();
  const features = state.features.map(f => `- \`${f.id}\` · ${f.source === 'store' ? 'Feature Store' : 'app tự viết'} · ${f.status}${(f.gaps || []).length ? ` · thiếu tài liệu: ${f.gaps.join('; ')}` : ''}`);
  const waiting = ((state.gates || {}).g3 || {}).status === 'pending';
  const gates = waiting ? 'PO đã duyệt spec đã làm rõ, bản cài đang chờ PO thử' : 'đã qua 2 cổng PO duyệt (spec đã làm rõ, code sẵn sàng bàn giao)';
  return [
    `App ${state.app} lắp bằng learn-app, ${gates}.`,
    '',
    '## Feature',
    ...(features.length ? features : ['- (không có)']),
    '',
    '## PO đã duyệt',
    approvals,
    '',
    '## Reviewer ghi "nên sửa"',
    ...reviewNotes(root),
    '',
    '## Cần dev SDK mở thêm (app đang tự vẽ thay)',
    ...requestLines(root),
    '',
    `## Trợ lý tự quyết sau cổng 1 (${waiting ? 'PO chưa xác nhận' : 'PO đã xem ở cổng 3'})`,
    ...autoDecisionLines(root, state),
    ...mockBeLines(root),
    '',
    '## Dev cần làm',
    '- Review code, đặc biệt phần app tự viết và phần nối.',
    '- Chạy test riêng bằng plugin android-test-harness trước khi merge.',
  ].join('\n');
}

function refuseMockWithoutConsent(root) {
  if (mockBeLines(root).some(line => line.includes('không tìm thấy'))) fail('Chưa bàn giao được: app có mock-be/ mà spec đã làm rõ không có PO đồng ý dùng dữ liệu mẫu — bỏ mock-be/ hoặc hỏi PO.');
}

function integrationBranch(root) {
  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!branch.startsWith('learn-app/')) fail(`Chỉ bàn giao từ branch learn-app/*, đang ở ${branch}`);
  return branch;
}

function baseBranch(root, state) {
  const base = option('base') || state.baseBranch || defaultBranch(root);
  if (!base) fail('Không biết mở PR vào branch nào. Chạy lại với --base <branch>, ví dụ --base develop.');
  return base;
}

const prTitle = state => `learn-app: ${state.app} — sẵn sàng cho dev review`;

function prepareHandoff(root, state) {
  if (state.step !== 'handoff') fail(`Chưa bàn giao được: đang ở bước ${state.step}.`);
  const missing = checkStep(root, state, 'handoff');
  if (missing.length) fail(`Chưa bàn giao được: ${missing.join('; ')}`);
  refuseMockWithoutConsent(root);
  const branch = integrationBranch(root);
  if (git(root, ['status', '--porcelain', '--', '.', `:(exclude)${S.DIR}`])) fail('Còn thay đổi chưa lưu — commit trước khi bàn giao.');
  const base = baseBranch(root, state);
  writeAutoDecisions(root);
  const prepared = { branch, base, commit: git(root, ['rev-parse', 'HEAD']), title: prTitle(state) };
  recordHandoff(root, { prepared });
  print({ ...prepared, body: prBody(root, state), pr: null, created: false, headless: true });
}

function handoff(root) {
  const state = S.readState(root);
  if (isHeadless()) {
    prepareHandoff(root, state);
    return;
  }
  if (state.gates.g3.status !== 'approved') fail('Chưa bàn giao được: cổng 3 chưa được PO duyệt.');
  refuseMockWithoutConsent(root);
  const branch = integrationBranch(root);
  if (git(root, ['status', '--porcelain'])) fail('Còn thay đổi chưa lưu — commit trước khi bàn giao.');
  const base = baseBranch(root, state);
  git(root, ['push', '-q', '-u', 'origin', branch]);
  const gh = process.env.LEARN_APP_GH || 'gh';
  const existing = spawnSync(gh, ['pr', 'view', branch, '--json', 'url', '-q', '.url'], { cwd: root, encoding: 'utf8' });
  if (existing.status === 0 && existing.stdout.trim()) {
    recordHandoff(root, { pr: existing.stdout.trim(), base });
    print({ branch, base, pr: existing.stdout.trim(), created: false, catalog: require('./catalog-pr.cjs').openCatalogPr(root, { appPr: existing.stdout.trim() }) });
    return;
  }
  writeAutoDecisions(root);
  const bodyFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'learn-app-pr-')), 'body.md');
  fs.writeFileSync(bodyFile, prBody(root, state));
  const created = spawnSync(gh, ['pr', 'create', '--base', base, '--head', branch, '--title', prTitle(state), '--body-file', bodyFile], { cwd: root, encoding: 'utf8' });
  if (created.status !== 0) fail(`Đã đẩy branch ${branch} nhưng chưa mở được PR: ${(created.stderr || created.stdout).trim().split('\n')[0]}. Kiểm tra gh auth status rồi chạy lại handoff.`);
  const pr = created.stdout.trim().split('\n').pop();
  recordHandoff(root, { pr, base });
  print({ branch, base, pr, created: true, catalog: require('./catalog-pr.cjs').openCatalogPr(root, { appPr: pr }) });
}

function handoffFile(root) {
  return path.join(root, S.DIR, 'handoff.json');
}

function readHandoff(root) {
  return fs.existsSync(handoffFile(root)) ? JSON.parse(fs.readFileSync(handoffFile(root), 'utf8')) : {};
}

function recordHandoff(root, fields) {
  S.writeJsonAtomic(handoffFile(root), { ...readHandoff(root), ...fields, at: new Date().toISOString() });
}

module.exports = { prBody, handoff };
