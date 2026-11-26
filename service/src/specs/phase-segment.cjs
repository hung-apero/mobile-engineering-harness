const crypto = require('node:crypto');
const files = require('./repo-files.cjs');
const { matches, rebuild, roundAnswers } = require('./answer-ledger.cjs');
const { inspect } = require('./verify.cjs');
const segment = require('./segment.cjs');
const { enter, restore } = require('./phase-quiz.cjs');
const { firstLine } = require('../redact.cjs');
const { move, patch, once, park, needInput, closeWaits } = require('./kit.cjs');

const ledger = run => [run.spec.data.answered ?? {}, run.spec.data.questionsMd ?? ''];

function writeRound(run) {
  const { repo, mergedRound } = run.spec.data;
  let md = files.read(repo, 'questions.md') ?? run.spec.data.questionsMd;
  if (mergedRound !== run.spec.round) {
    if (!matches(md, ...ledger(run))) md = restore(run, md);
    const answered = { ...run.spec.data.answered };
    for (const { replace, ...answer } of roundAnswers(run.db, run.spec)) answered[answer.id] = answer;
    patch(run, { answered, mergedRound: run.spec.round });
  }
  const next = rebuild(md, ...ledger(run));
  if (next !== md) files.write(repo, 'questions.md', next);
  patch(run, { questionsMd: next });
  return { answers: Object.keys(run.spec.data.answered).length, sha: crypto.createHash('sha256').update(next).digest('hex') };
}

async function prepare(run) {
  if (run.spec.state !== 'clarifying') return;
  await once(run, `answers-${run.spec.round}`, () => writeRound(run));
  const { repo } = run.spec.data;
  const md = files.read(repo, 'questions.md') ?? '';
  if (!matches(md, ...ledger(run))) restore(run, md);
}

function settleAnswers(run) {
  const { repo } = run.spec.data;
  const md = files.read(repo, 'questions.md');
  if (md === null || matches(md, ...ledger(run))) return false;
  restore(run, md);
  return true;
}

function review(run, { latest }) {
  const reviewed = [...(run.spec.data.reviewed ?? []), latest.version];
  closeWaits(run.db, run.spec.id, run.now, 'review');
  move(run, 'review', { specSha: latest.sha, data: { reviewed, reviewVersion: latest.version, notes: null, approving: null } });
}

async function look(run) {
  try {
    const restored = settleAnswers(run);
    const found = await inspect(run);
    return restored && found.type === 'clarified' ? { type: 'short', reason: 'worker đã sửa câu trả lời, bản spec phải viết lại' } : found;
  } catch (error) {
    if (error.code === 'HARNESS') return { type: 'blocked', kind: 'harness', role: 'dev', reason: firstLine(error), missing: [] };
    return { type: 'short', reason: firstLine(error) };
  }
}

async function settle(run, error) {
  const found = await look(run);
  if (found.type === 'tampered') park(run, found.reason);
  else if (found.type === 'blocked') needInput(run, found);
  else if (found.type === 'questions') enter(run, found.md);
  else if (found.type === 'clarified') review(run, found);
  else segment.again(run, error ? `${error}; ${found.reason}` : found.reason);
}

async function advance(run) {
  const now = segment.state(run);
  if (now.type === 'waiting') return false;
  if (now.type === 'missing') {
    await prepare(run);
    segment.launch(run);
    return false;
  }
  if (now.type === 'parked') {
    const { id, parkReason } = now.job;
    park(run, parkReason ?? 'việc bị gác', { jobId: id });
    return false;
  }
  await settle(run, now.error);
  return true;
}

module.exports = { advance };
