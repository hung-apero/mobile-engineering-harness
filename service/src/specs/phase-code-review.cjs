const fs = require('node:fs');
const path = require('node:path');
const jobs = require('../jobs.cjs');
const bugs = require('../bugs/store.cjs');
const files = require('./repo-files.cjs');
const { makeCandidate, FORBIDDEN, MAX_LINES } = require('./candidate.cjs');
const { readReview } = require('./feature-review.cjs');
const { addQuestions, holdsInstall, toBuilding, openItems, roleOf } = require('./provisional.cjs');
const { pendingChange, askChange, noteSelfChange } = require('./change.cjs');
const { fresh, keyOf, jobOf, again, stateOf } = require('./segment.cjs');
const { move, decide, park, nameOf } = require('./kit.cjs');
const { buildOf, saveBuild, saveNotes, batchIdOf, gitArgs, landingGit, sendBack, clip } = require('./build-kit.cjs');
const { resultProblem } = require('./build-result.cjs');

const HARD = ['forbidden', 'permission', 'secret'];
const describe = problems => problems.map(p => `${p.code}${p.file ? ` ${p.file}` : ''}: ${p.detail}`).join('; ');
const versionBranchOf = run => bugs.getVersion(run.db, run.project.key, buildOf(run).version)?.branch ?? `dz/release-${buildOf(run).version}`;

function fixRound(run, text, kind = 'review') {
  const field = kind === 'review' ? 'fixes' : 'checkFixes';
  const fixes = buildOf(run)[field] ?? 0;
  const max = run.ctx.rulesFor(run.project.key).rules.F01.fix_rounds;
  decide(run, 'F01', 'spec-fix', { kind, round: fixes + 1, text: clip(text, 500) });
  if (fixes >= max) return park(run, `sửa ${fixes} vòng vẫn chưa đạt: ${clip(text, 600)}`);
  sendBack(run, text, `fix-${run.spec.data.serial}`);
  saveBuild(run, { [field]: fixes + 1 });
  return toBuilding(run);
}

function onHold(run) {
  if (pendingChange(run.spec)) {
    askChange(run);
    return true;
  }
  return holdsInstall(run.spec);
}

const messageOf = run => `feat(${run.project.key}): ${clip(run.spec.title || 'tính năng', 100)}\n\ndz-spec-${run.spec.id}`;

async function buildCandidate(run) {
  const known = buildOf(run).candidate;
  const { serial, repo } = run.spec.data;
  if (known?.serial === serial) return known;
  await landingGit(run).workspace.ensureMirror(gitArgs(run));
  const made = await makeCandidate(gitArgs(run, {
    repo, id: run.spec.id, n: (known?.n ?? 0) + 1, prev: buildOf(run).published?.sha ?? null, versionBranch: versionBranchOf(run), message: messageOf(run),
  }));
  const candidate = { ...made, serial };
  saveBuild(run, { candidate });
  decide(run, 'F03', 'spec-candidate', { sha: candidate.sha, start: candidate.start, n: candidate.n });
  return candidate;
}

function writeSpecFile(run) {
  const dir = landingGit(run).landing.batchDir(gitArgs(run, { batchId: batchIdOf(run.spec) }));
  const file = path.join(dir, 'spec.md');
  const temp = `${file}.${process.pid}.tmp`;
  fs.rmSync(temp, { force: true });
  fs.writeFileSync(temp, files.latestSpec(run.spec.data.repo).markdown, { mode: 0o600, flag: 'wx' });
  fs.renameSync(temp, file);
  return file;
}

async function launch(run, candidate) {
  const { tree } = await landingGit(run).landing.versionWorktree(gitArgs(run, { batchId: batchIdOf(run.spec), name: 'review', sha: candidate.sha, localFiles: false }));
  const asked = openItems(run.spec).map(item => ({ qid: item.qid, role: roleOf(item), title: item.title }));
  const payload = { specId: run.spec.id, type: 'review', repo: tree, specFile: writeSpecFile(run), startSha: candidate.start, sha: candidate.sha, title: nameOf(run.spec), asked };
  jobs.enqueue(run.db, { project: run.project.key, kind: 'spec', key: keyOf(run.spec), priority: 1, slots: 1, payload }, run.now);
  return false;
}

async function start(run) {
  const problem = await resultProblem(run, { later: true });
  if (problem) {
    park(run, `bản clone không còn ở chỗ bàn giao: ${problem}`);
    return true;
  }
  noteSelfChange(run);
  if (onHold(run)) return false;
  const candidate = await buildCandidate(run);
  const { problems } = await landingGit(run).diffGuard.checkDiff(gitArgs(run, {
    from: candidate.start, to: candidate.sha, forbidden: [...(run.project.forbidden ?? []), ...FORBIDDEN], maxLines: MAX_LINES,
  }));
  const hard = problems.filter(p => HARD.includes(p.code));
  if (hard.length) {
    decide(run, 'F02', 'spec-diff-refused', { sha: candidate.sha, problems: describe(hard) });
    park(run, `code chạm vùng cấm hoặc lộ bí mật (F02): ${describe(hard)}`);
    return true;
  }
  if (problems.length) {
    fixRound(run, describe(problems), 'check');
    return true;
  }
  return launch(run, candidate);
}

async function settle(run, job) {
  const review = readReview(job);
  if (!review.ok) return again(run, `kết quả review không đọc được: ${review.error}`);
  decide(run, 'F03', 'spec-reviewed', { sha: job.payload.sha, verdict: review.verdict, findings: review.findings.length, needsPo: review.needsPo.length });
  if (review.needsPo.length) addQuestions(run, review.needsPo);
  if (review.verdict === 'changes') {
    const lines = [...review.forbidden, ...review.findings.filter(f => f.severity !== 'minor').map(f => `${f.severity} ${f.file}:${f.line} ${f.text}`)];
    return fixRound(run, `Reviewer yêu cầu sửa: ${lines.join('; ') || 'code chưa khớp spec'}`);
  }
  saveNotes(run, 'review', review.findings.map(f => `${f.file}:${f.line} ${f.text}`));
  return move(run, 'candidate', { data: fresh(run.spec, 'candidate') });
}

async function reviewing(run) {
  const job = jobOf(run);
  const now = stateOf(job);
  if (now.type === 'waiting') return false;
  if (now.type === 'missing') return start(run);
  if (now.type === 'parked') {
    park(run, now.job.parkReason ?? 'việc review bị gác', { jobId: now.job.id });
    return false;
  }
  await settle(run, now.job);
  return true;
}

module.exports = { reviewing, fixRound, onHold, versionBranchOf };
