const { isWorking } = require('./work-hours.cjs');

const COMMAND_KINDS = ['gate', 'build'];
const SIDE_KINDS = ['explain'];
const RESERVED_KINDS = ['bug', 'review'];

const isCommandKind = kind => COMMAND_KINDS.includes(kind);
const sum = (jobs, pick) => jobs.reduce((total, j) => total + pick(j), 0);

function capacity(nowMs, limits) {
  return isWorking(nowMs) ? limits.code_agents_working : limits.code_agents_off;
}

function grantBuild(running, limits) {
  return running.filter(j => isCommandKind(j.kind)).length < limits.build ? 1 : 0;
}

function grant({ job, running, limits, now }) {
  if (isCommandKind(job.kind)) return grantBuild(running, limits);
  if (SIDE_KINDS.includes(job.kind)) return running.some(j => SIDE_KINDS.includes(j.kind)) ? 0 : 1;
  const agents = running.filter(j => !isCommandKind(j.kind) && !SIDE_KINDS.includes(j.kind));
  const free = capacity(now, limits) - sum(agents, j => j.slotsGranted);
  let allowed = free;
  if (job.kind === 'bug') {
    const bugs = agents.filter(j => j.kind === 'bug' && j.project === job.project);
    allowed = Math.min(free, limits.bugs_per_project - sum(bugs, j => j.slotsGranted));
  } else if (!RESERVED_KINDS.includes(job.kind)) {
    const holders = agents.filter(j => RESERVED_KINDS.includes(j.kind));
    allowed = free - Math.max(0, limits.reserved_for_bug - sum(holders, j => j.slotsGranted));
  }
  return Math.max(0, Math.min(job.slots, allowed));
}

module.exports = { capacity, grant, isCommandKind, COMMAND_KINDS };
