const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { tick } = require('../src/tick.cjs');
const jobs = require('../src/jobs.cjs');
const store = require('../src/specs/store.cjs');
const { createFacade } = require('../src/specs/facade.cjs');
const { createSpecs } = require('../src/specs/wire.cjs');
const CHECKER = path.join(__dirname, '..', '..', 'skills', 'feature', 'scripts', 'headless_check.py');
const { makeHome, fakeWorkers, OK, NOW } = require('./service-fixtures.cjs');

const Q1 = '## Q1 · Change path đi đâu? [chặn]\nBối cảnh\n- A. Về nhà\n- B. Ở lại\n- **Đề xuất: B** — spec\n';
const Q2 = '## Q2 · Màu nút\nBối cảnh\n- A. Xanh\n- B. Đỏ\n- **Đề xuất: A** — figma\n';
const Q3 = '## Q3 · Kiểu chữ\n- A. Đậm\n- B. Thường\n- **Đề xuất: A** — x\n';
const Q4 = '## Q4 · Giá gói tuần? [chặn]\n- A. 1\n- B. 2\n- **Đề xuất: A** — x\n';
const QUESTIONS = `${Q1}\n${Q2}\n${Q3}`;
const AUTO2 = { id: 'Q2', decision: 'auto', label: 'A', source: 'Figma 1:2', reason: 'rõ', category: 'evidence' };
const TRIAGE = { items: [{ id: 'Q1', decision: 'ask', reason: 'x', category: 'unclear' }, AUTO2, { id: 'Q3', decision: 'ask', reason: 'x', category: 'unclear' }] };

function put(repo, files) {
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(repo, '.harness-run', name);
    if (text === null) fs.rmSync(file, { force: true });
    else {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, typeof text === 'string' ? text : JSON.stringify(text));
    }
  }
}

const g = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();

function fakeClone(dzHome, calls) {
  return async ({ project, specId, markdown, figma }) => {
    calls.push({ specId, markdown, figma });
    const repo = path.join(fs.realpathSync(dzHome), 'workspaces', project.key, 'specs', String(specId), 'repo');
    if (!fs.existsSync(repo)) {
      fs.mkdirSync(repo, { recursive: true });
      g(repo, 'init', '-q', '-b', 'main');
      g(repo, 'config', 'user.name', 't');
      g(repo, 'config', 'user.email', 't@localhost');
      fs.writeFileSync(path.join(repo, 'app.txt'), 'app\n');
      g(repo, 'add', '-A');
      g(repo, 'commit', '-qm', 'first');
    }
    put(repo, { 'inputs/spec-v1.md': `${markdown}\n` });
    return { repo, harnessRoot: repo };
  };
}

function asked(repo, questions = QUESTIONS, triage = TRIAGE) {
  put(repo, { 'questions.md': questions, 'triage.json': triage });
}

function clarified(repo, version = 2, text = '# Spec\n(Q1: B) (Q2: A — Agent tự chốt) Q3 Q4\n') {
  put(repo, { [`clarified/spec-v${version}.md`]: text });
}

function setup(t, { live = false, source = { type: 'pasted', text: '# [ABC1] Spec gốc\nNội dung' }, figma = 'none' } = {}) {
  const h = makeHome(t);
  if (live) h.project('ABC1', { live: true });
  const sends = [];
  const ctx = h.context({ send: async message => { sends.push(message); return { ok: true }; } });
  const { calls, alive } = fakeWorkers(ctx);
  const clones = [];
  ctx.specs.prepareClone = fakeClone(ctx.dzHome, clones);
  ctx.specs.check = createSpecs(ctx, { checker: CHECKER }).check;
  ctx.specs.confluence = () => { throw new Error('không được gọi Confluence'); };
  const facade = createFacade(ctx);
  const id = facade.newSpec({ project: 'ABC1', source, figma, title: null }, NOW).id;
  const s = { h, ctx, facade, calls, alive, clones, sends, id, now: NOW };
  s.spec = () => store.getSpec(ctx.db, id);
  s.repo = () => s.spec().data.repo;
  s.read = name => fs.readFileSync(path.join(s.repo(), '.harness-run', name), 'utf8');
  s.tick = async (ms = 10000) => {
    s.now += ms;
    await tick(ctx, s.now);
    await ctx.specStepPending;
  };
  s.running = (kind = 'spec') => jobs.listJobs(ctx.db, { states: ['running'] }).filter(job => job.kind === kind);
  s.until = async check => {
    for (let i = 0; i < 6; i++) {
      if (check()) return;
      await s.tick();
    }
    throw new Error(`chưa tới: ${JSON.stringify(s.spec())}`);
  };
  s.finish = async (work, { kind = 'spec', event = OK } = {}) => {
    await s.until(() => s.running(kind).length === 1);
    const [job] = s.running(kind);
    work?.(s.repo(), job);
    fs.appendFileSync(job.logFile, `${JSON.stringify(event)}\n`);
    alive.clear();
    await s.tick();
    return job;
  };
  s.toQuiz = async (questions, triage) => {
    await s.finish(repo => asked(repo, questions, triage));
    return s.spec();
  };
  s.answer = () => {
    facade.saveDraft(id, { qid: 'Q1', choice: 'B', text: '' }, 'po', s.now);
    return facade.submit(id, 'po', s.now);
  };
  s.toReview = async () => {
    await s.toQuiz();
    s.answer();
    await s.finish(repo => clarified(repo));
    return s.spec();
  };
  s.waits = () => ctx.db.prepare("SELECT role, subject, link FROM waits WHERE state = 'open' ORDER BY id").all();
  s.decisions = action => ctx.db.prepare('SELECT * FROM decisions WHERE action = ?').all(action);
  return s;
}

module.exports = { setup, put, asked, clarified, g, Q1, Q2, Q3, Q4, QUESTIONS, TRIAGE, AUTO2, NOW, OK };
