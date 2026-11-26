const files = require('./repo-files.cjs');
const store = require('./store.cjs');
const { readPlans } = require('../../vendor/learn-app/lib/looper-parse.cjs');
const { recordWould } = require('../bugs/effects.cjs');
const { patch, once, openOnce, closeWaits, park, nameOf } = require('./kit.cjs');
const { addRework } = require('./rework.cjs');
const { firstLine, redact } = require('../redact.cjs');

const BUILD_STATES = ['waiting-prereq', 'building', 'provisional', 'smoking', 'uidiff', 'reviewing', 'candidate', 'po-trial', 'landing'];
const ACTIVE = ['queued', 'starting', 'running'];
const EMPTY = { version: null, fixes: 0, uidiff: { round: 1 }, notes: {}, candidate: null, trial: null };

const buildOf = run => ({ ...EMPTY, ...run.spec.data.build });

function saveBuild(run, part) {
  const fresh = store.getSpec(run.db, run.spec.id);
  patch(run, { build: { ...EMPTY, ...fresh.data.build, ...part } });
}

const saveNotes = (run, name, lines) => saveBuild(run, { notes: { ...buildOf(run).notes, [name]: lines } });

const isBuilding = spec => BUILD_STATES.includes(spec.state)
  || (['parked', 'needs-input'].includes(spec.state) && BUILD_STATES.includes((spec.state === 'parked' ? spec.data.parked : spec.data.needs)?.from));

const learnState = repo => files.readJson(repo, 'state.json');

function plansOf(repo) {
  try {
    return readPlans(repo).filter(plan => plan.id);
  } catch {
    return [];
  }
}

const batchIdOf = spec => `spec-${spec.id}`;

function busyJobs(run) {
  const rows = run.db.prepare(`SELECT kind, key FROM jobs WHERE project = ? AND state IN (${ACTIVE.map(() => '?').join(', ')})`).all(run.project.key, ...ACTIVE);
  return rows.filter(({ kind, key }) => (['spec', 'uidiff'].includes(kind) ? key.startsWith(`${run.spec.id}#`) : key.startsWith(`${batchIdOf(run.spec)}#`)));
}

const idle = run => busyJobs(run).length === 0;

const gitArgs = (run, extra = {}) => ({
  dzHome: run.ctx.dzHome, project: run.project, githubUrl: run.ctx.bugs.githubUrl, live: run.live, record: recordWould(run.ctx, run.project), ...extra,
});

const landingGit = run => run.ctx.bugs.git;

async function state(run, args, options) {
  const out = await run.ctx.specs.runState(run.project, run.spec.data.repo, args, options);
  if (out.code !== 0) throw Object.assign(new Error(firstLine(out.stderr || out.stdout || `${args[0]} trả mã ${out.code}`)), { code: 'STATE_CLI' });
  return out.stdout;
}

const clip = (text, max = 1500) => redact(String(text ?? '').replace(/[\p{C}\s]+/gu, ' ').trim()).slice(0, max).replace(/^-+/, '').toWellFormed();

async function backTo(run, step, plans, reason) {
  const [first, ...rest] = plans;
  const reopen = plan => state(run, ['reopen', '--plan', plan, '--reason', reason, '--by-service']);
  if (['smoke', 'handoff'].includes(step)) await state(run, ['back', '--to', 'coding', '--plan', first, '--reason', reason, '--by-service']);
  else if (['planning', 'coding'].includes(step)) await reopen(first);
  else return;
  for (const plan of rest) await reopen(plan);
}

async function sendBack(run, plans, reason, key) {
  const known = plansOf(run.spec.data.repo).map(plan => plan.id);
  const wanted = [...new Set(plans)].filter(id => known.includes(id));
  const target = wanted.length ? wanted : known.slice(-1);
  try {
    await once(run, `back-${key}`, async () => {
      if (target.length) await backTo(run, learnState(run.spec.data.repo)?.step, target, clip(reason));
      return { plans: target };
    });
    addRework(run, { key, plans: target, reason });
    return true;
  } catch (error) {
    if (error.code !== 'STATE_CLI') throw error;
    park(run, `không quay lại bước code được: ${firstLine(error)}`);
    return false;
  }
}

function planOfFiles(repo, names) {
  const owners = new Map();
  for (const [id, plan] of Object.entries(learnState(repo)?.plans ?? {})) {
    for (const file of plan?.files ?? []) owners.set(file, id);
  }
  return [...new Set(names.map(name => owners.get(name)).filter(Boolean))];
}

function planOfFeature(repo, feature) {
  return plansOf(repo).find(plan => plan.features.includes(feature))?.id ?? null;
}

const devWait = (run, name, text) => openOnce(run, name, 'dev', `Spec ${nameOf(run.spec)}: ${text}`);

module.exports = {
  BUILD_STATES, isBuilding, buildOf, saveBuild, saveNotes, learnState, plansOf, batchIdOf, idle, gitArgs, landingGit, state, clip, sendBack,
  planOfFiles, planOfFeature, devWait, closeWaits,
};
