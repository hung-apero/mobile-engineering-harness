const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const bugs = require('../src/bugs/store.cjs');
const { setupBuild, coded, commit, g, VERSION } = require('./specs-build-fixtures.cjs');

const BRANCH = `dz/release-${VERSION}`;
const LANDING = ['merging', 'gating', 'building', 'publishing', 'distributing', 'delivering'];

function bugLane(s, files, n = 1) {
  const clone = `${s.h.root}/bug-${n}`;
  const branch = `fix/bug-${n}-1`;
  g(s.h.root, 'clone', '-q', s.github, clone);
  const sha = commit(clone, files, 'fix: bug');
  g(clone, 'push', '-q', s.mirror, `${sha}:refs/heads/${branch}`);
  if (!g(s.mirror, 'for-each-ref', `refs/heads/${BRANCH}`)) g(s.mirror, 'update-ref', `refs/heads/${BRANCH}`, 'refs/heads/main');
  bugs.ensureVersion(s.ctx.db, { project: 'ABC1', version: VERSION, now: s.now });
  const data = { phase: 'reviewing', live: false, round: 1, fixRounds: 0, parseErrors: 0, reviews: 0, lanes: [{ branch, commit: sha, keys: [], info: {}, state: 'approved' }], notes: [], kept: {}, seen: {}, todo: [], startSha: g(s.mirror, 'rev-parse', 'refs/heads/main') };
  s.ctx.db.prepare("INSERT INTO batches (project, version, kind, state, keys, data, opened_at, updated_at) VALUES ('ABC1', ?, 'highest', 'running', '[]', ?, ?, ?)").run(VERSION, JSON.stringify(data), s.now, s.now);
}

const tip = s => g(s.mirror, 'rev-parse', `refs/heads/${BRANCH}`);
const inLanding = s => s.batches().filter(batch => batch.state === 'running' && LANDING.includes(batch.data.phase));

async function drain(s, done) {
  for (let i = 0; i < 60 && !done(); i++) {
    assert.ok(inLanding(s).length <= 1, 'hai đợt cùng gộp');
    if (s.running('gate').length) await s.gate();
    else if (s.running('build').length) await (s.running('build')[0].payload.smoke ? s.smoke() : s.build());
    else await s.tick();
  }
  assert.ok(done(), JSON.stringify([s.spec().state, s.spec().data.parked, s.batches().map(b => [b.state, b.data.phase])]));
}

async function toLanding(t, { files = { 'feature.txt': 'feature\n' }, ...options } = {}) {
  const s = setupBuild(t, options);
  await s.toBuilding();
  const sha = await s.toTrial({ code: { files } });
  await s.approveTrial(sha);
  return Object.assign(s, { sha });
}

function withGh(s) {
  s.prs = [];
  s.ghReply = args => {
    if (args[1] === 'list') return JSON.stringify(s.prs.filter(pr => pr.head === args[args.indexOf('--head') + 1]));
    if (args[1] === 'create') s.prs.push({ number: s.prs.length + 1, url: `https://github.com/apero/demo-app/pull/${s.prs.length + 1}`, isDraft: args.includes('--draft'), head: args[args.indexOf('--head') + 1] });
    return '[]';
  };
  return s;
}

const lastRework = s => {
  const [, name] = s.calls.at(-1).args.at(-1).match(/\.harness-run\/(inputs\/rework-\d+\.md)(?![^]*rework-)/);
  return fs.readFileSync(path.join(s.repo(), '.harness-run', name), 'utf8');
};

function solveConflict(s, text) {
  return s.finish(repo => {
    assert.match(lastRework(s), new RegExp(`git fetch origin ${BRANCH}[^]*git merge FETCH_HEAD`));
    g(repo, 'fetch', '-q', s.mirror, BRANCH);
    const merge = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'merge', '-q', 'FETCH_HEAD'], { cwd: repo });
    assert.notEqual(merge.status, 0);
    commit(repo, { 'app.txt': text }, 'merge');
    coded(repo, { files: { 'note.txt': 'x\n' } });
  });
}

module.exports = { BRANCH, bugLane, tip, inLanding, drain, toLanding, withGh, lastRework, solveConflict };
