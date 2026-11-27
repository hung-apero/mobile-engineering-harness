const bugs = require('../bugs/store.cjs');
const kit = require('../bugs/phase-kit.cjs');
const { getEffect, effectId } = require('../bugs/effects.cjs');
const { fresh } = require('./segment.cjs');
const { move, decide } = require('./kit.cjs');
const { buildOf, saveBuild, gitArgs, landingGit } = require('./build-kit.cjs');

const RECHECK_MS = 15 * 60 * 1000;
const MAX_AGAIN = 3;

const resultOf = (run, batch, step) => getEffect(run.db, effectId(batch.id, null, step, batch.data.live))?.result ?? null;
const conflicted = (run, batch) => Boolean(resultOf(run, batch, 'merge-1')?.skipped?.some(item => item.code === 'conflict'));
const baseConflicted = (run, batch) => resultOf(run, batch, 'merge-1')?.conflictsWith === 'base';
const branchOf = run => bugs.getVersion(run.db, run.project.key, buildOf(run).version).branch;

function again(run, landing) {
  saveBuild(run, { landing });
  move(run, 'landing', { data: fresh(run.spec, 'landing') });
}

async function tipsOf(run) {
  const { workspace, landing } = landingGit(run);
  const { baseSha } = await workspace.ensureMirror(gitArgs(run));
  return { base: baseSha, tip: await landing.versionTip(gitArgs(run, { versionBranch: branchOf(run) })) };
}

async function waitForBase(run, batch) {
  decide(run, 'F04', 'spec-base-conflict', { batchId: batch.id, branch: branchOf(run) });
  again(run, { blocked: { ...(await tipsOf(run)), until: run.now + RECHECK_MS } });
}

const someoneLanding = run => bugs.listBatches(run.db, { project: run.project.key, version: buildOf(run).version, states: ['open', 'running'] })
  .some(batch => kit.LANDING.includes(batch.data.phase) || batch.data.landing === true);

async function stillBlocked(run) {
  const blocked = buildOf(run).landing?.blocked;
  if (!blocked) return false;
  if (run.now < blocked.until || someoneLanding(run)) return true;
  if (run.live) await landingGit(run).landing.adoptRemote(gitArgs(run, { versionBranch: branchOf(run) }));
  const now = await tipsOf(run);
  if (now.base !== blocked.base || now.tip !== blocked.tip) return false;
  saveBuild(run, { landing: { blocked: { ...blocked, until: run.now + RECHECK_MS } } });
  return true;
}

function retryAfterAdopt(run, batch) {
  const tries = (buildOf(run).landingTries ?? 0) + 1;
  if (resultOf(run, batch, 'adopt')?.ok !== true || tries > MAX_AGAIN) return false;
  decide(run, 'F04', 'spec-landing-again', { batchId: batch.id, tries });
  saveBuild(run, { landingTries: tries });
  again(run, null);
  return true;
}

module.exports = { conflicted, baseConflicted, waitForBase, stillBlocked, retryAfterAdopt, branchOf };
