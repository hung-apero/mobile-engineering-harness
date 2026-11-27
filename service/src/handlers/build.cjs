const path = require('node:path');
const { specDir, writeSpec, minutes } = require('../bugs/prompts-step-spec.cjs');
const { isolatedEnv, NO_FIREBASE } = require('../bugs/prompts-env.cjs');
const { checkSha, checkWorkDir, bad } = require('../bugs/prompts-data.cjs');
const { stepsOf, failure, missingStep } = require('../bugs/result-steps.cjs');
const { findApk } = require('../bugs/result-apk.cjs');
const { writeAdbWrapper, SERIAL } = require('../devices.cjs');
const { checkLock } = require('./spec.cjs');

const VERIFY = path.join(__dirname, '..', 'verify-tree.cjs');
const SMOKE = path.join(__dirname, '..', 'smoke-device.cjs');
const buildDir = (payload, options) => specDir(payload.smoke ? 'smoke' : 'build', payload, options);

function smokeStep({ smoke }, { dzHome, project, adb, deps }, cwd) {
  const { serial } = smoke;
  if (typeof serial !== 'string' || !SERIAL.test(serial) || (project.excludedDevices ?? []).includes(serial)) bad('serial');
  (deps?.checkLock ?? checkLock)(dzHome, smoke);
  const wrapper = writeAdbWrapper({ dzHome, serial, adb });
  const env = { ...NO_FIREBASE, ANDROID_SERIAL: serial, PATH: `${wrapper}${path.delimiter}${process.env.PATH}` };
  return { name: 'smoke', argv: [process.execPath, SMOKE, project.commands.apkGlob, project.package, serial], cwd, timeoutMs: minutes(10), retries: 0, env };
}

function prepare({ payload }, options) {
  const { dzHome, project } = options;
  const cwd = checkWorkDir(payload.worktree, 'worktree', { dzHome, project });
  const { commands } = project;
  const distribute = !payload.smoke && payload.distribute === true && project.live === true;
  if (distribute && !commands.distribute) throw new Error('project không có lệnh distribute');
  const verify = { name: 'verify', argv: [process.execPath, VERIFY, checkSha(payload.sha, 'sha')], cwd, timeoutMs: minutes(5), retries: 0, env: NO_FIREBASE };
  const steps = [verify, { name: 'assemble', argv: commands.assemble, cwd, timeoutMs: minutes(60), retries: 1, env: NO_FIREBASE }];
  if (payload.smoke) steps.push(smokeStep(payload, options, cwd));
  if (distribute) steps.push({ name: 'distribute', argv: commands.distribute, cwd, timeoutMs: minutes(30), retries: 0, once: true });
  return {
    command: writeSpec(buildDir(payload, { dzHome, project }), steps),
    cwd,
    env: isolatedEnv(dzHome, { keepFirebase: distribute }),
  };
}

async function judgeBuild(result, { worktree, apkGlob, sha, distribute = false, smoke = false }) {
  checkSha(sha, 'sha');
  const steps = stepsOf(result);
  if (steps.length === 0) return { ok: false, reason: 'không đọc được kết quả từng bước' };
  const failed = steps.find(step => !step.ok);
  if (failed?.name === 'verify') return { ok: false, reason: failure(failed).reason };
  if (failed?.name === 'smoke') return failure(failed);
  if (failed && failed.name !== 'distribute') return failure(failed);
  const missing = missingStep(steps, ['assemble', ...(smoke ? ['smoke'] : []), ...(distribute ? ['distribute'] : [])]);
  if (missing) return missing;
  const { apk, error } = await findApk({ worktree, apkGlob, sha });
  if (failed) return { ...failure(failed), ...(failed.unknown === true && { unknown: true }), ...(apk && { apk }) };
  return apk ? { ok: true, apk } : { ok: false, failedStep: 'assemble', reason: error };
}

module.exports = { prepare, judgeBuild, buildDir };
