const files = require('./repo-files.cjs');
const { runGh } = require('../bugs/git.cjs');
const { move, park, decide, closeWaits } = require('./kit.cjs');
const { buildOf, saveBuild, learnState, devWait } = require('./build-kit.cjs');
const { fresh } = require('./segment.cjs');
const { firstLine } = require('../redact.cjs');

const RECHECK_MS = 15 * 60 * 1000;
const REPO = /^\w[\w.-]*\/\w[\w.-]*$/;
const BRANCH = /^[A-Za-z0-9](?:[\w./-]{0,198}[\w-])?$/;
const PR = /^[1-9]\d{0,6}$/;
const MAX_ITEMS = 20;

class PrereqError extends Error {}

const badBranch = name => !BRANCH.test(name) || name.includes('..') || name.includes('//') || name.endsWith('.lock');

function parsePr(value, repo) {
  const [, owner, number] = String(value).match(/^(?:(.+)#)?(\d+)$/) ?? [];
  const target = owner ?? repo;
  if (!PR.test(number ?? '') || !REPO.test(target)) throw new PrereqError(`--pr phải là số hoặc owner/repo#số: ${value}`);
  return { type: 'pr', repo: target, number: Number(number) };
}

function parseBranch(value) {
  const at = String(value).indexOf(':');
  const [repo, branch] = [String(value).slice(0, at), String(value).slice(at + 1)];
  if (at < 1 || !REPO.test(repo) || badBranch(branch)) throw new PrereqError(`--branch phải có dạng owner/repo:nhánh: ${value}`);
  return { type: 'branch', repo, branch };
}

const label = item => (item.type === 'pr' ? `PR #${item.number} (${item.repo})` : `nhánh ${item.branch} (${item.repo})`);

function parsePrereqs({ prs, branches }, repo) {
  const items = [...prs.map(value => parsePr(value, repo)), ...branches.map(parseBranch)];
  const unique = [...new Map(items.map(item => [label(item), item])).values()];
  if (unique.length > MAX_ITEMS) throw new PrereqError(`tối đa ${MAX_ITEMS} điều kiện trước`);
  return unique;
}

function suggestPrereqs(text, repo) {
  const found = [];
  const body = String(text ?? '');
  for (const [, owner, number] of body.matchAll(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d{1,7})/g)) found.push(`--pr ${owner}#${number}`);
  for (const [, number] of body.matchAll(/\b(?:PR|pull request)\s*#?(\d{1,7})\b/gi)) found.push(`--pr ${repo}#${number}`);
  for (const [, branch] of body.matchAll(/(?:nhánh|branch)\s+[`"'“]?([A-Za-z0-9][\w.-]*\/[\w./-]*[\w-])/giu)) if (!badBranch(branch)) found.push(`--branch <owner/repo>:${branch}`);
  return [...new Set(found)].slice(0, MAX_ITEMS);
}

function suggestionsOf(spec, repo) {
  try {
    const texts = [files.latestSpec(spec.data.repo)?.markdown, files.read(spec.data.repo, 'inputs/spec-v1.md')];
    return suggestPrereqs(texts.filter(Boolean).join('\n'), repo);
  } catch {
    return [];
  }
}

async function checkPr(gh, item) {
  const { stdout } = await gh(['pr', 'view', String(item.number), '--repo', item.repo, '--json', 'state,mergedAt']);
  const pr = JSON.parse(stdout);
  return pr.state === 'MERGED' ? null : `chưa merge (${firstLine(String(pr.state ?? 'không rõ')).toLowerCase()})`;
}

async function checkBranch(gh, item) {
  const merged = await gh(['pr', 'list', '--repo', item.repo, '--head', item.branch, '--state', 'merged', '--limit', '1', '--json', 'number']);
  if (JSON.parse(merged.stdout || '[]').length) return null;
  const view = JSON.parse((await gh(['repo', 'view', item.repo, '--json', 'defaultBranchRef'])).stdout);
  const base = view.defaultBranchRef?.name;
  if (badBranch(String(base ?? ''))) return 'không biết nhánh gốc của repo';
  const { stdout } = await gh(['api', '--method', 'GET', `repos/${item.repo}/compare/${base.split('/').map(encodeURIComponent).join('/')}...${item.branch.split('/').map(encodeURIComponent).join('/')}`, '--jq', '.ahead_by']);
  return stdout.trim() === '0' ? null : `chưa vào ${base}`;
}

async function checkOne(gh, item) {
  try {
    return item.type === 'pr' ? await checkPr(gh, item) : await checkBranch(gh, item);
  } catch (error) {
    return `không kiểm được: ${firstLine(error)}`;
  }
}

async function unmet(run) {
  const gh = run.ctx.bugs.gh ?? runGh;
  const missing = [];
  for (const item of run.spec.data.prerequisites ?? []) {
    const reason = await checkOne(gh, item);
    if (reason) missing.push(`${label(item)} ${reason}`);
  }
  return missing;
}

function approvalProblem(run) {
  const { repo } = run.spec.data;
  if (learnState(repo)?.gates?.g1?.status !== 'approved') return 'cổng 1 không còn ở trạng thái đã duyệt';
  return files.latestSpec(repo)?.sha === run.spec.approvedSha ? null : 'bản spec mới nhất không phải bản PO đã duyệt';
}

const sameList = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function waitingPrereq(run) {
  const problem = approvalProblem(run);
  if (problem) {
    park(run, problem);
    return true;
  }
  const { checkedAt = 0, missing: known = [], asked } = buildOf(run);
  const list = run.spec.data.prerequisites ?? [];
  if (sameList(asked, list) && run.now - checkedAt < RECHECK_MS) return false;
  const missing = await unmet(run);
  saveBuild(run, { checkedAt: run.now, missing, asked: list });
  if (!sameList(missing, known)) closeWaits(run.db, run.spec.id, run.now, 'prereq');
  if (missing.length) {
    if (!sameList(missing, known)) decide(run, 'X08', 'spec-waiting-prereq', { missing });
    devWait(run, 'prereq', `chờ điều kiện trước khi code: ${missing.join('; ')}`);
    return false;
  }
  decide(run, 'F03', 'spec-prereq-met', { prerequisites: list.map(label), version: buildOf(run).version });
  move(run, 'building', { data: fresh(run.spec, 'build') });
  return true;
}

module.exports = { parsePrereqs, suggestionsOf, suggestPrereqs, waitingPrereq, label, PrereqError, RECHECK_MS };
