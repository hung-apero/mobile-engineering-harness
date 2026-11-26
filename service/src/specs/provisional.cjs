const crypto = require('node:crypto');
const { draftsOf } = require('./answer-ledger.cjs');
const { oneLine } = require('./answers.cjs');
const { fresh } = require('./segment.cjs');
const { chosen, OTHER } = require('../web/quiz-model.cjs');
const { move, patch, decide, openOnce, closeWaits, linkFor, submission, nameOf } = require('./kit.cjs');
const { saveBuild, sendBack, clip } = require('./build-kit.cjs');

const MAX_TEXT = 600;
const HARD = /(?:xo[áàa]|xóa|delete|wipe|erase)[^.\n]{0,40}(?:dữ liệu|data|tài khoản|account|tiến độ|progress)|thanh toán|giao dịch|trừ tiền|payment|billing|purchase/iu;

const provOf = spec => spec.data.prov ?? { items: {}, next: 1, round: null, settled: null };
const itemsOf = spec => Object.values(provOf(spec).items);
const openItems = spec => itemsOf(spec).filter(item => item.status === 'open');
const holdsInstall = spec => openItems(spec).some(item => item.hard);
const text = value => clip(value, MAX_TEXT);

function merge(prov, found) {
  const items = { ...prov.items };
  let { next } = prov;
  for (const item of found) {
    if (items[item.key]) continue;
    items[item.key] = { ...item, qid: `T${next}`, picked: 'A', status: 'open', apply: false };
    next += 1;
  }
  return { ...prov, items, next };
}

function openRound(run) {
  const open = openItems(run.spec);
  if (!open.length) return closeWaits(run.db, run.spec.id, run.now, 'prov');
  const prov = provOf(run.spec);
  const unsent = prov.round !== null && !submission(run.db, run.spec.id, prov.round);
  const round = unsent ? prov.round : run.spec.round + 1;
  const asked = open.map(item => item.qid);
  if (!unsent || JSON.stringify(asked) !== JSON.stringify(prov.asked)) {
    move(run, run.spec.state, { round, data: { prov: { ...prov, round, asked } } });
    decide(run, 'S03', 'spec-provisional-asked', { round, ids: asked, keys: open.map(item => item.key) });
  }
  return openOnce(run, `prov-${round}`, 'po', `Xác nhận câu tạm chọn khi code spec ${nameOf(run.spec)}`, () => linkFor(run.ctx, run.spec.id, 'quiz', run.now));
}

function addQuestions(run, questions) {
  const found = questions.map(question => {
    const key = `review/${crypto.createHash('sha256').update(question).digest('hex').slice(0, 12)}`;
    const options = [{ label: 'A', text: 'Giữ như đang làm', value: 'A' }];
    return { key, title: text(question), options, value: 'A', why: 'Người kiểm code thấy điểm cần PO chốt', hard: HARD.test(question) };
  });
  patch(run, { prov: merge(provOf(run.spec), found) });
  if (holdsInstall(run.spec)) openRound(run);
}

function settleRound(run) {
  const prov = provOf(run.spec);
  const sent = prov.round === null || prov.settled === prov.round ? null : submission(run.db, run.spec.id, prov.round);
  if (!sent) return;
  const drafts = draftsOf(run.db, run.spec, prov.round);
  const items = Object.fromEntries(Object.entries(prov.items).map(([key, item]) => {
    const draft = drafts.get(item.qid);
    if (item.status !== 'open' || !chosen(draft)) return [key, item];
    const status = draft.choice === OTHER ? 'other' : draft.choice === item.picked ? 'confirmed' : 'changed';
    return [key, { ...item, status, apply: true, said: { label: draft.choice, text: oneLine(draft.text, MAX_TEXT), by: sent.by, at: sent.at } }];
  }));
  patch(run, { prov: { ...prov, items, settled: prov.round } });
  closeWaits(run.db, run.spec.id, run.now, 'prov');
  decide(run, 'S03', 'spec-provisional-answered', { round: prov.round, by: sent.by, answers: Object.values(items).filter(item => item.apply).map(item => `${item.key}: ${item.said.label}`) });
}

function toBuilding(run) {
  closeWaits(run.db, run.spec.id, run.now, 'trial');
  saveBuild(run, { trial: null, launches: 0 });
  move(run, 'building', { data: fresh(run.spec, 'build') });
}

function quoteOf(item) {
  const label = item.options.find(option => option.label === item.said.label)?.text ?? item.said.label;
  return clip([item.status === 'confirmed' ? `Xác nhận: ${label}` : label, item.said.text].filter(Boolean).join(' — '), MAX_TEXT);
}

function applyAnswers(run) {
  const prov = provOf(run.spec);
  const todo = itemsOf(run.spec).filter(item => item.apply);
  if (!todo.length) return false;
  const redo = todo.filter(item => item.status !== 'confirmed');
  if (redo.length) sendBack(run, `PO trả lời câu phát sinh khi code: ${redo.map(item => `${item.title} → ${quoteOf(item)}`).join('; ')}`, `prov-${prov.settled}`);
  const items = Object.fromEntries(Object.entries(prov.items).map(([key, item]) => [key, { ...item, apply: false }]));
  patch(run, { prov: { ...prov, items } });
  if (redo.length) toBuilding(run);
  return true;
}

module.exports = { addQuestions, openRound, settleRound, applyAnswers, toBuilding, provOf, openItems, holdsInstall };
