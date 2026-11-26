const store = require('./store.cjs');
const { parseQuestions, splitBlocks } = require('./questions.cjs');
const { writeAnswers } = require('./answers.cjs');
const { chosen, OTHER } = require('../web/quiz-model.cjs');
const { submission } = require('./kit.cjs');

const ANSWER = /\*\*\s*(?:PO\s+(?:trả lời|chọn)|Agent\s+tự\s+chốt)/i;
const DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Saigon' });

const dateOf = at => DAY.format(new Date(at));
const clean = text => String(text ?? '').normalize('NFC');
const idOf = block => block.match(/^## (Q\d+)/)[1];

function draftsOf(db, spec, round = spec.round) {
  return new Map(store.answersOf(db, spec.id, round).map(row => [row.qid, { choice: row.choice, text: row.text }]));
}

function poAnswer(question, draft, date) {
  const option = question.options.find(item => item.label === draft.choice);
  const note = draft.choice === OTHER ? draft.text : [option?.text, String(draft.text ?? '').trim()].filter(Boolean).join(' — ');
  return { id: question.id, kind: 'po', label: draft.choice, text: note, date };
}

function roundAnswers(db, spec) {
  const sent = submission(db, spec.id, spec.round);
  if (!sent) return [];
  const date = dateOf(sent.at);
  const drafts = draftsOf(db, spec);
  const { ask = [], auto = [] } = spec.data.rounds?.at(-1) ?? {};
  return (spec.data.questions ?? []).flatMap(question => {
    const draft = drafts.get(question.id);
    const known = spec.data.answered?.[question.id];
    if (known?.kind === 'po') return [];
    if (chosen(draft) && (ask.includes(question.id) || auto.includes(question.id) || known)) return [poAnswer(question, draft, date)];
    if (!auto.includes(question.id) || known) return [];
    return [{ id: question.id, kind: 'agent', label: question.auto.label, text: question.auto.source || question.auto.reason, date }];
  });
}

function keepBlocks(md, base) {
  const have = new Set(splitBlocks(md).map(idOf));
  const lost = splitBlocks(base).filter(block => !have.has(idOf(block)));
  return lost.length ? `${md.trimEnd()}\n\n${lost.map(block => block.trimEnd()).join('\n\n')}\n` : md;
}

const strip = md => md.replace(/\r\n?/g, '\n').split('\n').filter(line => !ANSWER.test(line)).join('\n');

function rebuild(md, answered, base = '') {
  return writeAnswers(strip(keepBlocks(clean(md), base)), Object.values(answered));
}

const told = md => JSON.stringify(parseQuestions(md).filter(q => q.answered).map(q => [q.id, q.answer.kind, q.answer.label, q.answer.text]).sort());
const seen = md => JSON.stringify(parseQuestions(md).filter(q => q.answered).map(q => q.id).sort());

function matches(md, answered, base = '') {
  const text = clean(md);
  const wanted = rebuild(text, answered, base);
  const count = value => value.split('\n').filter(line => ANSWER.test(line)).length;
  return keepBlocks(text, base) === text && told(text) === told(wanted) && seen(text) === seen(wanted) && count(text) === count(wanted);
}

module.exports = { draftsOf, poAnswer, roundAnswers, rebuild, matches, dateOf };
