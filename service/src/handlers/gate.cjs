const { specDir, writeSpec, minutes } = require('../bugs/prompts-step-spec.cjs');
const { isolatedEnv } = require('../bugs/prompts-env.cjs');
const { bad, checkWorkDir } = require('../bugs/prompts-data.cjs');
const { stepsOf, failure, missingStep, mentioned, stepLog } = require('../bugs/result-steps.cjs');

const STEPS = [['compile', 45], ['unitTest', 60], ['lint', 30]];
const REQUIRED = ['compile', 'unitTest'];

const gateDir = (payload, options) => specDir('gate', payload, options);

function prepare({ payload }, { dzHome, project }) {
  const cwd = checkWorkDir(payload.worktree, 'worktree', { dzHome, project });
  if (!Array.isArray(payload.changedFiles) || !payload.changedFiles.every(file => typeof file === 'string')) bad('changedFiles');
  const steps = STEPS.filter(([name]) => project.commands[name])
    .map(([name, limit]) => ({ name, argv: project.commands[name], cwd, timeoutMs: minutes(limit), retries: 0 }));
  return { command: writeSpec(gateDir(payload, { dzHome, project }), steps), cwd, env: isolatedEnv(dzHome) };
}

function judgeLint(step, steps, changedFiles, dir) {
  if (step.timedOut || !Number.isInteger(step.exitCode)) return failure(step);
  const log = stepLog(dir, steps, 'lint');
  if (log === null) return failure(step, 'không có log đầy đủ để đối chiếu');
  const token = mentioned(log, changedFiles);
  if (token) return failure(step, `báo lỗi ở file trong diff: ${token}`);
  return { ok: true, note: 'lint đỏ nhưng không nhắc tới file nào trong diff' };
}

function judgeGate(result, changedFiles, { dir } = {}) {
  const steps = stepsOf(result);
  if (steps.length === 0) return { ok: false, reason: 'không đọc được kết quả từng bước' };
  const failed = steps.find(step => !step.ok);
  if (failed && failed.name !== 'lint') return failure(failed);
  const missing = missingStep(steps, REQUIRED);
  if (missing) return missing;
  return failed ? judgeLint(failed, steps, changedFiles, dir) : { ok: true };
}

module.exports = { prepare, judgeGate, gateDir };
