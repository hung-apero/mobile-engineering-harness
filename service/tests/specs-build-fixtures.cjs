const fs = require('node:fs');
const path = require('node:path');
const { makeHome, fakeWorkers, writeScript, OK, NOW } = require('./service-fixtures.cjs');
const { g, commit } = require('./bugs-git-fixtures.cjs');
const { asked, clarified, put } = require('./specs-flow-fixtures.cjs');
const { tick } = require('../src/tick.cjs');
const jobs = require('../src/jobs.cjs');
const store = require('../src/specs/store.cjs');
const bugs = require('../src/bugs/store.cjs');
const { prepareSpecClone } = require('../src/specs/clone.cjs');
const { createFacade } = require('../src/specs/facade.cjs');
const commands = require('../src/spec-commands.cjs');
const S = require('../vendor/learn-app/lib/learn-app-state.cjs');

const VERSION = '1.9.2';
const SERIAL = 'emu-1';
const PLAN = id => `---\nid: ${id}\npriority: 1\ndepends: []\nfeatures: [${id.slice(3)}]\nscreens: [${id.slice(3)}-screen]\n---\n# Plan ${id}\n`;
const REVIEW_OK = { verdict: 'approve', specMatch: true, needsPo: [], forbidden: [], findings: [] };
const SMOKE = (result = 'pass', errors = '') => `# Smoke\nKết quả: ${result}\nMáy: ${SERIAL} · Pixel · 15\n\n## Đã kiểm\n- Màn: 1/1\n\n## Lỗi\n${errors}`;
const step = (name, ok = true) => ({ name, ok, exitCode: ok ? 0 : 1, signal: null, timedOut: false, attempts: 1, ms: 1, tail: ok ? '' : 'đỏ' });
const stepsEvent = list => ({ ...OK, ...(list.every(x => x.ok) ? {} : { subtype: 'error_during_execution', is_error: true }), result: JSON.stringify({ steps: list }) });

function editState(repo, change) {
  const state = S.readState(repo);
  change(state);
  S.writeState(repo, state);
}

function coded(repo, { files = { 'feature.txt': 'feature\n' }, plans = ['01-path'], features = [] } = {}) {
  put(repo, Object.fromEntries(plans.map(id => [`plans/${id}.md`, PLAN(id)])));
  commit(repo, files, 'learn-app: merge plan');
  editState(repo, state => {
    state.step = 'smoke';
    state.plans = Object.fromEntries(plans.map(id => [id, { status: 'merged', files: Object.keys(files) }]));
    if (features.length) state.features = features;
  });
}

function smoked(repo, report = SMOKE()) {
  put(repo, { 'smoke/report.md': report, ...(/^Kết quả: fail/m.test(report) ? { 'debts.md': '# Nợ\n- smoke: còn lỗi, xem smoke/report.md\n' } : {}) });
  editState(repo, state => { state.step = 'handoff'; });
}

function fakeDevices() {
  const devices = { free: [SERIAL], held: new Map(), log: [] };
  devices.releaseAll = async ({ prefix }) => {
    devices.log.push(`release ${prefix}`);
    for (const [serial, holder] of devices.held) if (holder.startsWith(prefix)) devices.held.delete(serial);
  };
  devices.pick = async () => devices.free.find(serial => !devices.held.has(serial)) ?? null;
  devices.acquire = async ({ holder, serial }) => {
    devices.held.set(serial, holder);
    return { serial, holder };
  };
  return devices;
}

