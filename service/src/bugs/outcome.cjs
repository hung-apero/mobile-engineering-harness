const kv = require('../kv.cjs');
const store = require('./store.cjs');
const { record } = require('../decisions.cjs');
const { resolveWait } = require('../pings.cjs');
const { firstLine } = require('../redact.cjs');
const { fingerprintOf } = require('./intake.cjs');
const { toIssue, OWN_LABEL } = require('./issue-view.cjs');
const { concludeText, oneLine } = require('./comment-text.cjs');
const { isRefused, isKeyRefusal } = require('./jira-refusal.cjs');
const { openBatchWait } = require('./dry-traces.cjs');
const { decideOnce, decisionOf, effect, mark, jiraOf } = require('./phase-kit.cjs');

const MAX_TRIES = 3;
const PO = ['needs-confirm', 'spec-gap', 'conflict'];
const QA = ['not-a-bug', 'duplicate', 'already-fixed', 'external'];
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const triesKey = (run, key) => `bug-tries:${run.project.key}:${key}`;
const waitsKey = (run, key) => `bug-waits:${run.project.key}:${key}`;
const waitStatusKey = (project, key) => `bug-wait-status:${project}:${key}`;

const isIn = (list, status) => list.some(name => same(name, status));

async function backToWaiting(run, jira, key) {
  const { waiting } = run.project.jiraStatus;
  const status = toIssue(await jira.issue(key)).status;
  if (isIn(waiting, status)) return;
  const reachable = (await jira.transitions(key)).some(t => same(t.to_status, waiting[0]));
  if (reachable) await effect(run, key, 'back', () => jira.transition(key, waiting[0]));
  else decideOnce(run, key, 'back', 'X08', 'no-transition', { from: status, to: waiting[0] });
}

async function refreshFingerprint(run, jira, key) {
  const seen = run.batch.data.seen?.[key];
  const { status } = toIssue(await jira.issue(key));
  if (seen) {
    run.db.prepare('UPDATE tickets SET fingerprint = ? WHERE project = ? AND key = ?')
      .run(fingerprintOf({ ...seen, status }), run.project.key, key);
  }
  return status;
}

async function writeConclusion(run, key, info) {
  const jira = await jiraOf(run);
  await effect(run, key, `comment-${info.code}`, () => jira.comment(key, `dz:${run.batch.id}:${key}:${info.code}`, concludeText(info)));
  await effect(run, key, 'unlabel', () => jira.removeLabels(key, [OWN_LABEL]));
  await backToWaiting(run, jira, key);
  return refreshFingerprint(run, jira, key);
}

function addWait(run, key, role, subject, status) {
  const id = openBatchWait(run, { role, subject });
  const statusKey = waitStatusKey(run.project.key, key);
  if (status) kv.set(run.db, statusKey, { ...kv.get(run.db, statusKey), [id]: status }, run.now);
  const known = kv.get(run.db, waitsKey(run, key)) ?? [];
  kv.set(run.db, waitsKey(run, key), [...new Set([...known, id])], run.now);
}

function closeWaits(run, key) {
  for (const id of kv.get(run.db, waitsKey(run, key)) ?? []) resolveWait(run.db, id, run.now);
  kv.del(run.db, waitsKey(run, key));
  kv.del(run.db, waitStatusKey(run.project.key, key));
}

const keyRefused = async (run, error) => isKeyRefusal(await jiraOf(run), run.project.key, error);

const owned = (run, key) => {
  const ticket = store.getTicket(run.db, run.project.key, key);
  return ticket?.state === 'batched' && ticket.batchId === run.batch.id;
};

async function conclude(run, key, { code, role, verdict, question, reason }) {
  if (!owned(run, key)) return;
  let status;
  try {
    status = await writeConclusion(run, key, { code, verdict, question, reason });
  } catch (error) {
    if (!(await keyRefused(run, error))) throw error;
    return giveDev(run, key, { code: 'X08', reason: refusal(error), write: false });
  }
  mark(run, key, `conclude-${code}`, () => {
    record(run.db, decisionOf(run, code, role === 'po' ? 'ask-po' : 'ask-qa', { key, verdict, question, reason }), run.now);
    const prefix = role === 'po' ? 'PO trả lời' : 'QA xem lại';
    addWait(run, key, role, `${prefix} ${key}: ${oneLine(question || reason || verdict)}`, status);
    kv.del(run.db, triesKey(run, key));
  });
  store.setVerdict(run.db, run.project.key, key, verdict, run.now);
}

