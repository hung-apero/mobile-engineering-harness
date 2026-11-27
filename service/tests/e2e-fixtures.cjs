const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const kv = require('../src/kv.cjs');
const jobs = require('../src/jobs.cjs');
const store = require('../src/bugs/store.cjs');
const workspace = require('../src/bugs/workspace.cjs');
const merge = require('../src/bugs/merge.cjs');
const landing = require('../src/bugs/landing.cjs');
const { treeOf, keepBuild } = require('../src/e2e/builds.cjs');
const { journalFile } = require('../src/e2e/journal.cjs');
const { readyWorld } = require('./bugs-git-fixtures.cjs');
const { memDb, t: at } = require('./bugs-fixtures.cjs');

const NOW = at('2026-11-26T10:00');
const VERSION = '1.9.2';
const STATUS = { waiting: ['To Do', 'Reopened'], inProgress: 'In Progress', resolved: 'Resolved', reopened: 'Reopened', done: ['Closed'] };
const OK = { conditions: [false, true, true, true, true, null].map((ok, i) => ({ n: i + 1, ok, detail: '' })) };

async function setup(t, { live = false, closed = true, build = true, device = 'AAA', inputs = true } = {}) {
  const w = await readyWorld(t);
  const db = memDb();
  store.ensureVersion(db, { project: 'AAP1', version: VERSION });
  db.prepare('UPDATE versions SET polling = 1, baseline_at = ?').run(NOW - 86400000);
  const project = { ...w.project, live, package: 'com.example.app', jiraStatus: STATUS, commands: { apkGlob: '*.apk' }, e2eDevices: ['AAA'] };
  const locks = [];
  const s = { ...w, db, project, locks, device, ticketCalls: [], gh: [], packages: {}, hits: { high: [], resolved: [], low: [] } };
  const devices = {
    pick: async ({ skip = [] }) => (skip.includes(s.device) ? null : s.device),
    packageState: async ({ serial }) => s.packages[serial] ?? { present: false, lastUpdate: null },
    acquire: async ({ holder, serial }) => {
      locks.push(['acquire', serial, holder]);
      return { serial, holder };
    },
    releaseAll: async ({ prefix }) => {
      locks.push(['release', prefix]);
      return [];
    },
  };
  s.jira = {
    search: async jql => {
      if (jql.includes('priority in (Highest, High)')) return s.hits.high;
      if (jql.includes('priority in (Medium')) return s.hits.low;
      return jql.includes('status in ("Resolved"') ? s.hits.resolved : [];
    },
  };
  const ticketClient = () => ({ create: async args => { s.ticketCalls.push(args); return { key: `AAP1-${100 + s.ticketCalls.length}`, created: true }; }, close: async () => {} });
  s.ctx = {
    db, dzHome: w.dzHome, secretsDir: path.join(w.dzHome, 'secrets'), now: () => NOW,
    rulesFor: () => ({ version: 'v1', rules: { F07: { max_pr_lines: 400 } }, limits: {} }), log: () => {},
    bugs: { jira: async () => s.jira, git: { workspace, merge, landing }, githubUrl: w.github, gh: async args => { s.gh.push(args); return { stdout: '[]' }; } },
    e2e: { devices, ticketClient },
  };
  if (closed) kv.set(db, `release-closed:AAP1:${VERSION}`, { at: NOW - 1000 }, NOW);
  if (inputs) writeInputs(s);
  s.version = () => store.getVersion(db, 'AAP1', VERSION);
  s.state = () => kv.get(db, `e2e:AAP1:${VERSION}`);
  s.waits = role => db.prepare("SELECT subject FROM waits WHERE state = 'open' AND role = ?").all(role).map(x => x.subject);
  s.actions = code => db.prepare('SELECT action FROM decisions WHERE code = ? ORDER BY id').all(code).map(x => x.action);
  s.job = () => jobs.listJobs(db, { project: 'AAP1' }).filter(job => job.kind === 'e2e').at(-1);
  s.addBuild = batchId => addBuild(s, batchId);
  s.finish = (options = {}) => finish(s, options);
  if (build) await s.addBuild(1);
  return s;
}

function writeInputs(s, doc = {}) {
  const harness = path.join(s.dzHome, 'android-test-harness', '.claude-plugin');
  fs.mkdirSync(harness, { recursive: true });
  fs.writeFileSync(path.join(harness, 'plugin.json'), '{"name":"android-test-harness"}');
  const dir = path.join(s.dzHome, 'e2e');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'spec.md'), '# spec');
  fs.writeFileSync(path.join(dir, 'store.apk'), 'store');
  fs.writeFileSync(path.join(dir, 'AAP1.json'), JSON.stringify({ testCases: { kind: 'spec', value: path.join(dir, 'spec.md') }, storeApk: path.join(dir, 'store.apk'), dryRun: true, ...doc }));
}

async function addBuild(s, batchId, sha = s.ref(s.branch)) {
  const file = path.join(s.root, `app-${batchId}.apk`);
  const body = `apk ${batchId}`;
  fs.writeFileSync(file, body);
  const sha256 = crypto.createHash('sha256').update(body).digest('hex');
  return keepBuild({ db: s.db, dzHome: s.dzHome, project: s.project, version: VERSION, batchId, sha, build: { path: file, sha256, versionName: '1.9.2' }, now: NOW });
}

const UPGRADED = ({ storeApk, apk }) => [{ verb: 'install', apk: storeApk, ok: true }, { verb: 'install', apk, update: true, ok: true }];

function finish(s, { cases = [{ id: 'TC-1', status: 'pass' }], upgrade = { status: 'pass', reason: '' }, status = 'done', state = 'done', round = 1, reason = '', expected = cases.map(c => c.id), journal = UPGRADED }) {
  const job = s.job();
  const dir = path.join(job.payload.root, '.android-app', 'rounds', String(round));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify({ round, scenarios: [{ id: 'ts-1', cases }] }));
  fs.writeFileSync(path.join(job.payload.root, '.android-app', 'ts-index.json'), JSON.stringify([{ ts: 'ts-1', testCaseIds: expected }]));
  fs.writeFileSync(journalFile(job.payload.root), journal(job.payload).map(entry => `${JSON.stringify(entry)}\n`).join(''));
  const log = path.join(s.root, `job-${job.id}.jsonl`);
  fs.writeFileSync(log, `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '', structured_output: { status, round, reason, upgrade } })}\n`);
  s.db.prepare('UPDATE jobs SET state = ?, log_file = ?, started_at = 1, park_reason = ? WHERE id = ?').run(state, log, state === 'parked' ? 'hỏng' : null, job.id);
}

module.exports = { setup, writeInputs, treeOf, NOW, VERSION, OK };
