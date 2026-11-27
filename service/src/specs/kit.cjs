const store = require('./store.cjs');
const jobs = require('../jobs.cjs');
const kv = require('../kv.cjs');
const { openWait, resolveWait } = require('../pings.cjs');
const { record } = require('../decisions.cjs');
const { ruleVersionOf } = require('../bugs/effects.cjs');
const { redact } = require('../redact.cjs');
const { quizUrl, reviewUrl } = require('../web/links.cjs');

const TOKEN_MS = 90 * 24 * 60 * 60 * 1000;
const WEB_URL = 'web:url';
const waitKey = (id, name) => `spec-wait:${id}:${name}`;
const effectKey = (id, step) => `spec-effect:${id}:${step}`;

function createRun(ctx, project, spec, now) {
  return { ctx, db: ctx.db, project, spec, now, live: project.live === true };
}

function must(run, next) {
  if (!next) throw new Error(`spec ${run.spec.id} đã chuyển trạng thái ở nơi khác`);
  run.spec = next;
  return next;
}

const move = (run, to, patch = {}) => must(run, store.transitionSpec(run.db, run.spec.id, [run.spec.state], to, run.now, patch));
const patch = (run, data) => must(run, store.patchData(run.db, run.spec.id, data, run.now));

function decide(run, code, action, evidence = {}) {
  record(run.db, { project: run.project.key, code, ruleVersion: ruleVersionOf(run.ctx, run.project.key), evidence: { specId: run.spec.id, ...evidence }, action }, run.now);
}

async function once(run, step, fn) {
  const key = effectKey(run.spec.id, step);
  const known = kv.get(run.db, key);
  if (known?.state === 'done') return known.result;
  kv.set(run.db, key, { state: 'started' }, run.now);
  const result = (await fn()) ?? null;
  kv.set(run.db, key, { state: 'done', result }, run.now);
  return result;
}

function openOnce(run, name, role, subject, linkOf = () => null) {
  const key = waitKey(run.spec.id, name);
  if (kv.get(run.db, key) !== null) return;
  const link = linkOf();
  const id = openWait(run.db, { project: run.project.key, role, subject: redact(subject).slice(0, 400), link }, run.now);
  kv.set(run.db, key, id, run.now);
}

function closeWaits(db, specId, now, prefix = '') {
  for (const key of kv.keys(db, waitKey(specId, prefix))) {
    resolveWait(db, kv.get(db, key), now);
    kv.del(db, key);
  }
}

function webBase(ctx) {
  const port = ctx.env?.DZ_WEB_PORT && ctx.env.DZ_WEB_PORT !== '0' ? ctx.env.DZ_WEB_PORT : '8787';
  return kv.get(ctx.db, WEB_URL) ?? `http://${ctx.env?.DZ_WEB_HOST || '127.0.0.1'}:${port}`;
}

function linkFor(ctx, specId, purpose, now) {
  const token = store.issueToken(ctx.db, { specId, purpose, ttlMs: TOKEN_MS }, now);
  return (purpose === 'quiz' ? quizUrl : reviewUrl)(webBase(ctx), token);
}

function findJob(db, { project, kind, key }) {
  const row = db.prepare('SELECT id FROM jobs WHERE project = ? AND kind = ? AND key = ? ORDER BY id DESC LIMIT 1').get(project, kind, key);
  return row ? jobs.getJob(db, row.id) : null;
}

function submission(db, specId, round) {
  const row = db.prepare('SELECT submitted_by, submitted_at FROM spec_rounds WHERE spec_id = ? AND round = ?').get(specId, round);
  return row ? { by: row.submitted_by, at: row.submitted_at } : null;
}

const nameOf = spec => `${spec.title || 'spec'} (#${spec.id})`;

function park(run, reason, extra = {}) {
  const from = run.spec.state;
  move(run, 'parked', { data: { parked: { reason, from, ...extra } } });
  decide(run, 'X02', 'spec-parked', { from, reason });
  if (!extra.jobId) openOnce(run, 'parked', 'dev', `Spec ${nameOf(run.spec)} đang gác: ${reason}`);
}

const STEPS = { new: 'nhận spec', reading: 'đọc spec', asking: 'soạn câu hỏi', clarifying: 'viết lại spec', building: 'code', smoking: 'chạy thử', uidiff: 'so giao diện', reviewing: 'review code', candidate: 'dựng bản cài', landing: 'gộp vào bản' };

function needInput(run, { kind, role, reason, missing = [] }) {
  const from = run.spec.state;
  move(run, 'needs-input', { data: { needs: { kind, role, reason, missing, from } } });
  decide(run, 'S02', 'spec-needs-input', { kind, reason });
  const text = `${reason}${missing.length ? ` (${missing.join('; ')})` : ''}`;
  const where = `Spec ${nameOf(run.spec)} dừng ở bước ${STEPS[from] ?? from}`;
  const retry = `dz spec retry ${run.spec.id}`;
  if (role === 'po') {
    openOnce(run, 'needs', 'po', `${where}, cần PO bổ sung: ${text}. Sửa trang spec rồi báo dev.`);
    openOnce(run, 'needs-dev', 'dev', `${where}, chờ PO bổ sung: ${text}. PO bổ sung xong thì chạy ${retry}.`);
  } else {
    openOnce(run, 'needs', role, `${where}, cần dev xử lý: ${text}. Xử lý xong thì chạy ${retry}.`);
  }
}

module.exports = {
  WEB_URL, createRun, move, patch, decide, once, openOnce, closeWaits, webBase, linkFor, findJob, submission, nameOf, park, needInput,
};
