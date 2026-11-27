const files = require('./repo-files.cjs');
const { checkRepo } = require('./wire.cjs');
const { matches } = require('./answer-ledger.cjs');
const { restore } = require('./phase-quiz.cjs');
const { oneLine } = require('./answers.cjs');
const { fresh } = require('./segment.cjs');
const { move, patch, decide, once, openOnce, closeWaits, linkFor, nameOf } = require('./kit.cjs');
const { recordWould } = require('../bugs/effects.cjs');
const { logChanged } = require('../service-log.cjs');
const { firstLine } = require('../redact.cjs');

const MINUTE = 60 * 1000;
const MAX_COMMENTS = 5;

const intact = run => matches(files.read(run.spec.data.repo, 'questions.md') ?? '', run.spec.data.answered ?? {}, run.spec.data.questionsMd ?? '');

function reclarify(run) {
  restore(run, files.read(run.spec.data.repo, 'questions.md') ?? '');
  closeWaits(run.db, run.spec.id, run.now, 'review');
  move(run, 'clarifying', { data: { approving: null, reviewFloor: run.spec.data.reviewVersion, ...fresh(run.spec, 'clarify') } });
}

function refuse(run, error) {
  patch(run, { approving: null });
  decide(run, 'S02', 'spec-approve-failed', { error });
  openOnce(run, 'approve-failed', 'dev', `Spec ${nameOf(run.spec)}: PO đã duyệt nhưng chưa ghi được: ${error}`);
  return { ok: false, error: 'Chưa ghi được lời duyệt. Dev trực đã được báo, bạn thử lại sau.' };
}

async function recordGate(run, repo, { sha, by, at }) {
  try {
    await checkRepo(repo);
    files.write(repo, 'inputs/approval.json', `${JSON.stringify({ sha, by, at })}\n`);
    return null;
  } catch (error) {
    return firstLine(error);
  }
}

async function finishApprove(run) {
  const { repo, approving } = run.spec.data;
  const latest = files.latestSpec(repo);
  if (latest?.sha !== approving.sha) {
    patch(run, { approving: null });
    return { ok: false, error: 'Nội dung vừa có bản mới hơn bản bạn đang xem. Hãy tải lại trang rồi xem lại.' };
  }
  if (!intact(run)) {
    reclarify(run);
    return { ok: false, error: 'Câu trả lời trong bản này bị lệch so với lời PO nên phải viết lại. Bạn sẽ được nhắn khi có bản mới.' };
  }
  const problem = await recordGate(run, repo, approving);
  if (problem) return refuse(run, problem);
  if (files.latestSpec(repo)?.sha !== approving.sha) return refuse(run, 'spec đổi trong lúc ghi lời duyệt');
  await once(run, `approve-${run.spec.data.run ?? 1}-${approving.sha.slice(0, 16)}`, () => {
    decide(run, 'S02', 'spec-approved', { sha: approving.sha, quote: approving.quote, by: approving.by });
    return { sha: approving.sha };
  });
  closeWaits(run.db, run.spec.id, run.now);
  move(run, 'approved', { approvedSha: approving.sha, data: { approving: null, approvedAt: approving.at } });
  return { ok: true };
}

async function approve(run, { sha, quote }, by) {
  patch(run, { approving: { sha, quote: oneLine(quote, 500).replace(/^-+/, ''), by, at: run.now } });
  return finishApprove(run);
}

async function review(run) {
  const { data, specSha } = run.spec;
  if (data.approving) {
    await finishApprove(run);
    return run.spec.state !== 'review';
  }
  if (!intact(run)) {
    reclarify(run);
    return true;
  }
  const latest = files.latestSpec(data.repo);
  if (latest && latest.sha !== specSha) {
    closeWaits(run.db, run.spec.id, run.now, 'review');
    decide(run, 'S02', 'spec-review-changed', { sha: latest.sha });
    move(run, 'review', { specSha: latest.sha, data: { reviewVersion: latest.version } });
  }
  openOnce(run, `review-${run.spec.specSha.slice(0, 12)}`, 'po', `Duyệt spec ${nameOf(run.spec)}`, () => linkFor(run.ctx, run.spec.id, 'review', run.now));
  return false;
}

const commentDone = ({ data, approvedSha }, live) => data.commented === approvedSha && (!live || data.commentedLive === true);

async function approved(run) {
  const { data, source, approvedSha } = run.spec;
  if (commentDone(run.spec, run.live)) return false;
  if (source.type !== 'url' || (data.commentAt ?? 0) > run.now) return false;
  const marker = `dz-spec-${run.spec.id}-${approvedSha.slice(0, 16)}`;
  const counts = Object.values(data.answered ?? {}).reduce((out, { kind }) => ({ ...out, [kind]: out[kind] + 1 }), { po: 0, agent: 0 });
  const text = `[Claude] PO đã duyệt bản spec làm rõ ngày ${new Date(data.approvedAt + 7 * 60 * MINUTE).toISOString().slice(0, 10)} (${counts.po} câu PO trả lời, ${counts.agent} câu agent tự chốt, bản ${approvedSha.slice(0, 12)}).`;
  try {
    if (run.live) await run.ctx.specs.confluence(run.project).commentOnce(source.ref, marker, text);
    else recordWould(run.ctx, run.project)('would', `confluence comment ${marker}`);
    patch(run, { commented: approvedSha, commentedLive: run.live });
    logChanged(run.ctx, `spec-comment:${run.spec.id}`, null);
  } catch (error) {
    const tries = (data.commentTries ?? 0) + 1;
    patch(run, tries >= MAX_COMMENTS ? { commented: approvedSha, commentedLive: run.live, commentTries: 0 } : { commentTries: tries, commentAt: run.now + 15 * MINUTE });
    if (tries >= MAX_COMMENTS) openOnce(run, 'comment-failed', 'dev', `Spec ${nameOf(run.spec)}: không ghi được comment Confluence`);
    logChanged(run.ctx, `spec-comment:${run.spec.id}`, { specId: run.spec.id, error: firstLine(error) }, 'spec-comment-error');
  }
  return false;
}

module.exports = { review, approve, approved, commentDone };
