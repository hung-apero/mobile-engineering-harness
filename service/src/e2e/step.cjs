const fs = require('node:fs');
const path = require('node:path');
const jobs = require('../jobs.cjs');
const kv = require('../kv.cjs');
const { isPaused } = require('../health.cjs');
const { clearParked } = require('../blocks.cjs');
const { firstLine } = require('../redact.cjs');
const store = require('../bugs/store.cjs');
const { adoptDry } = require('../bugs/dry-release-waits.cjs');
const { isClosed } = require('../bugs/closing.cjs');
const { e2eRoot, realDir, buildFor, listBuilds, sha256Of } = require('./builds.cjs');
const { readInputs, mayRun } = require('./inputs.cjs');
const { judgeE2e } = require('./result.cjs');
const { fileTickets } = require('./tickets.cjs');
const { lockDevice, rememberApp, freeDevice, prefixOf } = require('./device.cjs');
const { queueReleaseBuild, settleReleaseBuild } = require('./release-build.cjs');
const { clearJournal } = require('./journal.cjs');
const { load, save, versionsWithRun, decide, setWait, versionTip, usable, MAX_FAILED_ROUNDS } = require('./state.cjs');

const RETRY_MS = 60 * 60 * 1000;
const SETTLE_RETRY_MS = 5 * 60 * 1000;
const MAX_BLOCKED = 2;
const WAITING = ['queued', 'starting', 'running'];

const isOpen = (ctx, project, version) => store.getVersion(ctx.db, project.key, version)?.state === 'open';

function closeParked(ctx, job, now) {
  if (job.state !== 'parked') return;
  ctx.db.prepare("UPDATE jobs SET state = 'failed', result = ?, finished_at = NULL, slots_granted = 0 WHERE id = ? AND state = 'parked'")
    .run(JSON.stringify({ error: 'e2e_closed' }), job.id);
  clearParked(ctx.db, job.id, now);
}

function waitQa(ctx, project, version, state, now) {
  const subject = `E2E bản ${version} còn lỗi sau ${Math.max(state.failedRounds, 1)} vòng: QA chọn sửa tiếp hoặc chấp nhận (dz release e2e ${project.key} ${version} accept|continue --by <tên>) (S06)`;
  if (state.waits.qa === undefined) decide(ctx, project, 'S06', 'ask-qa', { version, rounds: state.failedRounds }, now);
  setWait(ctx, project, state, 'qa', true, { role: 'qa', subject }, now);
}

function noteBlocked(ctx, project, version, state, outcome, now) {
  const count = (state.blocked?.tree === state.run.tree ? state.blocked.count : 0) + 1;
  state.blocked = { tree: state.run.tree, count, until: now + RETRY_MS };
  decide(ctx, project, 'S06', 'e2e-blocked', { version, reason: outcome.reason, count }, now);
  if (count >= MAX_BLOCKED && isOpen(ctx, project, version)) setWait(ctx, project, state, 'blocked', true, { role: 'dev', subject: `E2E bản ${version} không chạy được ${count} lần: ${firstLine(outcome.reason)}` }, now);
}

async function noteOutcome(ctx, project, version, state, outcome, now) {
  const { tree, sha, jobId, build } = state.run;
  const open = isOpen(ctx, project, version);
  const tickets = open && outcome.failures.length ? await fileTickets(ctx, project, version, build, outcome.failures, now) : [];
  state.result = { tree, sha, jobId, status: outcome.status, failures: outcome.failures, incomplete: outcome.incomplete, total: outcome.total, tickets, at: now };
  state.blocked = null;
  setWait(ctx, project, state, 'blocked', false, {}, now);
  if (outcome.status === 'pass') {
    state.failedRounds = 0;
    setWait(ctx, project, state, 'qa', false, {}, now);
    return decide(ctx, project, 'S06', 'e2e-pass', { version, tree, total: outcome.total }, now);
  }
  state.failedRounds += 1;
  decide(ctx, project, 'S06', 'e2e-fail', { version, tree, failures: outcome.failures.map(f => f.id).slice(0, 20), incomplete: outcome.incomplete.slice(0, 20), tickets }, now);
  if (open && (state.failedRounds >= MAX_FAILED_ROUNDS || outcome.failures.length === 0)) waitQa(ctx, project, version, state, now);
}

async function outcomeFor(state, job) {
  const outcome = job ? judgeE2e(job) : { status: 'blocked', reason: 'mất việc E2E' };
  if (outcome.status === 'blocked' || (await sha256Of(state.run.build.apk)) === state.run.build.sha256) return outcome;
  return { status: 'blocked', reason: 'APK đã đổi trong lúc chạy E2E' };
}