function fakeAdbOnPath(t, root) {
  const bin = path.join(root, 'fake-bin');
  fs.mkdirSync(bin);
  writeScript(path.join(bin, 'adb'), 'exit 0');
  const before = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${before}`;
  t.after(() => { process.env.PATH = before; });
}

function setupBuild(t, { live = false, figma = 'none', commandsYaml = {}, project = {}, workers = true } = {}) {
  const h = makeHome(t);
  const github = path.join(h.root, 'github.git');
  const dev = path.join(h.root, 'dev');
  fs.mkdirSync(dev);
  g(h.root, 'init', '-q', '--bare', '-b', 'main', github);
  g(dev, 'init', '-q', '-b', 'main');
  g(dev, 'remote', 'add', 'origin', github);
  commit(dev, { 'app.txt': 'app\n', '.gitignore': 'local.properties\nout/\n' }, 'first');
  g(dev, 'push', '-q', 'origin', 'main');
  h.project('ABC1', {
    live, forbidden: ['billing/**'], commands: { compile: ['x'], unitTest: ['x'], assemble: ['x'], distribute: ['x'], apkGlob: 'out/*.apk', ...commandsYaml }, ...project,
  });
  fs.mkdirSync(path.join(h.dzHome, 'workspaces', 'ABC1'), { recursive: true });
  fs.writeFileSync(path.join(h.dzHome, 'workspaces', 'ABC1', 'local.properties'), 'sdk.dir=/x\n');
  fakeAdbOnPath(t, h.root);
  const ctx = h.context({ send: async () => ({ ok: true }) });
  const fake = workers ? fakeWorkers(ctx) : { calls: [], alive: new Map() };
  const s = { h, ctx, github, dev, now: NOW, ...fake, devices: fakeDevices(), ghCalls: [], prs: [], ghReply: null };
  ctx.bugs.githubUrl = github;
  ctx.bugs.gh = async args => {
    s.ghCalls.push(args);
    return { stdout: s.ghReply?.(args) ?? '[]' };
  };
  ctx.bugs.jira = async () => ({ search: async () => [], issue: async () => ({}), transitions: async () => [], versions: async () => [], close: async () => {} });
  ctx.handlerDeps = { checkLock: () => {} };
  Object.assign(ctx.specs, { devices: s.devices, prepareClone: args => prepareSpecClone({ ...args, githubUrl: github }), confluence: () => { throw new Error('không được gọi Confluence'); } });
  s.facade = createFacade(ctx);
  s.id = s.facade.newSpec({ project: 'ABC1', source: { type: 'pasted', text: '# [ABC1] Spec gốc\n\n## Path\nMàn path\n\n## Quiz\nMàn quiz, chờ PR #272 và nhánh `feat/clp-host-hooks`' }, figma, title: null }, NOW).id;
  return Object.assign(s, flow(s));
}

function flow(s) {
  const { ctx } = s;
  const spec = () => store.getSpec(ctx.db, s.id);
  const repo = () => spec().data.repo;
  const step1 = async (ms = 10000) => {
    s.now += ms;
    await tick(ctx, s.now);
    await Promise.all([ctx.specStepPending, ctx.bugStepPending]);
  };
  const running = kind => jobs.listJobs(ctx.db, { states: ['running'] }).filter(job => job.kind === kind);
  const until = async (check, label = '') => {
    for (let i = 0; i < 14; i++) {
      if (check()) return;
      await step1();
    }
    throw new Error(`chưa tới ${label}: ${JSON.stringify({ state: spec().state, parked: spec().data.parked, needs: spec().data.needs, build: spec().data.build })} ${JSON.stringify(jobs.listJobs(ctx.db).slice(-2))}`);
  };
  const finish = async (work, { kind = 'spec', event = OK } = {}) => {
    await until(() => running(kind).length === 1, `việc ${kind}`);
    const [job] = running(kind);
    work?.(repo(), job);
    fs.appendFileSync(job.logFile, `${JSON.stringify(typeof event === 'function' ? event(job) : event)}\n`);
    s.alive.clear();
    await step1();
    return job;
  };
  const apk = job => {
    const dir = path.join(job.payload.worktree, 'out');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'app.apk'), `apk ${job.payload.sha}`);
  };
  const api = {
    spec, repo, running, until, finish, tick: step1,
    state: name => until(() => spec().state === name, name),
    cmd: (...args) => commands.spec(ctx, args, s.now),
    toApproved: async () => {
      await finish(dir => {
        g(dir, 'checkout', '-q', '-b', 'learn-app/abc1');
        asked(dir);
      });
      s.facade.saveDraft(s.id, { qid: 'Q1', choice: 'B', text: '' }, 'po', s.now);
      s.facade.submit(s.id, 'po', s.now);
      await finish(dir => clarified(dir));
      const { sha } = s.facade.review(s.id);
      const out = await s.facade.approve(s.id, { sha, quote: 'Tôi duyệt' }, 'po', s.now);
      if (!out.ok) throw new Error(out.error);
    },
    toBuilding: async () => {
      await api.toApproved();
      await api.cmd('build', String(s.id), '--version', VERSION);
      await until(() => running('spec').length === 1, 'việc build');
    },
    code: options => finish(dir => coded(dir, options)),
    smoke: report => finish(dir => smoked(dir, report)),
    review: (result = REVIEW_OK) => finish(null, { event: { ...OK, result: '', structured_output: result } }),
    gate: (ok = true) => finish(null, { kind: 'gate', event: stepsEvent([step('compile'), step('unitTest', ok)]) }),
    build: (ok = true) => finish((dir, job) => ok && apk(job), { kind: 'build', event: job => stepsEvent([step('verify'), step('assemble', ok), ...(ok && job.payload.distribute ? [step('distribute')] : [])]) }),
    toTrial: async (options = {}) => {
      await api.code(options.code);
      await api.smoke(options.smoke);
      await api.review(options.review);
      await api.gate();
      await api.build();
      await api.state('po-trial');
      return spec().data.build.trial.sha;
    },
    approveTrial: sha => s.facade.approve(s.id, { sha, quote: 'Tôi duyệt bản cài' }, 'po', s.now),
    waits: () => ctx.db.prepare("SELECT role, subject, link FROM waits WHERE state = 'open' ORDER BY id").all(),
    decisions: action => ctx.db.prepare('SELECT action, code, evidence FROM decisions WHERE action = ? ORDER BY id').all(action).map(row => ({ ...row, evidence: JSON.parse(row.evidence) })),
    would: () => ctx.db.prepare("SELECT evidence FROM decisions WHERE action = 'would' ORDER BY id").all().map(row => JSON.parse(row.evidence).text),
    batches: () => bugs.listBatches(ctx.db, { project: 'ABC1' }),
    mirror: path.join(s.h.dzHome, 'workspaces', 'ABC1', 'mirror.git'),
    tree: sha => g(path.join(s.h.dzHome, 'workspaces', 'ABC1', 'mirror.git'), 'ls-tree', '-r', '--name-only', sha).split('\n'),
    log: () => JSON.parse(JSON.stringify(jobs.listJobs(ctx.db).map(job => `${job.kind} ${job.key} ${job.state}`))),
  };
  return api;
}

module.exports = { setupBuild, coded, smoked, editState, put, commit, g, step, stepsEvent, SMOKE, REVIEW_OK, VERSION, SERIAL, PLAN, OK };
