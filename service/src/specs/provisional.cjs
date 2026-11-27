const crypto = require('node:crypto');
const { draftsOf } = require('./answer-ledger.cjs');
const { oneLine } = require('./answers.cjs');
const { fresh } = require('./segment.cjs');
const { chosen, OTHER } = require('../web/quiz-model.cjs');
const { move, patch, decide, openOnce, closeWaits, linkFor, nameOf } = require('./kit.cjs');
const { saveBuild, sendBack, clip } = require('./build-kit.cjs');

const MAX_TEXT = 600;
const ROLES = ['po', 'dev', 'qa'];
const ROLE_NAMES = { po: 'PO', dev: 'Dev', qa: 'QA' };
const LABELS = ['A', 'B', 'C'];
const UPDATABLE = ['role', 'title', 'body', 'options', 'recommend', 'why', 'hard'];
const HARD = /(?:xo[áàa]|xóa|delete|wipe|erase)[^.\n]{0,40}(?:dữ liệu|data|tài khoản|account|tiến độ|progress)|thanh toán|giao dịch|trừ tiền|payment|billing|purchase/iu;

const provOf = spec => spec.data.prov ?? { items: {}, next: 1, round: null, settled: null };
const itemsOf = spec => Object.values(provOf(spec).items);
const roleOf = item => (ROLES.includes(item.role) ? item.role : 'po');
const openItems = spec => itemsOf(spec).filter(item => item.status === 'open');
const holdsInstall = spec => openItems(spec).some(item => item.hard);
const sentIds = (prov, role) => new Set(prov.sent?.[role]?.ids ?? []);
const unsentOf = (spec, role) => openItems(spec).filter(item => roleOf(item) === role && !sentIds(provOf(spec), role).has(item.qid));
const rolesOpen = spec => ROLES.filter(role => unsentOf(spec, role).length > 0);
const countsOf = spec => Object.fromEntries(ROLES.map(role => [role, openItems(spec).filter(item => roleOf(item) === role).length]));
const text = value => clip(value ?? '', MAX_TEXT);

function merge(prov, found) {
  const items = { ...prov.items };
  let { next } = prov;
  for (const { same, ...item } of found) {
    const old = same && Object.values(items).find(known => known.qid === same && known.status === 'open');
    if (old) {
      items[old.key] = { ...old, ...Object.fromEntries(UPDATABLE.map(name => [name, item[name]])) };
      continue;
    }
    if (items[item.key]) continue;
    items[item.key] = { ...item, qid: `T${next}`, picked: 'A', status: 'open', apply: false };
    next += 1;
  }
  return { ...prov, items, next };
}

function openRound(run, tag) {
  const prov = provOf(run.spec);
  const roles = rolesOpen(run.spec);
  if (!roles.length) return closeWaits(run.db, run.spec.id, run.now, 'prov');
  const asked = openItems(run.spec).map(item => item.qid);
  if (prov.round === null) move(run, run.spec.state, { round: run.spec.round + 1, data: { prov: { ...prov, round: run.spec.round + 1 } } });
  const round = provOf(run.spec).round;
  if (JSON.stringify(asked) !== JSON.stringify(prov.asked) || tag !== prov.tag) {
    if (tag !== prov.tag) closeWaits(run.db, run.spec.id, run.now, 'prov');
    patch(run, { prov: { ...provOf(run.spec), asked, tag } });
    decide(run, 'S03', 'spec-provisional-asked', { round, tag, ids: asked, roles });
  }
  for (const role of ROLES.filter(item => !roles.includes(item))) closeWaits(run.db, run.spec.id, run.now, `prov-${role}-`);
  for (const role of roles) {
    const subject = `Chốt ${unsentOf(run.spec, role).length} câu phần ${ROLE_NAMES[role]} phát sinh khi code spec ${nameOf(run.spec)}`;
    openOnce(run, `prov-${role}-${tag}`, role, subject, () => `${linkFor(run.ctx, run.spec.id, 'quiz', run.now)}#${role}`);
  }
}

const REVIEW = { prefix: 'review', option: 'Giữ như đang làm', why: 'Người kiểm code thấy điểm cần chốt' };
const BLOCK = { prefix: 'block', option: 'Làm theo cách tạm agent đã chọn', why: 'Lượt code gặp điểm cần chốt, agent tạm chọn để làm tiếp' };
const ACCESS = /token|quyền|quyen|đăng nhập|dang nhap|preflight|\b40[13]\b|mạng|vpn|google-services|keystore|credential|secret|permission/iu;
const DECISION = /\bPO\b|chốt|chot|quyết định|quyet dinh|hoặc|hoac|\bor\b/iu;

