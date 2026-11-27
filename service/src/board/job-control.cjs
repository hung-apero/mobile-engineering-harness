const os = require('node:os');
const path = require('node:path');
const jobs = require('../jobs.cjs');
const specs = require('../specs/store.cjs');
const { stopJob } = require('../bugs/cleanup.cjs');
const { clearParked } = require('../blocks.cjs');
const table = require('../process-table.cjs');
const { record } = require('../decisions.cjs');

const SPEC_KINDS = ['spec', 'uidiff', 'explain'];
const HELD_FROM = ['parked', 'needs-input', 'cancelled', 'done', 'landed-dry'];
const REASONS = jobs.HELD_REASONS;

const refuse = message => Object.assign(new Error(message), { code: 'INVALID' });
const home = text => String(text).split(os.homedir()).join('~');

function specIdOf(job) {
  const own = String(job.key).match(/^(\d+)#/);
  if (own && SPEC_KINDS.includes(job.kind)) return Number(own[1]);
  const built = String(job.key).match(/^spec-(\d+)#/);
  return built ? Number(built[1]) : null;
}

function load(ctx, id) {
  const job = jobs.getJob(ctx.db, Number(id));
  if (!job) throw refuse(`không có việc #${id}`);
  const specId = specIdOf(job);
  const spec = specId === null ? null : specs.getSpec(ctx.db, specId);
  if (!spec) throw refuse(`việc #${id} không thuộc spec nào, dùng lệnh dz trên máy`);
  return { job, spec };
}

function takeover(ctx, spec, job) {
  const config = path.join(ctx.dzHome, 'claude');
  const quote = text => `'${home(text).replace(/'/g, `'\\''`)}'`;
  return `cd ${quote(spec.data.repo)} && CLAUDE_CONFIG_DIR=${quote(config)} claude --resume ${job.sessionId}`;
}

async function hold(ctx, { job, spec }, action, now, stop) {
  if (job.state !== 'running') throw refuse(`việc #${job.id} không đang chạy (${job.state})`);
  if (HELD_FROM.includes(spec.state)) throw refuse(`spec #${spec.id} đang ${spec.state}`);
  const keepSession = action === 'pause';
  const parked = { reason: REASONS[action], from: spec.state, jobId: job.id, mode: action };
  if (!specs.transitionSpec(ctx.db, spec.id, [spec.state], 'parked', now, { data: { parked } })) throw refuse(`spec #${spec.id} vừa đổi trạng thái, tải lại trang`);
  try {
    jobs.hold(ctx.db, job.id, REASONS[action], now, { keepSession });
  } catch {
    specs.transitionSpec(ctx.db, spec.id, ['parked'], spec.state, now, { data: { parked: null } });
    throw refuse(`việc #${job.id} vừa đổi trạng thái, tải lại trang`);
  }
  record(ctx.db, { project: job.project, jobId: job.id, code: 'X02', ruleVersion: 'board', evidence: { specId: spec.id, jobId: job.id, action }, action: 'spec-held' }, now);
  let note = '';
  try {
    await stop(job);
  } catch (error) {
    note = ` Chưa dừng được tiến trình: ${error.message}`;
  }
  const out = { ok: true, message: `${action === 'pause' ? 'Đã tạm dừng' : 'Đã dừng'} việc #${job.id}.${note}` };
  return keepSession && job.sessionId && SPEC_KINDS.includes(job.kind) ? { ...out, takeover: takeover(ctx, spec, job) } : out;
}

async function start(ctx, { job, spec }, now, isAlive) {
  const parked = spec.data.parked;
  if (spec.state !== 'parked' || parked?.jobId !== job.id || job.state !== 'parked') throw refuse(`việc #${job.id} không ở trạng thái dừng từ board`);
  if (isAlive(job)) throw refuse(`tiến trình của việc #${job.id} vẫn đang chạy, chờ nó dừng hẳn rồi bấm lại`);
  if (parked.mode === 'pause' && job.resume && job.sessionId) {
    if (!specs.transitionSpec(ctx.db, spec.id, ['parked'], parked.from, now, { data: { parked: null } })) throw refuse(`spec #${spec.id} vừa đổi trạng thái, tải lại trang`);
    jobs.resumeHeld(ctx.db, job.id);
    clearParked(ctx.db, job.id, now);
    return { ok: true, message: `Việc #${job.id} chạy tiếp từ chỗ dừng.` };
  }
  try {
    const [line] = await require('../spec-commands.cjs').spec(ctx, ['retry', String(spec.id)], now);
    return { ok: true, message: line };
  } catch (error) {
    throw refuse(error.message);
  }
}

const processAlive = job => Boolean(job.pid) && table.isSameProcess(job.pid, job.pidStart);

async function controlJob(ctx, id, action, now, { stop = stopJob, isAlive = processAlive } = {}) {
  if (!['start', 'pause', 'stop'].includes(action)) throw refuse(`không có thao tác ${action}`);
  const loaded = load(ctx, id);
  return action === 'start' ? start(ctx, loaded, now, isAlive) : hold(ctx, loaded, action, now, stop);
}

module.exports = { controlJob };
