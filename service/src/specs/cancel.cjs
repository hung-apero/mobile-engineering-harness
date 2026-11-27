const jobs = require('../jobs.cjs');
const store = require('./store.cjs');
const { closeWaits } = require('./kit.cjs');
const { stopJob } = require('../bugs/cleanup.cjs');
const { record } = require('../decisions.cjs');
const { ruleVersionOf } = require('../bugs/effects.cjs');

const KINDS = ['spec', 'uidiff', 'explain'];
const LIVE = ['queued', 'starting', 'running'];
const REASON = 'spec đã huỷ';

function openJobs(db, spec) {
  return jobs.listJobs(db, { states: LIVE, project: spec.project })
    .filter(job => KINDS.includes(job.kind) && job.key.startsWith(`${spec.id}#`));
}

async function parkJobs(db, spec, now) {
  for (const job of openJobs(db, spec)) {
    await stopJob(job);
    db.prepare("UPDATE jobs SET state = 'parked', park_reason = ?, last_event_at = ?, slots_granted = 0 WHERE id = ? AND state = ?")
      .run(REASON, now, job.id, job.state);
  }
}

async function cancelSpec(ctx, id, now) {
  const spec = store.getSpec(ctx.db, id);
  if (spec.state === 'cancelled') return { id, from: spec.data.cancelledFrom, state: 'cancelled' };
  await parkJobs(ctx.db, spec, now);
  closeWaits(ctx.db, id, now);
  const next = store.transitionSpec(ctx.db, id, [spec.state], 'cancelled', now, { data: { cancelledFrom: spec.state } });
  if (!next) throw new Error(`spec #${id} vừa chuyển trạng thái, chạy lại lệnh`);
  record(ctx.db, { project: spec.project, code: 'OP01', ruleVersion: ruleVersionOf(ctx, spec.project), evidence: { specId: id, from: spec.state }, action: 'spec-cancelled' }, now);
  return { id, from: spec.state, state: 'cancelled' };
}

module.exports = { cancelSpec };
