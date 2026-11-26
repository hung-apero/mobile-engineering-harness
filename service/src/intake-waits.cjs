const kv = require('./kv.cjs');
const { openWait, resolveWait } = require('./pings.cjs');
const { record } = require('./decisions.cjs');

const KEY = 'intake-closed';
const LIMIT_MS = 30 * 60 * 1000;

function closeAll(db, state, now) {
  for (const id of Object.values(state.waits)) resolveWait(db, id, now);
  kv.del(db, KEY);
}

function syncIntakeWaits(ctx, projects, state, now) {
  const known = kv.get(ctx.db, KEY);
  if (state.open) {
    if (known) closeAll(ctx.db, known, now);
    return;
  }
  if (known && known.code !== state.code) closeAll(ctx.db, known, now);
  const current = known && known.code === state.code ? known : { code: state.code, since: now, waits: {} };
  if (now - current.since >= LIMIT_MS) {
    for (const project of projects.values()) {
      if (!project.schedulable || current.waits[project.key] !== undefined) continue;
      const subject = `Service không nhận việc mới quá 30 phút (${state.code})`;
      current.waits[project.key] = openWait(ctx.db, { project: project.key, role: 'dev', subject }, now);
      record(ctx.db, { project: project.key, code: state.code, ruleVersion: ctx.rulesFor(project.key).version, evidence: { since: current.since }, action: 'intake-closed-wait' }, now);
    }
  }
  kv.set(ctx.db, KEY, current, now);
}

module.exports = { syncIntakeWaits };
