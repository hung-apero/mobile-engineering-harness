const files = require('./repo-files.cjs');
const store = require('./store.cjs');
const { recordWould } = require('../bugs/effects.cjs');
const { patch, openOnce, closeWaits, nameOf } = require('./kit.cjs');
const { addRework } = require('./rework.cjs');
const { firstLine, redact } = require('../redact.cjs');

const BUILD_STATES = ['waiting-prereq', 'building', 'smoking', 'uidiff', 'reviewing', 'candidate', 'po-trial', 'landing'];
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

function sendBack(run, reason, key) {
  addRework(run, { key, reason });
  return true;
}

const devWait = (run, name, text) => openOnce(run, name, 'dev', `Spec ${nameOf(run.spec)}: ${text}`);

module.exports = {
  BUILD_STATES, isBuilding, buildOf, saveBuild, saveNotes, learnState, batchIdOf, idle, gitArgs, landingGit, state, clip, sendBack, devWait, closeWaits,
};
