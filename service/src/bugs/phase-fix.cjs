const results = require('./job-results.cjs');
const { applyVerdict, giveDev, nextBatch } = require('./outcome.cjs');
const { save, decideOnce, ensureJob, isWaiting, isBroken } = require('./phase-kit.cjs');

const MAX_NOTE = 4000;
const LEFT_OUT = 'Worker không trả kết quả cho bug này';
const REPLACED = 'Nhánh của bug này bị dùng lại cho bug khác';

function retryOrPark(run, error) {
  const { data } = run.batch;
  const { parseErrors, round, notes } = data;
  if (parseErrors >= 1) {
    save(run, { phase: 'parked', reason: `Kết quả sửa bug không đọc được: ${error}` });
    return true;
  }
  decideOnce(run, null, `parse-r${round}`, 'X08', 'retry-result', { error });
  const note = { key: data.todo[0], text: `Kết quả vòng trước không hợp lệ: ${error}. Kết thúc bằng đúng khối JSON theo schema.` };
  save(run, { parseErrors: parseErrors + 1, round: round + 1, notes: [...notes, note] });
  return true;
}

function groupLanes(tickets) {
  const lanes = new Map();
  for (const { key, branch, commit, rootCause, specRef } of tickets) {
    const lane = lanes.get(branch) ?? { branch, commit, keys: [], info: {}, state: 'pending' };
    if (lane.commit !== commit) lane.mixed = true;
    lane.keys.push(key);
    lane.info[key] = { rootCause, specRef };
    lanes.set(branch, lane);
  }
  return [...lanes.values()];
}

async function applyResults(run, { tickets, missing }) {
  const approved = [];
  for (const ticket of tickets) {
    if ((await applyVerdict(run, ticket)) === 'lane') approved.push(ticket);
  }
  for (const key of missing) await nextBatch(run, key, { code: 'F01', reason: LEFT_OUT });
  return groupLanes(approved);
}

async function dropReplaced(run, fresh) {
  const branches = new Set(fresh.map(l => l.branch));
  const taken = new Set(fresh.flatMap(l => l.keys));
  const replaced = run.batch.data.lanes.filter(l => branches.has(l.branch));
  for (const key of replaced.flatMap(l => l.keys).filter(k => !taken.has(k))) await nextBatch(run, key, { code: 'F01', reason: REPLACED });
  return run.batch.data.lanes.filter(l => !branches.has(l.branch));
}

async function fixing(run) {
  const { data } = run.batch;
  const job = ensureJob(run, {
    kind: 'bug', suffix: `r${data.round}`, slots: Math.min(2, data.todo.length), payload: results.bugPayload(run),
  });
  if (isWaiting(job)) return false;
  if (isBroken(job)) {
    save(run, { phase: 'parked', reason: `Việc sửa bug #${job.id} ${job.parkReason ?? 'lỗi'}` });
    return true;
  }
  const parsed = results.parseBugJob(run, job);
  if (!parsed.ok) return retryOrPark(run, parsed.error);
  const fresh = await applyResults(run, parsed);
  const lanes = [...await dropReplaced(run, fresh), ...fresh];
  decideOnce(run, null, `fixed-r${data.round}`, 'B04', 'fixed', { lanes: lanes.map(l => l.branch) });
  save(run, { lanes, notes: [], phase: lanes.length ? 'reviewing' : 'done' });
  return true;
}

async function fixAgain(run, problems) {
  const { data } = run.batch;
  const limit = run.rules.F01.fix_rounds;
  const failing = data.lanes.filter(l => problems.has(l.branch));
  const keys = failing.flatMap(l => l.keys);
  const lanes = data.lanes.filter(l => !problems.has(l.branch));
  if (data.fixRounds >= limit) {
    for (const lane of failing) {
      for (const key of lane.keys) await giveDev(run, key, { code: 'F01', reason: `Sửa ${limit} vòng vẫn trượt: ${problems.get(lane.branch)}` });
    }
    save(run, { lanes, toFix: [] });
    return false;
  }
  decideOnce(run, null, `again-r${data.round + 1}`, 'F01', 'fix-again', { keys });
  const notes = failing.flatMap(l => l.keys.map(key => ({ key, text: problems.get(l.branch).slice(0, MAX_NOTE) })));
  save(run, { lanes, notes, toFix: [], todo: keys, round: data.round + 1, fixRounds: data.fixRounds + 1, phase: 'fixing' });
  return true;
}

module.exports = { fixing, fixAgain };
