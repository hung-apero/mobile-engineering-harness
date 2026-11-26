const path = require('node:path');
const { specDir, writeSpec, minutes } = require('../bugs/prompts-step-spec.cjs');
const { isolatedEnv, NO_FIREBASE } = require('../bugs/prompts-env.cjs');
const { checkSha, checkWorkDir } = require('../bugs/prompts-data.cjs');
const { stepsOf, failure, missingStep } = require('../bugs/result-steps.cjs');
const { findApk } = require('../bugs/result-apk.cjs');

const VERIFY = path.join(__dirname, '..', 'verify-tree.cjs');
const buildDir = (payload, options) => specDir('build', payload, options);

function prepare({ payload }, { dzHome, project }) {
  const cwd = checkWorkDir(payload.worktree, 'worktree', { dzHome, project });
  const { commands } = project;
  const distribute = payload.distribute === true && project.live === true;
  if (distribute && !commands.distribute) throw new Error('project không có lệnh distribute');
  const verify = { name: 'verify', argv: [process.execPath, VERIFY, checkSha(payload.sha, 'sha')], cwd, timeoutMs: minutes(5), retries: 0, env: NO_FIREBASE };
  const steps = [verify, { name: 'assemble', argv: commands.assemble, cwd, timeoutMs: minutes(60), retries: 1, env: NO_FIREBASE }];
  if (distribute) steps.push({ name: 'distribute', argv: commands.distribute, cwd, timeoutMs: minutes(30), retries: 0, once: true });
  return {
    command: writeSpec(buildDir(payload, { dzHome, project }), steps),
    cwd,
    env: isolatedEnv(dzHome, { keepFirebase: distribute }),
  };
}

async function judgeBuild(result, { worktree, apkGlob, sha, distribute = false }) {
  checkSha(sha, 'sha');
  const steps = stepsOf(result);
  if (steps.length === 0) return { ok: false, reason: 'không đọc được kết quả từng bước' };
  const failed = steps.find(step => !step.ok);
  if (failed?.name === 'verify') return { ok: false, reason: failure(failed).reason };
  if (failed && failed.name !== 'distribute') return failure(failed);
  const missing = missingStep(steps, distribute ? ['assemble', 'distribute'] : ['assemble']);
  if (missing) return missing;
  const { apk, error } = await findApk({ worktree, apkGlob, sha });
  if (failed) return { ...failure(failed), ...(failed.unknown === true && { unknown: true }), ...(apk && { apk }) };
  return apk ? { ok: true, apk } : { ok: false, failedStep: 'assemble', reason: error };
}

module.exports = { prepare, judgeBuild, buildDir };
