const kv = require('../kv.cjs');
const store = require('./store.cjs');
const { openWait } = require('../pings.cjs');
const { log, api, pages } = require('./pr-api.cjs');
const { answerNotes, retryAnswers } = require('./pr-answers.cjs');
const { lastPr } = require('./next-branch.cjs');
const { loadIssue } = require('./issue-view.cjs');
const { oneLine } = require('./comment-text.cjs');
const { redact } = require('../redact.cjs');

const LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const WRITERS = ['admin', 'maintain', 'write'];
const MAX_TEXT = 2000;
const ASKS = /(?:^|\s)\/fix\b/i;
const SOURCES = { inline: n => `pulls/${n}/comments`, review: n => `pulls/${n}/reviews`, comment: n => `issues/${n}/comments` };
const noteKey = (project, version, id = '') => `pr-note:${project}:${version}:${id}`;

async function mayWrite(ctx, project, login, cache) {
  if (!LOGIN.test(login ?? '')) return false;
  if (!cache.has(login)) {
    const found = await api(ctx, project, `collaborators/${login}/permission`).catch(error => {
      if (/404|not found/i.test(error.message)) return null;
      throw error;
    });
    cache.set(login, WRITERS.includes(found?.permission) || WRITERS.includes(found?.role_name));
  }
  return cache.get(login);
}

const wanted = row => row?.user?.type === 'User' && Number.isInteger(row.id) && typeof row.body === 'string' && row.body.trim() !== ''
  && !row.body.trimStart().startsWith('[Claude]') && !['APPROVED', 'DISMISSED', 'PENDING'].includes(row.state);

const asksFix = row => row.state === 'CHANGES_REQUESTED' || ASKS.test(row.body);

async function keysFor(ctx, project, version, row) {
  const delivered = store.listBatches(ctx.db, { project: project.key, version, states: ['done'] }).filter(batch => batch.data.delivered);
  const lanes = delivered.flatMap(batch => (batch.data.lanes ?? []).map(lane => ({ ...lane, startSha: batch.data.startSha })));
  const known = new Set(lanes.flatMap(lane => lane.keys));
  if (!asksFix(row) && typeof row.path !== 'string') return [];
  const named = !asksFix(row) ? [] : [...new Set(row.body.match(/\b[A-Z][A-Z0-9]*-\d+\b/g) ?? [])].filter(key => known.has(key));
  if (named.length || typeof row.path !== 'string') return named;
  for (const lane of lanes.reverse()) {
    const files = await ctx.bugs.git.landing.changedFiles({ dzHome: ctx.dzHome, project, from: lane.startSha, commits: [lane.commit] });
    if (files.includes(row.path)) return lane.keys;
  }
  return [];
}

async function reopen(ctx, project, key) {
  const jira = await ctx.bugs.jira(project);
  const { resolved, reopened, waiting } = project.jiraStatus;
  const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
  const { status } = await loadIssue(jira, key);
  if (waiting.some(name => same(name, status))) return true;
  if (!same(status, resolved) || !(await jira.transitions(key)).some(t => same(t.to_status, reopened))) return false;
  await jira.transition(key, reopened);
  return true;
}

async function takeNote(ctx, project, version, kind, row, now) {
  const id = noteKey(project.key, version, `${kind}-${row.id}`);
  const keys = await keysFor(ctx, project, version, row);
  const ready = [];
  for (const key of keys) if (await reopen(ctx, project, key)) ready.push(key);
  const where = row.path ? `${row.path}:${row.line ?? row.original_line ?? '?'} ` : '';
  const text = redact(`${where}${row.body}`).slice(0, MAX_TEXT);
  kv.transaction(ctx.db, () => {
    kv.set(ctx.db, id, { kind, commentId: row.id, pr: row.pr, by: row.user.login, text, keys: ready, state: ready.length ? 'queued' : 'dev' }, now);
    log(ctx, project, ready.length ? 'fix-round' : 'give-dev', { version, commentId: row.id, by: row.user.login, keys: ready }, now);
    if (!ready.length) openWait(ctx.db, { project: project.key, role: 'dev', subject: `Góp ý PR bản ${version} của ${row.user.login} chưa gắn được với ticket đang mở: ${oneLine(row.body, 100)} (muốn sửa thì ghi /fix kèm mã ticket) (F06)`, link: row.html_url ?? null }, now);
  });
}

async function readReviews(ctx, project, version, now) {
  const pr = lastPr(ctx.db, project.key, version);
  if (project.live !== true || !pr?.number) return 0;
  const cache = new Map();
  let taken = 0;
  for (const [kind, route] of Object.entries(SOURCES)) {
    for (const row of (await pages(ctx, project, route(pr.number))).filter(wanted)) {
      const id = noteKey(project.key, version.version, `${kind}-${row.id}`);
      if (kv.get(ctx.db, id) !== null) continue;
      if (!(await mayWrite(ctx, project, row.user.login, cache))) {
        kv.set(ctx.db, id, { state: 'ignored', by: String(row.user.login) }, now);
        log(ctx, project, 'noted-only', { version: version.version, commentId: row.id, by: String(row.user.login) }, now);
        continue;
      }
      await takeNote(ctx, project, version.version, kind, { ...row, pr: pr.number }, now);
      taken += 1;
    }
  }
  await retryAnswers(ctx, project, version, now);
  return taken;
}

const notesOf = (db, project, version, state) => kv.keys(db, noteKey(project, version)).map(id => ({ id, ...kv.get(db, id) })).filter(note => note.state === state);

function attachNotes(ctx, batch, now) {
  const { phase, round, todo } = batch.data;
  if (phase !== 'fixing' || round !== 1 || batch.data.prNotes) return batch;
  const mine = notesOf(ctx.db, batch.project, batch.version, 'queued').filter(note => note.keys.some(key => todo.includes(key)));
  if (!mine.length) return batch;
  const notes = mine.flatMap(note => note.keys.filter(key => todo.includes(key)).map(key => ({ key, text: `Dev ${note.by} góp ý trên PR: ${note.text}` })));
  const data = { ...batch.data, notes: [...batch.data.notes, ...notes], prNotes: mine.map(note => note.id) };
  return store.transitionBatch(ctx.db, batch.id, 'running', 'running', now, data) ?? batch;
}

module.exports = { readReviews, attachNotes, answerNotes, noteKey };
