const files = require('./repo-files.cjs');
const { checkRepo } = require('./wire.cjs');
const { runGit } = require('../bugs/git.cjs');
const { redact } = require('../redact.cjs');

const SHA = /^[0-9a-f]{40}$/;
const CHANGES = /^(?:changes|request[_ -]?changes|reject(?:ed)?|fail(?:ed)?)$/i;
const MAX_FINDINGS = 20;

const branchOf = spec => `dz/spec-${spec.id}`;
const text = (value, max = 300) => redact(String(value ?? '').replace(/[\p{C}\s]+/gu, ' ').trim()).slice(0, max).toWellFormed();

async function headOf(repo, git) {
  const found = await git(['symbolic-ref', '--quiet', 'HEAD'], { cwd: repo, okCodes: [0, 1] });
  return found.code === 0 ? found.stdout.trim().replace(/^refs\/heads\//, '') : null;
}

async function tipOf(repo, branch, git) {
  const found = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`], { cwd: repo, okCodes: [0, 1] });
  return found.code === 0 ? found.stdout.trim() : null;
}

async function ensureBranch(repo, branch, git = runGit) {
  await checkRepo(repo);
  if ((await headOf(repo, git)) === branch) return;
  const exists = await tipOf(repo, branch, git);
  await git(exists ? ['switch', '--quiet', branch] : ['switch', '--quiet', '-c', branch], { cwd: repo });
}

function progressOf(repo) {
  const plans = files.readJson(repo, 'progress.json')?.plans;
  if (!Array.isArray(plans)) return { done: 0, total: 0 };
  return { done: plans.filter(plan => plan?.status === 'done').length, total: plans.length };
}

function findingText(item) {
  if (typeof item === 'string') return text(item);
  if (item && typeof item === 'object') return text([item.file && `${item.file}${item.line ? `:${item.line}` : ''}`, item.text ?? item.message ?? item.title].filter(Boolean).join(' '));
  return '';
}

function readResult(repo) {
  const doc = files.readJson(repo, 'result.json');
  if (!doc || typeof doc.branch !== 'string' || typeof doc.commit !== 'string' || !SHA.test(doc.commit)) return null;
  const review = doc.review && typeof doc.review === 'object' ? doc.review : {};
  const findings = (Array.isArray(review.findings) ? review.findings : []).map(findingText).filter(Boolean).slice(0, MAX_FINDINGS);
  const plans = (Array.isArray(doc.plans) ? doc.plans : []).map(plan => text(typeof plan === 'string' ? plan : plan?.title ?? plan?.id, 200)).filter(Boolean);
  return { branch: doc.branch, commit: doc.commit, plans, review: { verdict: text(review.verdict, 40), findings } };
}

const wantsChanges = result => CHANGES.test(result.review.verdict);

async function contains(repo, commit, tip, git) {
  const found = await git(['merge-base', '--is-ancestor', commit, tip], { cwd: repo, okCodes: [0, 1] });
  return found.code === 0;
}

async function resultProblem(run, { later = false, git = runGit } = {}) {
  const { repo } = run.spec.data;
  const result = readResult(repo);
  if (!result) return 'result.json không đọc được';
  const branch = branchOf(run.spec);
  if (result.branch !== branch) return `result.json ghi nhánh ${text(result.branch, 80)}, cần ${branch}`;
  await checkRepo(repo);
  if ((await headOf(repo, git)) !== branch) return `bản clone không ở nhánh ${branch}`;
  const tip = await tipOf(repo, branch, git);
  if (tip === result.commit || (later && tip && (await contains(repo, result.commit, tip, git)))) return null;
  return `result.json ghi commit ${result.commit.slice(0, 12)} không phải đỉnh nhánh ${branch}`;
}

module.exports = { branchOf, ensureBranch, progressOf, readResult, wantsChanges, resultProblem };
