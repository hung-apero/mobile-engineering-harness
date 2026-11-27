const { NAME } = require('../bugs/defer.cjs');
const { lastPr } = require('../bugs/next-branch.cjs');
const { commentPr } = require('../bugs/publish.cjs');
const { redact } = require('../redact.cjs');
const { runGh } = require('../bugs/git.cjs');
const { recordWould } = require('../bugs/effects.cjs');
const { load, save, decide, setWait, versionTip, usable } = require('./state.cjs');

class QaError extends Error {}

function readState(ctx, project, version, by) {
  if (typeof by !== 'string' || !NAME.test(by)) throw new QaError('cần tên người chọn');
  const state = load(ctx.db, project.key, version.version);
  if (state.run) throw new QaError('E2E đang chạy, chờ xong rồi chọn');
  return state;
}

const leftOf = ({ failures, incomplete }) => [...failures.map(f => f.id), ...incomplete];

async function alreadyPosted(ctx, project, number, body) {
  const { stdout } = await (ctx.bugs.gh ?? runGh)(['pr', 'view', String(number), '--repo', project.repo, '--json', 'comments'], { cwd: ctx.dzHome });
  return (JSON.parse(stdout || '{}').comments ?? []).some(comment => comment?.body === redact(body));
}

async function finishPost(ctx, project, version, state, now) {
  const { result } = state;
  const left = leftOf(result);
  const body = `[Claude] QA ${result.accepted.by.replaceAll('@', '＠')} chấp nhận E2E bản ${version.version} (commit ${result.sha.slice(0, 12)}) khi còn: ${left.slice(0, 20).join(', ')}.`;
  const number = lastPr(ctx.db, project.key, version)?.number;
  if (project.live !== true) recordWould(ctx, project)('would', `gh pr comment ${version.version}: ${body}`);
  else if (number && !(await alreadyPosted(ctx, project, number, body))) await commentPr({ dzHome: ctx.dzHome, project, number, body, live: true, record: () => {}, gh: ctx.bugs.gh });
  const latest = load(ctx.db, project.key, version.version);
  if (latest.result?.at === result.at && latest.result.status === 'accepted') save(ctx.db, project.key, version.version, { ...latest, result: { ...latest.result, accepted: { ...result.accepted, posted: true } } }, now);
  return { tree: result.tree, left };
}

async function acceptE2e(ctx, project, version, { by }, now) {
  const state = readState(ctx, project, version, by);
  const tip = await versionTip(ctx, project, version);
  if (state.result?.status === 'accepted' && state.result.accepted.posted === false && usable(state.result, tip?.tree)) return finishPost(ctx, project, version, state, now);
  if (state.result?.status !== 'fail' || !usable(state.result, tip?.tree)) throw new QaError(`không có kết quả E2E lỗi trên đúng mã hiện tại của bản ${version.version}`);
  const left = leftOf(state.result);
  state.result = { ...state.result, status: 'accepted', accepted: { by, at: now, posted: false } };
  state.failedRounds = 0;
  setWait(ctx, project, state, 'qa', false, {}, now);
  save(ctx.db, project.key, version.version, state, now);
  decide(ctx, project, 'S06', 'qa-accept', { version: version.version, by, tree: state.result.tree, left: left.slice(0, 20) }, now);
  return finishPost(ctx, project, version, state, now);
}

function continueE2e(ctx, project, version, { by }, now) {
  const state = readState(ctx, project, version, by);
  state.failedRounds = 0;
  state.blocked = null;
  if (state.result?.status === 'fail' && state.result.failures.length === 0) state.result = null;
  for (const name of ['qa', 'blocked']) setWait(ctx, project, state, name, false, {}, now);
  save(ctx.db, project.key, version.version, state, now);
  decide(ctx, project, 'S06', 'qa-continue', { version: version.version, by }, now);
  return { rerun: state.result === null };
}

module.exports = { acceptE2e, continueE2e, QaError };
