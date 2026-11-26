const jobs = require('../jobs.cjs');
const files = require('./repo-files.cjs');
const { patch, decide, findJob, park } = require('./kit.cjs');
const { writeRework, reworkOf } = require('./rework.cjs');

const MAX_TRIES = 2;
const MAX_REASON = 500;
const WAITING = ['queued', 'starting', 'running'];
const NAMES = {
  asking: 'ask', clarifying: 'clarify', building: 'build', smoking: 'smoke', uidiff: 'uidiff', reviewing: 'review', candidate: 'candidate', landing: 'landing',
};
const LEARN_SEGMENTS = { smoke: 'build' };

const fresh = (spec, name, tries = 1) => {
  const serial = (spec.data.serial ?? 0) + 1;
  return { serial, segment: { name, serial, tries } };
};

const keyOf = spec => `${spec.id}#${spec.data.segment.name}-${spec.data.segment.serial}`;
const jobOf = run => findJob(run.db, { project: run.project.key, kind: 'spec', key: keyOf(run.spec) });

function writeConfig(run) {
  const { repo, app, figmaUrl, segment, notes } = run.spec.data;
  const rework = reworkOf(run.spec).map(item => item.file);
  writeRework(run);
  const config = { spec: 'inputs/spec-v1.md', figma: figmaUrl ? { url: figmaUrl } : null, app, case: 'existing', segment: LEARN_SEGMENTS[segment.name] ?? segment.name, ...(notes && { notes }), ...(rework.length && { rework }) };
  files.write(repo, 'inputs/headless.json', `${JSON.stringify(config, null, 1)}\n`);
  files.remove(repo, 'headless-blocked.json');
}

function launch(run, { slots = 1, extra = {} } = {}) {
  const { repo, figmaUrl, segment } = run.spec.data;
  writeConfig(run);
  const rework = reworkOf(run.spec);
  const payload = { specId: run.spec.id, segment: segment.name, repo, figma: Boolean(figmaUrl), ...(rework.length && { rework }), ...extra };
  jobs.enqueue(run.db, { project: run.project.key, kind: 'spec', key: keyOf(run.spec), priority: 1, slots, payload }, run.now);
}

function again(run, reason, { progressed = false } = {}) {
  const { segment } = run.spec.data;
  const short = String(reason).slice(0, MAX_REASON);
  const tries = progressed ? 0 : segment.tries;
  if (tries >= MAX_TRIES) {
    park(run, `đoạn ${segment.name} dừng giữa chừng ${tries} lần: ${short}`);
    return;
  }
  decide(run, 'X02', 'spec-segment-restarted', { segment: segment.name, reason: short });
  patch(run, fresh(run.spec, segment.name, tries + 1));
}

const state = run => stateOf(jobOf(run));

function stateOf(job) {
  if (!job) return { type: 'missing' };
  if (WAITING.includes(job.state)) return { type: 'waiting' };
  if (job.state === 'parked') return { type: 'parked', job };
  return { type: 'ended', job, error: job.state === 'failed' ? job.result?.error ?? 'worker lỗi' : null };
}

module.exports = { NAMES, fresh, keyOf, jobOf, launch, again, state, stateOf };