const keyOf = (prefix, question) => `${prefix}/${crypto.createHash('sha256').update(question).digest('hex').slice(0, 12)}`;
const askOf = value => (typeof value === 'string' ? { role: 'po', question: value, context: '', now: '', options: [], recommend: 'A', why: '', same: '' } : value);

function itemOf(value, kind) {
  const ask = askOf(value);
  const options = [ask.now || kind.option, ...(ask.options ?? []).slice(0, 2)].map((option, i) => ({ label: LABELS[i], text: text(option), value: LABELS[i] }));
  const recommend = options.some(option => option.label === ask.recommend) ? ask.recommend : 'A';
  return {
    key: keyOf(kind.prefix, ask.question), role: ROLES.includes(ask.role) ? ask.role : 'po', title: text(ask.question), body: text(ask.context),
    options, value: 'A', recommend, why: text(ask.why) || kind.why, hard: HARD.test(ask.question), same: ask.same ?? '',
  };
}

function addQuestions(run, questions, kind = REVIEW) {
  patch(run, { prov: merge(provOf(run.spec), questions.map(question => itemOf(question, kind))) });
  if (holdsInstall(run.spec)) openRound(run, 'hard');
}

function assumeBlock(run, { reason, missing = [], role }) {
  const question = [reason, ...missing].join(' — ');
  if (ACCESS.test(question) || !DECISION.test(question) || HARD.test(question)) return false;
  if (provOf(run.spec).items[keyOf(BLOCK.prefix, question)]) return false;
  addQuestions(run, [{ role: ROLES.includes(role) ? role : 'po', question, context: '', now: '', options: missing, recommend: 'A', why: '', same: '' }], BLOCK);
  decide(run, 'S03', 'spec-assumed', { reason: text(question) });
  const ways = missing.length ? ` (các hướng: ${missing.join('; ')})` : '';
  sendBack(run, `Lượt code trước dừng vì: ${reason}${ways}. Không dừng ở điểm này: chọn hướng làm được ngay với code và SDK hiện có, ghi giả định vào build-notes và result.json; người chốt sẽ xác nhận khi thử bản cài.`, `assume-${run.spec.data.serial}`);
  toBuilding(run);
  return true;
}

function settleRound(run) {
  const prov = provOf(run.spec);
  const sent = Object.entries(prov.sent ?? {});
  if (!sent.length) return;
  const drafts = draftsOf(run.db, run.spec, prov.round);
  const items = { ...prov.items };
  for (const [, { ids, by, at }] of sent) {
    for (const item of Object.values(items)) {
      const draft = drafts.get(item.qid);
      if (!ids.includes(item.qid) || item.status !== 'open' || !chosen(draft)) continue;
      const status = draft.choice === OTHER ? 'other' : draft.choice === item.picked ? 'confirmed' : 'changed';
      items[item.key] = { ...item, status, apply: true, said: { label: draft.choice, text: oneLine(draft.text, MAX_TEXT), by, at } };
    }
  }
  const settled = (Number.isInteger(prov.settled) ? prov.settled : 0) + 1;
  patch(run, { prov: { ...prov, items, sent: {}, settled } });
  for (const [role] of sent) closeWaits(run.db, run.spec.id, run.now, `prov-${role}-`);
  const answers = Object.values(items).filter(item => item.apply).map(item => `${item.key}: ${item.said.label}`);
  decide(run, 'S03', 'spec-provisional-answered', { round: prov.round, roles: sent.map(([role]) => role), by: sent.map(([, s]) => s.by).join(', '), answers });
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
  if (redo.length) sendBack(run, `Câu phát sinh khi code đã được chốt: ${redo.map(item => `${item.title} → ${quoteOf(item)}`).join('; ')}`, `prov-${prov.settled}`);
  const items = Object.fromEntries(Object.entries(prov.items).map(([key, item]) => [key, { ...item, apply: false }]));
  patch(run, { prov: { ...prov, items } });
  if (redo.length) toBuilding(run);
  return true;
}

module.exports = {
  addQuestions, assumeBlock, openRound, settleRound, applyAnswers, toBuilding, provOf, openItems, holdsInstall,
  roleOf, rolesOpen, unsentOf, sentIds, countsOf, ROLES, ROLE_NAMES,
};
