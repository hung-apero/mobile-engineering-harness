const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { g, commit, world } = require('./bugs-git-fixtures.cjs');
const { memDb, issue } = require('./bugs-fixtures.cjs');
const { createFakeJira } = require('./fixtures/fake-jira.cjs');
const { createJira } = require('../src/bugs/jira.cjs');
const { recordWould } = require('../src/bugs/effects.cjs');
const { intake, planBatches } = require('../src/bugs/intake.cjs');
const { recordBuildSent, recordPoll } = require('../src/bugs/polling.cjs');
const { advanceBatch } = require('../src/bugs/batch-machine.cjs');
const { toIssue } = require('../src/bugs/issue-view.cjs');
const store = require('../src/bugs/store.cjs');
const jobs = require('../src/jobs.cjs');

const DEFAULTS = YAML.parse(fs.readFileSync(path.join(__dirname, '..', 'rules', 'default.yaml'), 'utf8'));
const START = Date.parse('2026-11-25T10:00:00+07:00');
const VERSION = '1.9.2';
const TRANSITIONS = ['To Do', 'In Progress', 'Resolved'].map((name, i) => ({ id: String(i + 1), name, to_status: name }));
const BRANCH = `dz/release-${VERSION}`;
const step = (name, ok = true) => ({ name, ok, exitCode: ok ? 0 : 1, signal: null, timedOut: false, attempts: 1, ms: 1, tail: ok ? '' : 'đỏ' });
const approve = ({ branch }) => ({ branch, verdict: 'approve', specMatch: true, needsPo: [], reversesIntentional: [], forbidden: [], findings: [] });

function wrapAll(module, name, hooks) {
  return Object.fromEntries(Object.entries(module).map(([fn, real]) => [fn, typeof real !== 'function' ? real : async (...args) => {
    const result = await hooks.around(`${name}.${fn}`, () => real(...args), args);
    return result;
  }]));
}

function setup(t, { live = true, keys = ['AAP1-1'], commands = {}, issues = {}, kinds = {} } = {}) {
  const w = world(t);
  const db = memDb();
  const calls = [];
  const s = { ...w, db, calls, now: START, boom: null, before: {}, kinds, prs: [], freeGb: 500 };
  s.project = {
    ...w.project, live,
    jiraStatus: { waiting: ['To Do', 'Reopened'], inProgress: 'In Progress', resolved: 'Resolved', reopened: 'Reopened', done: ['Closed'] },
    commands: { compile: ['x'], unitTest: ['x'], assemble: ['x'], distribute: ['x'], apkGlob: 'out/*.apk', ...commands },
  };
  s.hooks = {
    around: async (name, fn, args) => {
      await s.before[name]?.(...args);
      const result = await fn();
      calls.push(name);
      if (s.boom === name) {
        s.boom = null;
        throw new Error(`crash sau ${name}`);
      }
      return result;
    },
  };
  s.fake = createFakeJira({ issues: Object.fromEntries(keys.map(key => [key, { status: 'To Do', transitions: TRANSITIONS, assignee: { displayName: 'Dev' }, ...issues[key] }])) });
  const ctx = { db, dzHome: w.dzHome, rulesFor: () => ({ ...DEFAULTS, version: 'v1' }), log: () => {}, freeGb: () => s.freeGb };
  ctx.now = () => s.now;
  s.setLive = value => {
    s.project.live = value;
    s.jira = wrapAll(createJira({ configFile: '/none', live: value, record: recordWould(ctx, s.project), connect: s.fake.connect, timeoutMs: 500 }), 'jira', s.hooks);
  };
  const git = {};
  for (const name of ['workspace', 'merge', 'landing', 'diffGuard']) {
    const file = name === 'diffGuard' ? 'diff-guard' : name;
    git[name] = wrapAll(require(`../src/bugs/${file}.cjs`), name, s.hooks);
  }
  git.landing.batchDir = require('../src/bugs/landing.cjs').batchDir;
  git.workspace.versionBranch = require('../src/bugs/workspace.cjs').versionBranch;
  const cleanup = wrapAll(require('../src/bugs/cleanup.cjs'), 'cleanup', s.hooks);
  ctx.bugs = { jira: async () => s.jira, git, githubUrl: w.github, gh: (...args) => fakeGh(s, ...args), cleanup };
  s.setLive(live);
  s.ctx = ctx;
  s.mirror = path.join(w.dzHome, 'workspaces', 'AAP1', 'mirror.git');
  s.repo = id => path.join(w.dzHome, 'workspaces', 'AAP1', 'batches', String(id), 'repo');
  s.ref = (name, dir = s.mirror) => g(dir, 'rev-parse', `refs/heads/${name}`);
  return Object.assign(s, api(s));
}

async function fakeGh(s, args) {
  s.calls.push(`gh.${args[1]}`);
  if (args[1] === 'list') return { stdout: JSON.stringify(s.prs) };
  s.prs.push({ number: 1, url: 'https://github.com/Apero/AAP1/pull/1', isDraft: true });
  return { stdout: s.prs[0].url };
}

