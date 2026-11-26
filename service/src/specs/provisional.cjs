const crypto = require('node:crypto');
const { draftsOf } = require('./answer-ledger.cjs');
const { oneLine } = require('./answers.cjs');
const { fresh } = require('./segment.cjs');
const { chosen, OTHER } = require('../web/quiz-model.cjs');
const { move, patch, decide, once, openOnce, closeWaits, linkFor, submission, nameOf } = require('./kit.cjs');
const { saveBuild, learnState, state, sendBack, planOfFeature, clip } = require('./build-kit.cjs');

const LETTERS = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];
const MAX_TEXT = 600;
const HARD = /(?:xo[áàa]|xóa|delete|wipe|erase)[^.\n]{0,40}(?:dữ liệu|data|tài khoản|account|tiến độ|progress)|thanh toán|giao dịch|trừ tiền|payment|billing|purchase/iu;

const provOf = spec => spec.data.prov ?? { items: {}, next: 1, round: null, settled: null };
const itemsOf = spec => Object.values(provOf(spec).items);
const openItems = spec => itemsOf(spec).filter(item => item.status === 'open');
const hardOpen = run => openItems(run.spec).some(item => item.value === null && item.feature);
const holdsInstall = spec => openItems(spec).some(item => item.hard);
const text = value => clip(value, MAX_TEXT);

function itemOf(feature, d) {
  const options = d.options.slice(0, LETTERS.length).map((option, i) => ({ label: LETTERS[i], text: text(option.label), value: String(option.label) }));
  const value = d.choice ?? null;
  const title = text(d.question) || `Quyết định ${d.id}`;
  const body = text([feature.id, title, ...options.map(o => o.text)].join(' '));
  return { key: `${feature.id}/${d.id}`, feature: String(feature.id), decision: String(d.id), title, options, value, why: text(d.why), hard: value === null || HARD.test(body) };
}

function decisionsOf(repo) {
  return (learnState(repo)?.features ?? []).flatMap(feature => (feature.decisions ?? [])
    .filter(d => Array.isArray(d.options) && d.options.length)
    .map(d => ({ item: itemOf(feature, d), settled: Boolean(d.choice) && !d.provisional, auto: d.auto === true })));
}

const answeredValue = item => item.options.find(option => option.label === item.said.label)?.value;

function forgedIn(prov, { item, settled, auto }) {
  if (!settled) return false;
  const known = prov.items[item.key];
  if (!known) return !auto;
  if (known.status === 'open') return true;
  return !known.apply && known.status !== 'other' && answeredValue(known) !== item.value;
}

const signature = item => JSON.stringify([item.value, item.options.map(option => option.value)]);

function merge(prov, found) {
  const items = { ...prov.items };
  let { next } = prov;
  for (const item of found) {
    const known = items[item.key];
    if (known && (known.status === 'open' ? signature(known) === signature(item) : known.apply || signature(known) === signature(item))) continue;
    const picked = item.options.find(option => option.value === item.value)?.label ?? null;
    items[item.key] = { ...item, qid: `T${next}`, picked, status: 'open', apply: false };
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

function collect(run) {
  const prov = provOf(run.spec);
  const all = decisionsOf(run.spec.data.repo);
  const forged = all.filter(entry => forgedIn(prov, entry));
  const keys = forged.map(({ item }) => item.key);
  const unasked = forged.filter(({ item }) => prov.items[item.key]?.status !== 'open');
  const kept = Object.fromEntries(Object.entries(prov.items).filter(([key]) => !unasked.some(({ item }) => item.key === key)));
  const next = merge({ ...prov, items: kept }, [...all.filter(entry => !entry.settled), ...unasked].map(({ item }) => item));
  for (const key of keys) next.items[key] = { ...next.items[key], forged: true };
  if (JSON.stringify(next) !== JSON.stringify(prov)) patch(run, { prov: next });
  if (keys.length) decide(run, 'S03', 'spec-decision-forged', { keys });
  openRound(run);
  return keys;
}

function addQuestions(run, questions) {
  const found = questions.map(question => {
    const key = `review/${crypto.createHash('sha256').update(question).digest('hex').slice(0, 12)}`;
    const options = [{ label: 'A', text: 'Giữ như đang làm', value: 'A' }];
    return { key, feature: null, decision: null, title: text(question), options, value: 'A', why: 'Người kiểm code thấy điểm cần PO chốt', hard: HARD.test(question) };
  });
  patch(run, { prov: merge(provOf(run.spec), found) });
  openRound(run);
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

async function recordAnswer(run, item) {
  if (!item.feature || item.status === 'other') return null;
  const value = answeredValue(item);
  if (!decisionsOf(run.spec.data.repo).some(entry => entry.item.key === item.key)) return decide(run, 'S03', 'spec-answer-without-decision', { key: item.key, value });
  return once(run, `prov-${provOf(run.spec).settled}-${item.qid}`, () => state(run, ['decide', '--feature', item.feature, '--decision', item.decision, '--choice', value, '--quote', quoteOf(item)]).then(() => ({ value })));
}

async function applyAnswers(run) {
  const prov = provOf(run.spec);
  const todo = itemsOf(run.spec).filter(item => item.apply);
  if (!todo.length) return false;
  for (const item of todo) await recordAnswer(run, item);
  const redo = todo.filter(item => item.status === 'other' || item.forged || (item.status === 'changed' && item.value !== null));
  if (redo.length) {
    const plans = redo.map(item => item.feature && planOfFeature(run.spec.data.repo, item.feature)).filter(Boolean);
    const reason = `PO đổi câu tạm chọn: ${redo.map(item => `${item.title} → ${quoteOf(item)}`).join('; ')}`;
    if (!(await sendBack(run, plans, reason, `prov-${prov.settled}`))) return true;
  }
  const items = Object.fromEntries(Object.entries(prov.items).map(([key, item]) => [key, { ...item, apply: false, forged: false }]));
  patch(run, { prov: { ...prov, items } });
  if (redo.length || run.spec.state === 'provisional') toBuilding(run);
  return true;
}

function provisionalWait(run) {
  if (hardOpen(run)) {
    openRound(run);
    return false;
  }
  toBuilding(run);
  return true;
}

module.exports = { collect, addQuestions, settleRound, applyAnswers, provisionalWait, toBuilding, provOf, openItems, hardOpen, holdsInstall };
