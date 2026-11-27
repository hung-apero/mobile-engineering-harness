const results = require('./job-results.cjs');
const { checkLane } = require('./lane-check.cjs');
const { fixAgain } = require('./phase-fix.cjs');
const { askPo, giveDev, nextBatch } = require('./outcome.cjs');
const { save, decideOnce, ensureJob, findJob, isHeld, isWaiting, isBroken, gitOf, gitArgs, enterLanding } = require('./phase-kit.cjs');

const MAX_REVIEW_ERRORS = 1;
const pendingOf = run => run.batch.data.lanes.filter(l => l.state !== 'approved');
const suffixOf = run => `v${run.batch.data.reviews + 1}`;

function removeLanes(run, branches) {
  save(run, { lanes: run.batch.data.lanes.filter(l => !branches.includes(l.branch)) });
}

async function dropForbidden(run, lane, text) {
  for (const key of lane.keys) await giveDev(run, key, { code: 'F02', reason: `Nhánh ${lane.branch} chạm vùng cấm hoặc lộ bí mật: ${text}` });
  removeLanes(run, [lane.branch]);
}

async function checkAll(run) {
  const toFix = new Map();
  for (const lane of pendingOf(run)) {
    const found = await checkLane(run, lane);
    if (found.kind === 'forbidden') await dropForbidden(run, lane, found.text);
    else if (found.kind === 'fix') toFix.set(lane.branch, found.text);
  }
  return toFix;
}

function questionsOf(review, lane) {
  const asks = new Map();
  const ask = (key, text, verdict) => asks.set(key, { verdict, question: [asks.get(key)?.question, text].filter(Boolean).join('\n') });
  for (const { key, question } of review.needsPo) ask(key, question, 'needs-confirm');
  for (const { key, commit, why } of review.reversesIntentional) ask(key, `Bản sửa đảo lại commit ${commit}: ${why}. Giữ hành vi nào?`, 'conflict');
  if (!review.specMatch) {
    const text = review.findings.map(f => f.text).join('\n') || 'Bản sửa không khớp spec. Hành vi nào đúng?';
    for (const key of lane.keys) if (!asks.has(key)) ask(key, text, 'conflict');
  }
  return asks;
}

async function applyLaneReview(run, lane, review) {
  const asks = questionsOf(review, lane);
  if (asks.size) {
    for (const key of lane.keys) {
      if (asks.has(key)) await askPo(run, key, asks.get(key));
      else await nextBatch(run, key, { code: 'B05', reason: 'Chung nhánh với bug phải hỏi PO' });
    }
    return { drop: true };
  }
  const changes = review.verdict === 'changes' || review.findings.some(f => f.severity === 'blocker');
  if (!changes) return { approved: true };
  const notes = [...review.forbidden, ...review.findings.map(f => `${f.severity} ${f.file}:${f.line} ${f.text}`)];
  return { fix: notes.join('\n') || 'Reviewer yêu cầu sửa' };
}

async function applyReview(run, lanes) {
  const toFix = new Map();
  const drop = [];
  const approved = [];
  for (const review of lanes) {
    const lane = run.batch.data.lanes.find(l => l.branch === review.branch);
    const outcome = await applyLaneReview(run, lane, review);
    if (outcome.drop) drop.push(review.branch);
    else if (outcome.fix) toFix.set(review.branch, outcome.fix);
    else approved.push(review.branch);
  }
  decideOnce(run, null, `review-${suffixOf(run)}`, 'F03', 'reviewed', { approved, drop, changes: [...toFix.keys()] });
  const kept = run.batch.data.lanes.filter(l => !drop.includes(l.branch));
  save(run, {
    lanes: kept.map(l => (approved.includes(l.branch) ? { ...l, state: 'approved' } : l)),
    reviews: run.batch.data.reviews + 1,
    reviewErrors: 0,
    toFix: [...toFix],
  });
}

async function settleFix(run) {
  const again = await fixAgain(run, new Map(run.batch.data.toFix));
  if (!again && run.batch.data.lanes.length === 0) save(run, { phase: 'done' });
  return true;
}

function reviewFailed(run, error) {
  const { reviewErrors = 0, reviews } = run.batch.data;
  if (reviewErrors >= MAX_REVIEW_ERRORS) save(run, { phase: 'parked', reason: `Kết quả review không đọc được: ${error}` });
  else save(run, { reviewErrors: reviewErrors + 1, reviews: reviews + 1 });
  return true;
}

async function startReview(run) {
  const toFix = await checkAll(run);
  if (toFix.size) {
    save(run, { toFix: [...toFix] });
    return settleFix(run);
  }
  if (run.batch.data.lanes.length === 0) {
    save(run, { phase: 'done' });
    return true;
  }
  if (isHeld(run)) return false;
  const { startSha } = run.batch.data;
  const { tree } = await gitOf(run).landing.versionWorktree(gitArgs(run, { batchId: run.batch.id, name: 'review', sha: startSha, localFiles: false }));
  ensureJob(run, { kind: 'review', suffix: suffixOf(run), payload: results.reviewPayload(run, pendingOf(run), tree) });
  return false;
}

async function reviewing(run) {
  if (run.batch.data.toFix?.length) return settleFix(run);
  if (pendingOf(run).length === 0) {
    if (run.batch.data.lanes.length) return enterLanding(run);
    save(run, { phase: 'done' });
    return true;
  }
  const job = findJob(run, 'review', `${run.batch.id}#${suffixOf(run)}`);
  if (!job) return startReview(run);
  if (isWaiting(job)) return false;
  if (isBroken(job)) {
    save(run, { phase: 'parked', reason: `Việc review #${job.id} ${job.parkReason ?? 'lỗi'}` });
    return true;
  }
  const parsed = results.parseReviewJob(job, pendingOf(run));
  if (!parsed.ok) return reviewFailed(run, parsed.error);
  await applyReview(run, parsed.lanes);
  return true;
}

module.exports = { reviewing };
