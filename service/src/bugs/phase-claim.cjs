const kv = require('../kv.cjs');
const store = require('./store.cjs');
const { getEffect } = require('./effects.cjs');
const { toIssue, OWN_LABEL } = require('./issue-view.cjs');
const { oneLine } = require('./comment-text.cjs');
const { giveDev, closeWaits, eachKey, owned, isIn, same } = require('./outcome.cjs');
const { save, decide, decideOnce, effect, idOf, jiraOf, gitOf, gitArgs, branchOf, verifiedSha } = require('./phase-kit.cjs');

const claimKey = (run, key) => `bug-claim:${run.project.key}:${key}`;

const assigneeOf = raw => JSON.stringify(raw.assignee ?? null);

function claimBatch(run, patch = {}) {
  const data = { phase: 'claiming', live: run.live, round: 1, fixRounds: 0, parseErrors: 0, reviews: 0, lanes: [], notes: [], kept: {}, seen: {}, ...patch };
  const claimed = store.transitionBatch(run.db, run.batch.id, 'open', 'running', run.now, { ...run.batch.data, ...data });
  if (!claimed) return false;
  run.batch = claimed;
  return true;
}

function isOurs(run, raw, key, started) {
  if (started) return assigneeOf(raw) === run.batch.data.seen[key]?.assignee;
  return (raw.labels ?? []).includes(OWN_LABEL) && kv.get(run.db, claimKey(run, key));
}

function dropReason(run, raw, key, started) {
  const issue = toIssue(raw);
  const { waiting, inProgress } = run.project.jiraStatus;
  if (issue.labels.includes('human-only')) return 'ticket gắn human-only';
  if (isIn(waiting, issue.status)) return null;
  return same(issue.status, inProgress) && isOurs(run, raw, key, started) ? null : `ticket đang ở ${oneLine(issue.status)}`;
}

async function canStart(run, jira, key, raw) {
  const { inProgress } = run.project.jiraStatus;
  if (same(toIssue(raw).status, inProgress)) return true;
  return (await jira.transitions(key)).some(t => same(t.to_status, inProgress) || same(t.name, inProgress));
}

async function claimTicket(run, jira, key) {
  const { inProgress } = run.project.jiraStatus;
  const known = getEffect(run.db, idOf(run, key, 'claim'))?.state;
  if (known !== 'done') {
    const started = known === 'started';
    const raw = await jira.issue(key);
    const reason = dropReason(run, raw, key, started);
    const { key: _, status, priority, ...seen } = toIssue(raw);
    if (!started || isIn(run.project.jiraStatus.waiting, status)) save(run, { seen: { ...run.batch.data.seen, [key]: { ...seen, assignee: assigneeOf(raw) } } });
    if (reason) {
      decideOnce(run, key, 'claim', 'B02', 'skipped', { reason });
      store.setTicketState(run.db, run.project.key, key, 'batched', 'skipped', run.now);
      return false;
    }
    if (!(await canStart(run, jira, key, raw))) {
      await giveDev(run, key, { code: 'X08', reason: `Jira không cho chuyển sang ${inProgress}` });
      return false;
    }
    if (run.live || kv.get(run.db, claimKey(run, key)) === null) kv.set(run.db, claimKey(run, key), run.batch.id, run.now);
  }
  await effect(run, key, 'claim', () => jira.transition(key, inProgress));
  await effect(run, key, 'label', () => jira.addLabels(key, [OWN_LABEL]));
  closeWaits(run, key);
  return true;
}

async function claiming(run) {
  const jira = await jiraOf(run);
  await eachKey(run, run.batch.keys, async key => {
    if (run.batch.data.kept[key] !== undefined || !owned(run, key)) return;
    const kept = await claimTicket(run, jira, key);
    save(run, { kept: { ...run.batch.data.kept, [key]: kept } });
  });
  const todo = run.batch.keys.filter(key => run.batch.data.kept[key] && owned(run, key));
  if (todo.length === 0) {
    decide(run, 'B02', 'batch-empty');
    save(run, { phase: 'done' });
    return true;
  }
  const { workspace } = gitOf(run);
  const { version, id } = run.batch;
  const branch = branchOf(run);
  await workspace.ensureMirror(gitArgs(run));
  await workspace.ensureVersionBranch(gitArgs(run, { version, branch }));
  const { repo, startSha } = await workspace.ensureClone(gitArgs(run, { batch: { id, version, branch }, sha: verifiedSha(run) ?? undefined }));
  decide(run, 'B01', 'claimed', { keys: todo, startSha });
  save(run, { phase: 'fixing', todo, repo, startSha });
  return true;
}

module.exports = { claimBatch, claiming, claimKey };
