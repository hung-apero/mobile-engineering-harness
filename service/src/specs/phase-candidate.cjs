const jobs = require('../jobs.cjs');
const results = require('../bugs/job-results.cjs');
const { recordWould } = require('../bugs/effects.cjs');
const { featureBranch, pushFeature, ensureDraftPr } = require('./publish-feature.cjs');
const { fixRound, onHold } = require('./phase-code-review.cjs');
const { stateOf, fresh } = require('./segment.cjs');
const { move, decide, once, park, findJob, nameOf } = require('./kit.cjs');
const { buildOf, saveBuild, batchIdOf, gitArgs, landingGit, state } = require('./build-kit.cjs');
const { trialNotes } = require('./trial-notes.cjs');

const UNKNOWN = 'không rõ Firebase đã nhận bản cài chưa, cần người kiểm rồi gửi tay nếu thiếu';
const keyOf = (run, name) => `${batchIdOf(run.spec)}#${name}-${run.spec.data.serial}`;

async function ensureStep(run, kind, name, extra) {
  const key = keyOf(run, name);
  const known = findJob(run.db, { project: run.project.key, kind, key });
  if (known) return known;
  const { candidate } = buildOf(run);
  const batchId = batchIdOf(run.spec);
  const { landing } = landingGit(run);
  const { tree } = await landing.versionWorktree(gitArgs(run, { batchId, sha: candidate.sha, reuse: true }));
  const payload = { batchId, worktree: tree, sha: candidate.sha, ...(await extra(landing, candidate)) };
  const { id } = jobs.enqueue(run.db, { project: run.project.key, kind, key, priority: 1, slots: 1, payload }, run.now);
  return jobs.getJob(run.db, id);
}

async function judged(run, kind, name, extra, judge) {
  const job = await ensureStep(run, kind, name, extra);
  const now = stateOf(job);
  if (now.type === 'waiting') return null;
  const result = now.type === 'parked' ? { broken: true, reason: job.parkReason } : await judge(run, job);
  return { ...result, job };
}

function broken(run, what, { reason, job }) {
  park(run, `${what}: ${reason}`, job.state === 'parked' ? { jobId: job.id } : {});
  return { stop: true };
}

async function gated(run) {
  const gate = await judged(run, 'gate', 'gate', async (landing, { start, sha }) => ({ changedFiles: await landing.changedFiles(gitArgs(run, { from: start, commits: [sha] })) }), results.judgeGateJob);
  if (!gate) return null;
  if (gate.broken) return broken(run, 'cổng không chạy được', gate);
  if (gate.ok) return gate;
  fixRound(run, `Cổng đỏ: ${gate.reason}`);
  return { stop: true };
}

async function built(run) {
  const build = await judged(run, 'build', 'build', async () => ({ distribute: false }), results.judgeBuildJob);
  if (!build) return null;
  if (build.broken) return broken(run, 'build không chạy được', build);
  if (build.ok) return build;
  decide(run, 'Q02', 'spec-build-red', { reason: build.reason });
  fixRound(run, `Build đỏ: ${build.reason}`);
  return { stop: true };
}

function prBody(run, text) {
  const notes = trialNotes(run.spec);
  const head = notes.length ? ['## Còn lệch hoặc chờ xác nhận', ...notes.map(note => `- ${note}`), ''] : [];
  return [...head, text, '', `dz-spec-${run.spec.id}`].join('\n');
}

async function publish(run) {
  const { candidate } = buildOf(run);
  const mode = run.live ? 'live' : 'dry';
  const branch = featureBranch({ project: run.project, id: run.spec.id });
  const prepared = await once(run, `handoff-${candidate.sha}`, async () => JSON.parse(await state(run, ['handoff', '--base', run.project.base], { headless: true })));
  await once(run, `${mode}-push-${candidate.sha}`, () => pushFeature(gitArgs(run, { branch, sha: candidate.sha })));
  return once(run, `${mode}-pr-${candidate.sha}`, () => ensureDraftPr(gitArgs(run, { branch, title: `${prepared.title}: ${nameOf(run.spec)}`, body: prBody(run, prepared.body), gh: run.ctx.bugs.gh })));
}

async function distribute(run) {
  const { sha } = buildOf(run).candidate;
  if (!run.live) {
    await once(run, `dry-distribute-${sha}`, () => {
      recordWould(run.ctx, run.project)('would', `firebase distribute ${sha}`);
      return { dryRun: true };
    });
    return { ok: true };
  }
  if (!run.project.commands?.distribute) {
    park(run, 'gửi bản cài không được: project chưa cấu hình commands.distribute');
    return { stop: true };
  }
  const sent = await judged(run, 'build', 'send', async () => ({ distribute: true }), results.judgeBuildJob);
  if (!sent || sent.ok) return sent;
  decide(run, 'Q04', 'spec-distribute-failed', { reason: sent.unknown ? UNKNOWN : sent.reason });
  park(run, `gửi bản cài không được: ${sent.unknown ? UNKNOWN : sent.reason}`);
  return { stop: true };
}

async function candidate(run) {
  const gate = await gated(run);
  if (!gate || gate.stop) return Boolean(gate);
  const build = await built(run);
  if (!build || build.stop) return Boolean(build);
  if (onHold(run)) return false;
  const pr = await publish(run);
  const sent = await distribute(run);
  if (!sent || sent.stop) return Boolean(sent);
  const { sha, n } = buildOf(run).candidate;
  const { versionName = null, versionCode = null } = build.apk;
  saveBuild(run, { published: { sha, n, live: run.live }, trial: { sha, pr: pr.url ?? null, versionName, versionCode, live: run.live, at: run.now } });
  decide(run, 'Q01', 'spec-trial-sent', { sha, pr: pr.url ?? null });
  move(run, 'po-trial', { data: fresh(run.spec, 'trial') });
  return true;
}

module.exports = { candidate };