async function settleOne(ctx, project, version, now) {
  const state = load(ctx.db, project.key, version);
  const job = jobs.getJob(ctx.db, state.run.jobId);
  if ((job && WAITING.includes(job.state)) || now < (state.run.settleAt ?? 0)) return false;
  if (job) closeParked(ctx, job, now);
  save(ctx.db, project.key, version, { ...state, run: { ...state.run, settleAt: now + SETTLE_RETRY_MS } }, now);
  if (job?.payload?.root) await rememberApp(ctx, project, { ...state.run, root: job.payload.root }, now);
  await freeDevice(ctx, project, version);
  const outcome = await outcomeFor(state, job);
  if (outcome.status === 'blocked') noteBlocked(ctx, project, version, state, outcome, now);
  else await noteOutcome(ctx, project, version, state, outcome, now);
  state.run = null;
  save(ctx.db, project.key, version, state, now);
  return true;
}

async function settleRuns(ctx, project, now) {
  const settled = [];
  for (const version of versionsWithRun(ctx.db, project.key)) {
    const state = load(ctx.db, project.key, version);
    const built = state.build?.jobId ? await settleReleaseBuild(ctx, project, version, state, now) : false;
    const done = state.run ? await settleOne(ctx, project, version, now) : false;
    if (built || done) settled.push(version);
  }
  return settled;
}

function mayStart(ctx, project, version, assessed, state, tree, now) {
  if (state.run || isPaused(ctx.db, project.key) || !isClosed(ctx.db, project.key, version.version)) return false;
  if (!assessed?.conditions.slice(1, 5).every(c => c.ok === true)) return false;
  if (usable(state.result, tree) || state.waits.qa !== undefined) return false;
  const { blocked } = state;
  return !(blocked && blocked.tree === tree && (blocked.count >= MAX_BLOCKED || now < blocked.until));
}

async function startE2e(ctx, project, version, assessed, now) {
  const name = version.version;
  if (listBuilds(ctx.db, project.key, name).length === 0) return false;
  const state = load(ctx.db, project.key, name);
  const before = JSON.stringify(state.waits);
  adoptDry(ctx, project, state, now);
  if (JSON.stringify(state.waits) !== before) save(ctx.db, project.key, name, state, now);
  const tip = await versionTip(ctx, project, version);
  if (!tip || !mayStart(ctx, project, version, assessed, state, tip.tree, now) || !mayRun(ctx.dzHome, project)) return false;
  const inputs = readInputs(ctx, project);
  setWait(ctx, project, state, 'inputs', Boolean(inputs.missing), { role: 'dev', subject: `E2E bản ${name} chưa chạy được, thiếu: ${inputs.missing?.join('; ')}` }, now);
  if (inputs.missing) {
    save(ctx.db, project.key, name, state, now);
    return false;
  }
  const build = buildFor(ctx.db, project.key, name, tip.tree);
  if (!build) {
    save(ctx.db, project.key, name, state, now);
    await queueReleaseBuild(ctx, project, name, state, tip, now);
    return false;
  }
  const lock = await lockDevice(ctx, project, name, inputs);
  if (lock.reason && state.waits.device === undefined) decide(ctx, project, 'F05', 'e2e-no-device', { version: name, reason: lock.reason }, now);
  setWait(ctx, project, state, 'device', Boolean(lock.reason), { role: 'dev', subject: `Thiếu thiết bị chạy E2E bản ${name} (F05): ${lock.reason}` }, now);
  if (lock.reason) {
    save(ctx.db, project.key, name, state, now);
    return false;
  }
  const root = realDir(path.join(e2eRoot({ dzHome: ctx.dzHome, project, version: name }), 'app'));
  fs.mkdirSync(path.join(root, '.android-app'), { recursive: true });
  clearJournal(root);
  state.runs += 1;
  const { testCases, storeApk, phase, reinstall } = inputs;
  const payload = { type: 'e2e', version: name, sha: tip.sha, tree: tip.tree, root, apk: build.apk, apkSha256: build.sha256, testCases, storeApk, phase, reinstall, serial: lock.serial, holder: lock.holder };
  kv.transaction(ctx.db, () => {
    const { lastInsertRowid } = ctx.db.prepare("INSERT INTO jobs (project, kind, key, priority, slots, created_at, payload) VALUES (?, 'e2e', ?, 1, 1, ?, ?)")
      .run(project.key, `${name}#${state.runs}`, now, JSON.stringify(payload));
    state.run = { jobId: Number(lastInsertRowid), sha: tip.sha, tree: tip.tree, serial: lock.serial, clean: lock.clean === true, build };
    save(ctx.db, project.key, name, state, now);
  });
  decide(ctx, project, 'S06', 'e2e-queued', { version: name, tree: tip.tree, serial: lock.serial, run: state.runs }, now);
  return true;
}

module.exports = { settleRuns, startE2e, prefixOf };
