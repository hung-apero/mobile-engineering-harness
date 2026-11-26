const jobs = require('../jobs.cjs');
const { start, read } = require('./phase-read.cjs');
const { advance } = require('./phase-segment.cjs');
const { quiz } = require('./phase-quiz.cjs');
const { review, approved, commentDone } = require('./phase-review.cjs');
const { waitingPrereq } = require('./prereq.cjs');
const { advanceBuild } = require('./phase-build.cjs');
const { smoking, smokeKey } = require('./phase-smoke.cjs');
const { uidiff } = require('./phase-uidiff.cjs');
const { reviewing } = require('./phase-code-review.cjs');
const { candidate } = require('./phase-candidate.cjs');
const { poTrial } = require('./phase-trial.cjs');
const { landing } = require('./phase-landing.cjs');
const { settleRound, applyAnswers } = require('./provisional.cjs');
const { askChange, applyChange } = require('./change.cjs');
const { BUILD_STATES, idle: noJobs } = require('./build-kit.cjs');
const { keyOf } = require('./segment.cjs');
const { move, closeWaits, findJob } = require('./kit.cjs');

const OWN_JOB = ['building', 'smoking', 'uidiff', 'reviewing'];
const OPEN = ['queued', 'starting', 'running', 'done'];

function parked(run) {
  const { parked: held } = run.spec.data;
  if (!held?.jobId || !OPEN.includes(jobs.getJob(run.db, held.jobId)?.state)) return false;
  move(run, held.from, { data: { parked: null } });
  closeWaits(run.db, run.spec.id, run.now, 'parked');
  return true;
}

const PHASES = {
  new: start, reading: read, asking: advance, clarifying: advance, quiz, review, approved, parked,
  'waiting-prereq': waitingPrereq, building: advanceBuild, smoking, uidiff, reviewing, candidate,
  'po-trial': poTrial, landing,
};
const STATES = Object.keys(PHASES);

const idle = (spec, project) => spec.state === 'approved' && (commentDone(spec, project.live === true) || spec.source.type !== 'url');

function unsettled({ db, project, spec }) {
  if (!OWN_JOB.includes(spec.state)) return false;
  if (spec.state === 'smoking' && findJob(db, { project: project.key, kind: 'build', key: smokeKey(spec) })) return true;
  return ['spec', 'uidiff'].some(kind => findJob(db, { project: project.key, kind, key: keyOf(spec) }));
}

async function beforeBuild(run) {
  if (!BUILD_STATES.includes(run.spec.state) || run.spec.state === 'landing') return false;
  settleRound(run);
  askChange(run);
  if (!noJobs(run) || unsettled(run)) return false;
  return (await applyChange(run)) || applyAnswers(run);
}

async function advanceSpec(run) {
  if (await beforeBuild(run)) return true;
  const phase = PHASES[run.spec.state];
  return phase ? (await phase(run)) === true : false;
}

module.exports = { advanceSpec, STATES, idle };