function api(s) {
  const { db } = s;
  const rows = (sql, ...args) => db.prepare(sql).all(...args).map(r => ({ ...r }));
  const finish = (job, state, result) => db.prepare('UPDATE jobs SET state = ?, result = ?, finished_at = ?, log_file = ?, park_reason = ? WHERE id = ?')
    .run(state, JSON.stringify(result ?? null), s.now, result?.logFile ?? null, state === 'parked' ? 'hỏng' : null, job.id);
  const writeLog = (job, event) => {
    const logFile = path.join(s.root, `job-${job.id}.jsonl`);
    fs.writeFileSync(logFile, `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, ...event })}\n`);
    return { text: '', logFile };
  };
  const lane = (batchId, key, files = { [`${key}.txt`]: `${key}\n` }, { from } = {}) => {
    const repo = s.repo(batchId);
    const branch = `fix/${key}-${batchId}`.toLowerCase();
    const start = store.getBatch(db, batchId).data.startSha;
    g(repo, 'checkout', '-q', '-B', branch, from ?? start);
    const sha = commit(repo, files, branch);
    g(repo, 'push', '-q', 'origin', `HEAD:refs/heads/${branch}`);
    return { branch, commit: sha };
  };
  const approved = (batchId, key, files, options) => ({ key, verdict: 'confirmed', status: 'approved', ...lane(batchId, key, files, options), rootCause: 'A.kt:1', specRef: 'mục 1' });
  const handlers = {
    bug: job => ({ tickets: job.payload.keys.map(key => s.kinds.ticket?.(key, job) || approved(job.payload.batchId, key)) }),
    review: job => ({ lanes: job.payload.lanes.map(l => ({ ...approve(l), ...s.kinds.reviewLane?.(l, job) })) }),
    gate: job => [step('compile'), step('unitTest', s.kinds.gateOk?.(job) ?? true)],
    build: job => {
      const ok = s.kinds.buildOk?.(job) ?? true;
      const dir = path.join(job.payload.worktree, 'out');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'app.apk'), `apk ${job.payload.sha}`);
      const list = [step('assemble', ok)];
      if (ok && job.payload.distribute) list.push(step('distribute', s.kinds.distributeOk ?? true));
      return list;
    },
  };
  function work() {
    const queued = jobs.listJobs(db, { states: ['queued'] });
    for (const job of queued) {
      const custom = s.kinds[job.kind]?.(job);
      if (custom === 'parked' || custom === 'failed') finish(job, custom, { error: 'no_result' });
      else if (job.kind === 'bug') finish(job, 'done', writeLog(job, { result: custom?.text ?? `xong\n\`\`\`json\n${JSON.stringify(custom ?? handlers.bug(job))}\n\`\`\`` }));
      else if (job.kind === 'review') finish(job, 'done', writeLog(job, { result: '', structured_output: custom ?? handlers.review(job) }));
      else {
        const steps = custom ?? handlers[job.kind](job);
        const ok = steps.every(x => x.ok);
        finish(job, ok ? 'done' : 'failed', { ...(ok ? {} : { error: 'step_failed' }), text: JSON.stringify({ steps }) });
      }
    }
    return queued.length;
  }
  const advance = id => advanceBatch(s.ctx, { project: s.project, rules: DEFAULTS.rules, limits: DEFAULTS.limits, batch: store.getBatch(db, id), now: s.now });
  async function open(keys = Object.keys(s.fake.issues), version = VERSION) {
    recordBuildSent(db, 'AAP1', version, s.now - 3600000);
    const issues = [];
    for (const key of keys) issues.push(toIssue(await s.jira.issue(key)));
    intake(db, { project: 'AAP1', version, issues, now: s.now });
    s.now += 1000;
    recordPoll(db, 'AAP1', version, { newCount: 0, now: s.now });
    return planBatches(db, 'AAP1', s.now, DEFAULTS.limits.batch)[0].id;
  }
  async function until(id, stop = () => false) {
    for (let i = 0; i < 200; i++) {
      const batch = store.getBatch(db, id);
      if (store.FINISHED.includes(batch.state) || stop(batch)) return batch;
      const { changed } = await advance(id);
      if (!changed && work() === 0) s.now += 3 * 60 * 1000;
    }
    throw new Error(`đợt không xong: ${JSON.stringify(store.getBatch(db, id))}\n${JSON.stringify(rows("SELECT action, evidence FROM decisions ORDER BY id DESC LIMIT 5"))}`);
  }
  return {
    rows, open, until, advance, work, lane, approved,
    batch: id => store.getBatch(db, id),
    ticket: key => store.getTicket(db, 'AAP1', key),
    waits: role => rows("SELECT subject FROM waits WHERE role = ? AND state = 'open' ORDER BY id", role).map(r => r.subject),
    codes: (key = null) => rows('SELECT code, action, evidence FROM decisions ORDER BY id').filter(r => !key || JSON.parse(r.evidence).key === key).map(r => `${r.code} ${r.action}`),
    comments: key => s.fake.issues[key].comments ?? [],
    writes: () => s.fake.calls.filter(c => ['jira_transition_issue', 'jira_add_comment', 'jira_update_issue'].includes(c.name)),
    jobKeys: () => rows('SELECT kind, key FROM jobs ORDER BY id').map(r => `${r.kind} ${r.key}`),
    kindsOf: phase => batch => batch.data.phase === phase,
    files: (dir = s.mirror) => g(dir, 'ls-tree', '--name-only', BRANCH).split('\n'),
  };
}

module.exports = { setup, approve, step, issue, VERSION, BRANCH, START };
