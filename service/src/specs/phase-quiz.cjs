const store = require('./store.cjs');
const files = require('./repo-files.cjs');
const { parseQuestions } = require('./questions.cjs');
const { mergeTriage } = require('./triage.cjs');
const { draftsOf, rebuild } = require('./answer-ledger.cjs');
const { chosen } = require('../web/quiz-model.cjs');
const { fresh } = require('./segment.cjs');
const { move, decide, openOnce, closeWaits, linkFor, submission, nameOf, park } = require('./kit.cjs');

const MAX_ROUNDS = 10;

const lastRoundOf = spec => (spec.data.rounds?.length ? spec.round : spec.data.lastRound ?? 0);

function leave(run) {
  closeWaits(run.db, run.spec.id, run.now, 'quiz');
  move(run, 'clarifying', { data: fresh(run.spec, 'clarify') });
}

function enter(run, md) {
  const { data } = run.spec;
  const merged = mergeTriage(parseQuestions(md), files.readJson(data.repo, 'triage.json'));
  const shown = new Set((data.rounds ?? []).flatMap(r => [...r.ask, ...r.auto]));
  const open = merged.filter(q => !q.answered && (!shown.has(q.id) || q.blocking));
  const pick = mode => open.filter(q => q.mode === mode).map(q => q.id);
  const round = lastRoundOf(run.spec) + 1;
  if (round > MAX_ROUNDS) return park(run, `đã hỏi ${MAX_ROUNDS} lần mà vẫn còn câu mới`);
  const entry = { round, ask: pick('ask'), auto: pick('auto') };
  move(run, 'quiz', { round, data: { questions: merged, questionsMd: md, rounds: [...(data.rounds ?? []), entry] } });
  if (entry.auto.length) decide(run, 'S01', 'spec-agent-decided', { round, ids: entry.auto });
  if (entry.ask.length) decide(run, 'S02', 'spec-quiz-opened', { round, ids: entry.ask });
  else store.submitRound(run.db, run.spec.id, round, 'service', run.now);
}

function missingOf(run) {
  const { ask } = run.spec.data.rounds.at(-1);
  const drafts = draftsOf(run.db, run.spec);
  return run.spec.data.questions.filter(q => q.blocking && ask.includes(q.id) && !chosen(drafts.get(q.id))).map(q => q.id);
}

function quiz(run) {
  const { round } = run.spec;
  if (submission(run.db, run.spec.id, round)) {
    leave(run);
    return true;
  }
  openOnce(run, `quiz-${round}`, 'po', `Trả lời câu hỏi spec ${nameOf(run.spec)}${round > 1 ? `, lần ${round}` : ''}`, () => linkFor(run.ctx, run.spec.id, 'quiz', run.now));
  return false;
}

function restore(run, md) {
  const { answered = {}, questionsMd = '', repo } = run.spec.data;
  decide(run, 'S02', 'spec-answers-restored', { segment: run.spec.data.segment?.name });
  const fixed = rebuild(md, answered, questionsMd);
  files.write(repo, 'questions.md', fixed);
  return fixed;
}

module.exports = { enter, quiz, leave, missingOf, restore };
