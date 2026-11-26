const fs = require('node:fs');
const path = require('node:path');
const jobs = require('../src/jobs.cjs');
const { mergeBatch } = require('../src/bugs/merge.cjs');
const { ensureMirror } = require('../src/bugs/workspace.cjs');
const { assess } = require('../src/bugs/release.cjs');
const { g, commit } = require('./bugs-git-fixtures.cjs');
const { setup, NOW } = require('./e2e-fixtures.cjs');

const steps = list => JSON.stringify({ steps: list });
const buildJob = s => jobs.listJobs(s.db, { project: 'AAP1' }).filter(job => job.kind === 'build').at(-1);

async function merged(t, options) {
  const s = await setup(t, { live: true, build: false, ...options });
  const sha = s.lane('fix/one', { 'one.txt': '1\n' });
  s.tip = (await mergeBatch({ ...s.merge, branches: [{ branch: 'fix/one', commit: sha }] })).sha;
  await s.addBuild(1);
  s.baseWork = content => {
    g(s.dev, 'pull', '-q', 'origin', 'develop');
    const done = commit(s.dev, content, 'work of another dev');
    g(s.dev, 'push', '-q', 'origin', 'HEAD:refs/heads/develop');
    return done;
  };
  s.mergeVersion = async (...flags) => {
    g(s.dev, 'pull', '-q', 'origin', 'develop');
    g(s.dev, 'fetch', '-q', s.mirror, s.branch);
    g(s.dev, 'merge', '-q', ...flags, 'FETCH_HEAD', '-m', 'Merge version');
    g(s.dev, 'push', '-q', 'origin', 'HEAD:refs/heads/develop');
    await ensureMirror({ dzHome: s.dzHome, project: s.project, githubUrl: s.github });
    return g(s.dev, 'rev-parse', 'HEAD');
  };
  s.finishBuild = ok => {
    const job = buildJob(s);
    if (ok) fs.writeFileSync(path.join(job.payload.worktree, 'app.apk'), `apk of ${job.payload.sha}`);
    const result = ok ? [{ name: 'verify', ok: true }, { name: 'assemble', ok: true }] : [{ name: 'verify', ok: true }, { name: 'assemble', ok: false, exitCode: 1, tail: 'hỏng' }];
    s.db.prepare("UPDATE jobs SET state = ?, result = ? WHERE id = ?").run(ok ? 'done' : 'failed', JSON.stringify({ ...JSON.parse(steps(result)), ...(!ok && { error: 'step_failed' }) }), job.id);
  };
  s.assess = () => assess(s.ctx, s.project, s.version(), NOW);
  return s;
}

module.exports = { merged, buildJob };
