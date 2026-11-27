const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { runGit } = require('../src/bugs/git.cjs');
const workspace = require('../src/bugs/workspace.cjs');

const ENV = {
  PATH: process.env.PATH, HOME: os.tmpdir(), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@localhost', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@localhost',
};
const g = (cwd, ...args) => execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function put(dir, files) {
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    if (content === null) {
      fs.rmSync(file);
      continue;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (content.symlinkTo) fs.symlinkSync(content.symlinkTo, file);
    else fs.writeFileSync(file, content);
  }
}

function commit(dir, files, message = 'change') {
  put(dir, files);
  g(dir, 'add', '-A');
  g(dir, 'commit', '-qm', message, '--allow-empty');
  return g(dir, 'rev-parse', 'HEAD');
}

const HARNESS_AGENTS = ['bug-fixer', 'bug-reviewer', 'bug-scout', 'ui-board-judge', 'architect', 'coder', 'qa', 'reviewer'];

const REAL_HARNESS = path.join(__dirname, '..', '..');
const INIT_FILES = ['skills/harness-init/scripts/detect-stack.sh', 'skills/harness-init/scripts/render-overlay.sh', 'skills/harness-init/scripts/validate-overlay.py', 'overlay.schema.yaml'];

function makeHarness(harness) {
  fs.mkdirSync(harness, { recursive: true });
  g(harness, 'init', '-q', '-b', 'main');
  return commit(harness, {
    ...Object.fromEntries(INIT_FILES.map(file => [file, fs.readFileSync(path.join(REAL_HARNESS, file), 'utf8')])),
    'skills/bug-fix/SKILL.md': 'x\n', 'skills/bug/SKILL.md': 'y\n', 'skills/feature/SKILL.md': 'f\n', 'skills/feature/scripts/headless_check.py': 'print()\n', 'skills/spec-clear/SKILL.md': 's\n', 'skills/README.md': 'z\n',
    ...Object.fromEntries(HARNESS_AGENTS.map(name => [`agents/${name}.md`, `${name}\n`])),
  });
}

function world(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dz-git-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dzHome = path.join(root, 'home');
  const github = path.join(root, 'github.git');
  const dev = path.join(root, 'dev');
  const harness = path.join(dzHome, 'harness');
  const checkout = path.join(dzHome, 'workspaces', 'AAP1', 'checkout');
  for (const dir of [dev, harness, checkout]) fs.mkdirSync(dir, { recursive: true });
  g(root, 'init', '-q', '--bare', '-b', 'develop', github);
  g(dev, 'init', '-q', '-b', 'develop');
  g(dev, 'remote', 'add', 'origin', github);
  commit(dev, { 'a.txt': 'a\n', 'b.txt': 'b\n', '.gitignore': 'local.properties\n' }, 'first');
  g(dev, 'push', '-q', 'origin', 'develop');
  const harnessCommit = makeHarness(harness);
  const project = { key: 'AAP1', repo: 'Apero/AAP1', base: 'develop', checkout, live: false, localFiles: [], harnessCommit, forbidden: [] };
  const records = [];
  const ctx = { dzHome, project, githubUrl: github, live: false, record: (code, text) => records.push([code, text]) };
  return { root, dzHome, github, dev, harness, checkout, project, records, ctx, mirror: path.join(dzHome, 'workspaces', 'AAP1', 'mirror.git') };
}

async function readyWorld(t) {
  const w = world(t);
  await workspace.ensureMirror(w.ctx);
  const { branch, sha } = await workspace.ensureVersionBranch({ ...w.ctx, version: '1.9.2' });
  const { repo, startSha } = await workspace.ensureClone({ ...w.ctx, batch: { id: 1, version: '1.9.2' } });
  const lane = (name, files) => {
    g(repo, 'checkout', '-q', '-B', name, startSha);
    const sha = commit(repo, files, name);
    g(repo, 'push', '-q', 'origin', `${sha}:refs/heads/${name}`);
    return sha;
  };
  const ref = name => g(w.mirror, 'rev-parse', `refs/heads/${name}`);
  const refs = () => g(w.mirror, 'for-each-ref', '--format=%(refname) %(objectname)');
  const file = (name, at = branch) => g(w.mirror, 'show', `${at}:${name}`);
  return { ...w, branch, startSha, baseSha: sha, repo, lane, ref, refs, file, merge: { ...w.ctx, versionBranch: branch, startSha } };
}

const gitBefore = (match, act) => async (args, options) => {
  if (args.includes(match)) act();
  return runGit(args, options);
};

module.exports = { g, put, commit, world, readyWorld, gitBefore, makeHarness };
