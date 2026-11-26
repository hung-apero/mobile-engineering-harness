const { gitOf, gitArgs } = require('./phase-kit.cjs');

const MAX_COMMITS = 30;
const FORBIDDEN = ['forbidden', 'permission', 'secret'];
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

const describe = problems => problems.map(p => `${p.code}${p.file ? ` ${p.file}` : ''}: ${p.detail}`).join('; ');

async function secretInHistory(run, commits) {
  const { diffGuard } = gitOf(run);
  for (const { sha, parent } of commits) {
    const { problems } = await diffGuard.checkDiff(gitArgs(run, { from: parent ?? EMPTY_TREE, to: sha }));
    const found = problems.filter(p => p.code === 'secret' || p.local);
    if (found.length) return `commit ${sha.slice(0, 12)}: ${describe(found)}`;
  }
  return null;
}

async function checkLane(run, lane) {
  const { landing, diffGuard } = gitOf(run);
  const { startSha } = run.batch.data;
  if (lane.mixed) return { kind: 'fix', text: 'một nhánh có hai commit khác nhau' };
  const state = await landing.laneState(gitArgs(run, { branch: lane.branch, commit: lane.commit, startSha }));
  if (!state.ok) return { kind: 'fix', text: state.reason };
  const { problems } = await diffGuard.checkDiff(gitArgs(run, { from: startSha, to: lane.commit }));
  const hard = problems.filter(p => FORBIDDEN.includes(p.code));
  if (hard.length) return { kind: 'forbidden', text: describe(hard) };
  if (state.commits.length > MAX_COMMITS) return { kind: 'forbidden', text: `nhánh có ${state.commits.length} commit, quá ${MAX_COMMITS} nên không kiểm hết lịch sử` };
  const leaked = await secretInHistory(run, state.commits);
  if (leaked) return { kind: 'forbidden', text: leaked };
  return problems.length ? { kind: 'fix', text: describe(problems) } : { kind: 'ok' };
}

module.exports = { checkLane, MAX_COMMITS };
