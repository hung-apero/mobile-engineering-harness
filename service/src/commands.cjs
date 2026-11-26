const fs = require('node:fs');
const path = require('node:path');
const jobs = require('./jobs.cjs');
const kv = require('./kv.cjs');
const store = require('./bugs/store.cjs');
const { loadProjects } = require('./projects.cjs');
const { setProjectState } = require('./health.cjs');
const { clearParked, clearBlock } = require('./blocks.cjs');
const { resolveWait } = require('./pings.cjs');
const { failuresKey } = require('./launch.cjs');
const { ExpectedError } = require('./run.cjs');
const { firstLine } = require('./redact.cjs');
const { statusLines, clock } = require('./status.cjs');

function requireKnown(ctx, key) {
  if (!fs.existsSync(path.join(ctx.projectsDir, `${key}.yaml`))) throw new ExpectedError(`không có project ${key}`);
}

function status(ctx, _, now) {
  return statusLines(ctx, now);
}

function loadedProject(ctx, key) {
  requireKnown(ctx, key);
  const { projects, errors } = loadProjects(ctx.projectsDir, { dzHome: ctx.dzHome });
  if (!projects.has(key)) {
    const found = errors.find(e => e.file === `${key}.yaml`);
    throw new ExpectedError(`cấu hình project ${key} lỗi: ${found ? firstLine(found) : 'không đọc được'}`);
  }
  return projects.get(key);
}

function probe(ctx, key, now) {
  loadedProject(ctx, key);
  const { id, created } = jobs.enqueue(ctx.db, { project: key, kind: 'probe', key: 'probe', priority: 1, slots: 1, payload: {} }, now);
  return [created ? `Đã thêm việc #${id}` : `Việc #${id} đang mở sẵn`];
}

const BATCH_KINDS = ['bug', 'review', 'gate', 'build'];

function checkBatch(ctx, job) {
  const id = BATCH_KINDS.includes(job.kind) ? Number(job.key.match(/^(\d+)#/)?.[1]) : NaN;
  const batch = Number.isNaN(id) ? null : store.getBatch(ctx.db, id);
  if (batch && store.FINISHED.includes(batch.state)) throw new ExpectedError(`việc #${job.id} thuộc đợt #${id} đã ${batch.state}, không chạy lại được`);
}

function retry(ctx, id, now) {
  const job = jobs.getJob(ctx.db, Number(id));
  if (!job) throw new ExpectedError(`không có việc #${id}`);
  if (!['parked', 'failed'].includes(job.state)) throw new ExpectedError(`việc #${id} không ở trạng thái gác hay lỗi`);
  checkBatch(ctx, job);
  jobs.retry(ctx.db, job.id, now);
  kv.del(ctx.db, failuresKey(job.id));
  clearParked(ctx.db, job.id, now);
  return [`Việc #${id} đã quay lại hàng đợi`];
}

function pause(ctx, key) {
  requireKnown(ctx, key);
  setProjectState(ctx.db, key, { paused: true });
  return [`Project ${key} đã tạm dừng nhận việc`];
}

function resume(ctx, key, now) {
  requireKnown(ctx, key);
  kv.transaction(ctx.db, () => {
    setProjectState(ctx.db, key, { paused: false, resumedAt: now });
    clearBlock(ctx.db, key, now);
    ctx.db.prepare('UPDATE versions SET build_failures = 0 WHERE project = ?').run(key);
  });
  return [`Project ${key} đã chạy tiếp`];
}

function waits(ctx, key) {
  if (key !== undefined) requireKnown(ctx, key);
  const rows = ctx.db.prepare(`SELECT * FROM waits WHERE state = 'open' ${key === undefined ? '' : 'AND project = ?'} ORDER BY id`).all(...(key === undefined ? [] : [key]));
  if (!rows.length) return ['Không có việc nào đang chờ người'];
  return rows.map(w => `#${w.id} ${w.role} ${w.project}: ${w.subject} (mở ${clock(w.opened_at)}, đã nhắc ${w.ping_count} lần)`);
}

function done(ctx, id, now) {
  const wait = ctx.db.prepare('SELECT * FROM waits WHERE id = ?').get(Number(id));
  if (!wait) throw new ExpectedError(`không có việc chờ #${id}`);
  if (!resolveWait(ctx.db, wait.id, now)) throw new ExpectedError(`việc chờ #${id} đã đóng rồi`);
  return [`Đã đóng việc chờ #${id}: ${wait.subject}`];
}

module.exports = { loadedProject, status, probe, retry, pause, resume, waits, done };
