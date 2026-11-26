const store = require('./store.cjs');
const { recordWould } = require('../bugs/effects.cjs');
const { patch, openOnce, closeWaits, nameOf } = require('./kit.cjs');
const { addRework } = require('./rework.cjs');
const { redact } = require('../redact.cjs');

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

const clip = (text, max = 1500) => redact(String(text ?? '').replace(/[\p{C}\s]+/gu, ' ').trim()).slice(0, max).replace(/^-+/, '').toWellFormed();

function sendBack(run, reason, key) {
  addRework(run, { key, reason });
  return true;
}

const devWait = (run, name, text) => openOnce(run, name, 'dev', `Spec ${nameOf(run.spec)}: ${text}`);

module.exports = {
  BUILD_STATES, isBuilding, buildOf, saveBuild, saveNotes, batchIdOf, idle, gitArgs, landingGit, clip, sendBack, devWait, closeWaits,
};
