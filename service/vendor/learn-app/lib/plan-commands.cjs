const S = require('./learn-app-state.cjs');
const { fail, print, option } = require('./cli-io.cjs');
const path = require('path');
const { readPlans } = require('./looper-parse.cjs');
const { verdictMissing } = require('./verdicts.cjs');
const { overlaps } = require('./plan-overlap.cjs');
const { uiPrecheck } = require('./ui-precheck.cjs');
const { check: mockBeCheck } = require('./mock-be-commands.cjs');
const { removeCheck } = require('./remove-check.cjs');

const SETTABLE = { coded: ['coding', 'coded', 'reviewed', 'conflict'], reviewed: ['coded', 'reviewed'] };

function codePath(root, code, file) {
  if (!file) return null;
  const given = file.replace(/\\/g, '/');
  const inWorktree = given.match(/(?:^|\/)\.learn-app\/wt\/[^/]+\/(.+)$/);
  if (inWorktree) return inWorktree[1];
  const abs = path.isAbsolute(given) ? given : path.join(code, given);
  const base = S.worktreeOf(abs) ? path.join(root, '.learn-app', 'wt', S.worktreeOf(abs)) : root;
  return path.relative(base, abs).split(path.sep).join('/');
}

function plan(root) {
  const id = option('id');
  const status = option('status');
  if (!id || !SETTABLE[status]) fail(`Cần --id và --status ${Object.keys(SETTABLE).join('|')}`);
  if (!readPlans(root).some(p => p.id === id)) fail(`Không có plan ${id} trong .learn-app/plans/`);
  const state = S.readState(root);
  if (state.step !== 'coding') fail(`Chỉ ghi trạng thái plan ở bước coding, đang ở ${state.step}`);
  const existing = state.plans[id] || {};
  const from = existing.status || 'todo';
  if (!SETTABLE[status].includes(from)) fail(`Plan ${id} đang ${from}, không chuyển sang ${status} được${from === 'todo' ? ' — chạy learn-app-state.cjs start-plans trước' : ''}`);
  if (status === 'reviewed' && option('files')) fail('Ghi file của plan ở bước coding (--status coded --files …); lúc ghi đã kiểm thì không thêm file');
  if (status === 'reviewed') {
    const unreviewed = verdictMissing(root, `review:${id}`, state);
    if (unreviewed.length) fail(`Code của plan ${id} ${unreviewed.join(' · ').replace(/ \(review:[^)]+\)/, '')} (agent plan-reviewer)`);
  }
  const code = S.codeRoot(root, state, id);
  const reported = option('files') ? option('files').split(',').map(f => codePath(root, code, f.trim())).filter(Boolean) : [];
  const files = [...new Set([...(existing.files || []), ...reported])];
  const planDef = readPlans(root).find(p => p.id === id) || {};
  const touches = planDef.touches;
  if (status === 'coded') {
    let label;
    let errors;
    if (planDef.kind === 'mock-be') {
      const mock = mockBeCheck(code);
      [label, errors] = ['mock-be.cjs check', [...mock.missing.map(f => `mock-be/ thiếu ${f}`), ...mock.errors]];
    } else if (planDef.kind === 'remove') {
      [label, errors] = ['kiểm xóa', removeCheck(code, files)];
    } else {
      [label, errors] = ['kiểm UI tĩnh', uiPrecheck({ root, code, base: existing.base, screens: planDef.screens, files })];
    }
    if (errors.length) {
      console.error(JSON.stringify({ ok: false, reason: `Chưa thể coded: ${label} có ${errors.length} lỗi — gọi lại agent chủ plan sửa đúng các mục, rồi plan --status coded lại`, missing: errors }, null, 2));
      process.exit(2);
    }
  }
  const outside = touches ? files.filter(f => !touches.some(t => overlaps(t, f))) : [];
  if (outside.length) console.error(`cảnh báo: plan ${id} sửa file ngoài touches: ${outside.join(', ')} — plan-reviewer sẽ hỏi lý do`);
  const saved = S.updateState(root, fresh => {
    fresh.plans[id] = { ...(fresh.plans[id] || {}), status, files };
    return fresh.plans[id];
  });
  print({ id, ...saved });
}

module.exports = { plan };
