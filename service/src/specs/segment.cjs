const jobs = require('../jobs.cjs');
const files = require('./repo-files.cjs');
const { patch, decide, findJob, park } = require('./kit.cjs');
const { writeRework, reworkOf } = require('./rework.cjs');
const { hashText } = require('../text-hash.cjs');
const { branchOf } = require('./build-result.cjs');

const MAX_TRIES = 2;
const MAX_REASON = 500;
const WAITING = ['queued', 'starting', 'running'];
const NAMES = {
  asking: 'ask', clarifying: 'clarify', building: 'build', smoking: 'smoke', uidiff: 'uidiff', reviewing: 'review', candidate: 'candidate', landing: 'landing',
};

const fresh = (spec, name, tries = 1) => {
  const serial = (spec.data.serial ?? 0) + 1;
  return { serial, segment: { name, serial, tries } };
};

const keyOf = spec => `${spec.id}#${spec.data.segment.name}-${spec.data.segment.serial}`;
const jobOf = run => findJob(run.db, { project: run.project.key, kind: 'spec', key: keyOf(run.spec) });

function writeConfig(run, slots) {
  const { repo, app, figmaUrl, segment, notes } = run.spec.data;
  const rework = reworkOf(run.spec).map(item => item.file);
  writeRework(run);
  const build = segment.name === 'build' ? { slots, branch: branchOf(run.spec) } : {};
  const config = { spec: 'inputs/spec-v1.md', figma: figmaUrl ? { url: figmaUrl } : null, app, case: 'existing', segment: segment.name, ...(notes && { notes }), ...(rework.length && { rework }), ...build };
  files.write(repo, 'inputs/headless.json', `${JSON.stringify(config, null, 1)}\n`);
  files.remove(repo, 'blocked.json');
  files.remove(repo, 'headless-blocked.json');
  if (!run.spec.approvedSha) files.remove(repo, 'inputs/approval.json');
}

function forged({ repo, v1Sha, rawSha }) {
  const expected = v1Sha ?? rawSha;
  return Boolean(expected) && hashText(files.read(repo, 'inputs/spec-v1.md') ?? '') !== expected;
}

function launch(run, { slots = 1, extra = {} } = {}) {
  const { repo, figmaUrl, segment } = run.spec.data;
  if (forged(run.spec.data)) return park(run, 'worker đã sửa .harness-run/inputs/spec-v1.md, không chạy tiếp trên bản này; dz spec cancel rồi gửi lại spec');
  writeConfig(run, slots);
  const rework = reworkOf(run.spec);
  const branch = segment.name === 'build' ? { branch: branchOf(run.spec) } : {};
  const payload = { specId: run.spec.id, segment: segment.name, repo, figma: Boolean(figmaUrl), ...(rework.length && { rework }), ...branch, ...extra };
  patch(run, { segment: { ...run.spec.data.segment, inputsSha: files.inputsSha(repo) } });
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
