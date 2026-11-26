const { ensureMirror } = require('../bugs/workspace.cjs');
const { runGit, checkBase } = require('../bugs/git.cjs');
const { firstLine } = require('../redact.cjs');
const { gitArgs, devWait } = require('./build-kit.cjs');
const { patch } = require('./kit.cjs');
const { startBuild, versionClosed, AUTO_WAIT } = require('./start-build.cjs');

const GRADLE_FILES = ['app/build.gradle.kts', 'app/build.gradle'];
const VERSION_LINE = /^\s*(?:val\s+appVersionName\s*=|versionName\s*=?)\s*["'](\d+\.\d+\.\d+)["']/m;
const RETRY_MS = 15 * 60 * 1000;

const versionOfGradle = text => String(text ?? '').match(VERSION_LINE)?.[1] ?? null;

function nextFeatureVersion(current, closed) {
  const [major, minor] = current.split('.').map(Number);
  let next = minor + 1;
  while (closed(`${major}.${next}.0`)) next += 1;
  return `${major}.${next}.0`;
}

async function appVersion(run) {
  const { mirror } = await ensureMirror(gitArgs(run));
  const base = checkBase(run.project.base);
  for (const file of GRADLE_FILES) {
    const out = await runGit(['show', `refs/heads/${base}:${file}`], { gitDir: mirror, okCodes: [0, 128] });
    const version = out.code === 0 ? versionOfGradle(out.stdout) : null;
    if (version) return version;
  }
  return null;
}

function hold(run, reason) {
  patch(run, { autoBuild: { at: run.now + RETRY_MS, reason } });
  devWait(run, AUTO_WAIT, `không tự chọn được bản để code (${reason}); chọn bằng dz spec build ${run.spec.id} --version <bản>`);
  return false;
}

async function autoBuild(run) {
  if ((run.spec.data.autoBuild?.at ?? 0) > run.now) return false;
  let current;
  try {
    current = await appVersion(run);
  } catch (error) {
    return hold(run, `không đọc được nhánh ${run.project.base}: ${firstLine(error)}`);
  }
  if (!current) return hold(run, `không thấy versionName x.y.z trong ${GRADLE_FILES.join(' hoặc ')}`);
  const version = nextFeatureVersion(current, candidate => versionClosed(run.db, run.project.key, candidate));
  const { next, problem } = startBuild(run.ctx, run.spec, version, run.now, { auto: true, from: current, live: run.live });
  if (problem) return hold(run, problem);
  run.spec = next;
  return true;
}

module.exports = { autoBuild, nextFeatureVersion, versionOfGradle };
