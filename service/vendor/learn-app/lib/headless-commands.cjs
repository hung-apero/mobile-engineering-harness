const S = require('./learn-app-state.cjs');
const H = require('./headless.cjs');
const { fixableBeforeBlock } = require('./headless-fixable.cjs');
const { git, fail, print, option } = require('./cli-io.cjs');

const PO_COMMANDS = ['approve', 'accept', 'allow', 'discord-wait', 'discord-say'];

function requireHeadless() {
  if (!H.isHeadless()) fail('Lệnh này chỉ dùng khi chạy không người (LEARN_APP_HEADLESS=1)');
}

function rootOf(cwd) {
  return S.findAppRoot(cwd) || git(cwd, ['rev-parse', '--show-toplevel']);
}

function stateOf(root) {
  return S.findAppRoot(root) === root ? S.readState(root) : null;
}

function headlessStart(cwd) {
  requireHeadless();
  const root = rootOf(cwd);
  H.clearBlocked(root);
  const state = stateOf(root);
  const problems = H.configProblems(root);
  if (problems.length) {
    H.writeBlocked(root, { step: state ? state.step : 'spec', reason: `${H.CONFIG} chưa đủ để chạy`, missing: problems });
    fail(problems.join('\n'));
  }
  const { segment, app, case: caseKind, spec, figma, notes } = H.readConfig(root);
  const rework = H.reworkFiles(root);
  print({ root, segment, app, case: caseKind, spec, figma, notes: notes || null, ...(rework.length ? { rework } : {}), step: state ? state.step : null, stop: state ? H.segmentStop(root, state) : segment === 'ask' ? null : `chưa có lần làm nào để chạy đoạn ${segment}` });
}

function headlessBlock(cwd) {
  requireHeadless();
  const reason = option('reason');
  if (!reason) fail('Cần --reason: vì sao phải có người');
  const root = rootOf(cwd);
  const state = stateOf(root);
  const fixable = state ? fixableBeforeBlock(root, state) : [];
  if (fixable.length) fail(`Còn việc tự sửa được ở bước ${state.step}, sửa xong rồi mới báo cần người:\n${fixable.join('\n')}`);
  const missing = (option('missing') || '').split(';').map(m => m.trim()).filter(Boolean);
  print(H.writeBlocked(root, { step: state ? state.step : 'spec', reason, missing }));
}

function guardCommand(root, command) {
  if (process.argv.includes('--by-service') && (H.isHeadless() || !H.readConfig(root))) fail('--by-service chỉ dành cho service, worker và lần chạy có người không dùng được');
  if (!H.isHeadless()) return;
  if (PO_COMMANDS.includes(command) || (command === 'decide' && process.argv.includes('--quote'))) fail(`Đang chạy không người (LEARN_APP_HEADLESS=1): ${command} ghi lời PO nên chỉ service được chạy. Cần người thì chạy headless-block --reason "…" rồi dừng.`);
  const state = S.readState(root);
  if (command === 'next') {
    const stop = H.segmentStop(root, state);
    if (stop) fail(`Đang chạy không người: ${stop} — dừng ở đây.`);
  }
  if (command === 'back' && H.reopensApprovedGate(state, option('to'), process.argv.includes('--self'))) fail('Đang chạy không người: quay lui này mở lại cổng PO đã duyệt. Chạy headless-block --reason "…" rồi dừng.');
}

module.exports = { headlessStart, headlessBlock, guardCommand };
