const store = require('./store.cjs');
const files = require('./repo-files.cjs');
const { oneLine } = require('./answers.cjs');
const { draftsOf, poAnswer, roundAnswers, dateOf } = require('./answer-ledger.cjs');
const { chosen } = require('../web/quiz-model.cjs');
const { closeWaits, submission } = require('./kit.cjs');

const FROM = ['quiz', 'review', 'approved', 'needs-input', 'parked'];
const NOTES = 'inputs/po-notes-prev.md';

const KINDS = { po: 'PO trả lời', draft: 'PO nháp, chưa nộp', agent: 'agent tự chốt' };
const answerLine = ({ id, title, label, text, kind, date }) => `- ${id} ${title ?? ''} (${KINDS[kind]}, ${date}): ${label} — "${oneLine(text)}"`;

function notesOf(spec) {
  const { previous } = spec.data;
  if (!previous) return { files: {}, notes: null };
  const lines = [
    '# Câu trả lời của lần làm trước', '',
    'Spec nguồn đã đổi nên đọc lại từ đầu. Câu nào vẫn đúng với spec mới thì giữ theo câu PO đã trả lời; câu agent tự chốt và câu PO nháp (chưa nộp) chỉ để tham khảo, vẫn hỏi lại PO.',
    ...(previous.spec ? ['Bản spec đã làm rõ lần trước: .harness-run/inputs/previous-spec.md'] : []), '',
    ...previous.answers.map(answerLine), '',
    ...(previous.feedback?.length ? ['Góp ý của PO:', ...previous.feedback.map(text => `- "${oneLine(text)}"`), ''] : []),
  ];
  return { files: { 'po-notes-prev.md': lines.join('\n'), ...(previous.spec && { 'previous-spec.md': previous.spec }) }, notes: NOTES };
}

function lastSpec(repo) {
  try {
    return repo ? files.latestSpec(repo)?.markdown ?? null : null;
  } catch {
    return null;
  }
}

function openRoundAnswers(ctx, spec) {
  const { db } = ctx;
  if (!spec.data.rounds?.length || spec.data.mergedRound === spec.round) return [];
  if (submission(db, spec.id, spec.round)) return roundAnswers(db, spec);
  const drafts = draftsOf(db, spec);
  const times = new Map(store.answersOf(db, spec.id, spec.round).map(row => [row.qid, row.at]));
  return (spec.data.questions ?? []).filter(question => chosen(drafts.get(question.id)) && spec.data.answered?.[question.id]?.kind !== 'po')
    .map(question => ({ ...poAnswer(question, drafts.get(question.id), dateOf(times.get(question.id))), kind: 'draft' }));
}

function refreshSpec(ctx, spec, now) {
  const { data } = spec;
  const titles = new Map((data.questions ?? []).map(q => [q.id, q.title]));
  const last = openRoundAnswers(ctx, spec);
  const kept = Object.values(data.answered ?? {}).filter(answer => !last.some(item => item.id === answer.id && item.kind === 'po'));
  const answers = [...kept, ...last].map(answer => ({ ...answer, title: titles.get(answer.id) ?? '' }));
  const feedback = [...(data.previous?.feedback ?? []), ...(data.feedback ?? [])].slice(-20);
  const previous = answers.length || feedback.length ? { answers: answers.length ? answers : data.previous?.answers ?? [], feedback, spec: lastSpec(data.repo) } : data.previous ?? null;
  const chatFloor = store.chatsOf(ctx.db, spec.id).at(-1)?.id ?? data.chatFloor ?? 0;
  const next = store.transitionSpec(ctx.db, spec.id, FROM, 'reading', now, {
    specSha: null, approvedSha: null,
    data: {
      run: (data.run ?? 1) + 1, previous, chatFloor, answered: {}, questions: [], questionsMd: '', rounds: [], lastRound: data.rounds?.length ? spec.round : data.lastRound ?? 0,
      mergedRound: 0, approving: null, reviewed: [], feedback: [], notes: null, needs: null, parked: null, readAt: 0,
    },
  });
  if (next) closeWaits(ctx.db, spec.id, now);
  return next;
}

module.exports = { refreshSpec, notesOf, FROM };