const askPo = (run, key, info) => conclude(run, key, { verdict: 'needs-confirm', ...info, code: 'B05', role: 'po' });

const refusal = error => `Jira từ chối ticket: ${firstLine(error)}`;

async function tellJira(run, key, info) {
  try {
    return await writeConclusion(run, key, info);
  } catch (error) {
    if (!(await keyRefused(run, error))) throw error;
    decideOnce(run, key, 'refused', 'X08', 'jira-refused', { error: firstLine(error) });
    return null;
  }
}

async function giveDev(run, key, { code, reason, wait = true, write = true }) {
  if (!owned(run, key)) return;
  const status = write ? await tellJira(run, key, { code, reason }) : null;
  mark(run, key, `conclude-${code}`, () => {
    record(run.db, decisionOf(run, code, 'give-dev', { key, reason }), run.now);
    if (wait) addWait(run, key, 'dev', `${key}: ${oneLine(reason)}`, status);
    kv.del(run.db, triesKey(run, key));
  });
  store.setTicketState(run.db, run.project.key, key, 'batched', 'dev', run.now);
}

async function nextBatch(run, key, { code, reason }) {
  if (!owned(run, key)) return;
  const { result } = mark(run, key, 'next', () => {
    const tries = (kv.get(run.db, triesKey(run, key)) ?? 0) + 1;
    kv.set(run.db, triesKey(run, key), tries, run.now);
    record(run.db, decisionOf(run, code, tries >= MAX_TRIES ? 'too-many-batches' : 'next-batch', { key, reason, tries }), run.now);
    return { tries };
  });
  if (result.tries >= MAX_TRIES) {
    await giveDev(run, key, { code, reason: `Đã sang đợt sau ${result.tries} lần: ${reason}` });
    return;
  }
  store.setTicketState(run.db, run.project.key, key, 'batched', 'accepted', run.now);
}

async function eachKey(run, keys, work) {
  const refused = [];
  for (const key of keys) {
    try {
      await work(key);
    } catch (error) {
      if (!isRefused(error)) throw error;
      refused.push({ key, error });
    }
  }
  if (!refused.length) return;
  if (keys.length > 1 && refused.length === keys.length) throw refused[0].error;
  if (!(await keyRefused(run, refused[0].error))) throw refused[0].error;
  for (const { key, error } of refused) await giveDev(run, key, { code: 'X08', reason: refusal(error), write: false });
}

async function nextBatchAll(run, keys, info) {
  for (const key of keys) await nextBatch(run, key, info);
}

async function applyVerdict(run, ticket) {
  const { key, verdict, status, rootCause: reason, question, needs } = ticket;
  if (PO.includes(verdict)) return askPo(run, key, { verdict, question: question ?? needs, reason });
  if (verdict === 'needs-info') return conclude(run, key, { code: 'B06', role: 'qa', verdict, question: needs ?? question, reason });
  if (QA.includes(verdict)) return conclude(run, key, { code: 'B07', role: 'qa', verdict, question, reason });
  if (verdict === 'out-of-scope') return giveDev(run, key, { code: 'F01', reason: `Ngoài phạm vi tự sửa: ${reason ?? question ?? ''}` });
  if (verdict === 'needs-device' || status === 'needs-device') return nextBatch(run, key, { code: 'F05', reason: 'Thiếu thiết bị để kiểm' });
  if (status === 'approved') return 'lane';
  if (status === 'skipped') return nextBatch(run, key, { code: 'F01', reason: reason ?? 'Worker bỏ qua bug này' });
  return giveDev(run, key, { code: 'F01', reason: `Bản sửa không đạt (${status}): ${reason ?? question ?? ''}` });
}

async function finishFixed(run, key) {
  const jira = await jiraOf(run);
  await refreshFingerprint(run, jira, key);
  mark(run, key, 'fixed', () => {
    record(run.db, decisionOf(run, 'Q01', 'resolved', { key }), run.now);
    run.db.prepare("UPDATE tickets SET state = 'done', verdict = 'fixed', updated_at = ? WHERE project = ? AND key = ? AND batch_id = ? AND state = 'batched'")
      .run(run.now, run.project.key, key, run.batch.id);
    kv.del(run.db, triesKey(run, key));
  });
}

module.exports = { applyVerdict, askPo, conclude, giveDev, nextBatch, nextBatchAll, eachKey, finishFixed, closeWaits, waitStatusKey, owned, isIn, same, MAX_TRIES };
