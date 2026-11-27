const { loadProjects } = require('./projects.cjs');
const { isPaused, projectBlocked } = require('./health.cjs');
const { loadQuota } = require('./quota.cjs');
const { intakeState, startBlock } = require('./intake-state.cjs');
const { liveOwner } = require('./service-lock.cjs');
const { firstLine } = require('./redact.cjs');
const { sandboxLine } = require('./sandbox.cjs');
const jobs = require('./jobs.cjs');
const kv = require('./kv.cjs');

const STATES = { queued: 'chờ', starting: 'đang mở', running: 'đang chạy', parked: 'đang gác' };

const clock = ms => new Date(ms).toLocaleString('vi-VN', { timeZone: 'Asia/Saigon' });

function attempt(fn) {
  try {
    return fn();
  } catch (error) {
    return `lỗi: ${firstLine(error)}`;
  }
}

function serviceLine(ctx) {
  const owner = liveOwner(ctx.lockFile);
  return owner ? `đang chạy (pid ${owner.pid})` : 'không chạy';
}

function intakeLine(state) {
  if (state.open) return 'mở';
  return `đóng (${state.code}${state.until ? ` tới ${clock(state.until)}` : ''})`;
}

function quotaLine(quota, state) {
  const closed = state.code === 'X01' ? `, đóng nhận việc tới ${clock(state.until)}` : '';
  if (!quota) return `chưa rõ${closed}`;
  const used = Number.isFinite(quota.utilization) ? `${Math.round(quota.utilization * 100)}%` : 'chưa rõ %';
  return `${used}, ${quota.status ?? 'chưa rõ'}, ghi lúc ${clock(quota.at)}${closed}`;
}

function projectLine(ctx, project) {
  const notes = [project.schedulable ? 'bật' : 'tắt'];
  if (isPaused(ctx.db, project.key)) notes.push('tạm dừng');
  if (projectBlocked(ctx.db, project.key, ctx.rulesFor(project.key).rules)) notes.push('dừng vì X07');
  notes.push(project.live ? 'live' : 'chạy khô');
  const running = ctx.db.prepare("SELECT COUNT(*) AS n FROM batches WHERE project = ? AND state IN ('open', 'running')").get(project.key).n;
  if (running) notes.push(`${running} đợt bug đang chạy`);
  return notes.join(', ');
}

function projectLines(ctx) {
  const { projects, errors } = loadProjects(ctx.projectsDir, { dzHome: ctx.dzHome });
  return [
    ...[...projects.values()].map(p => `- ${p.key}: ${attempt(() => projectLine(ctx, p))}`),
    ...errors.map(e => `- ${e.file}: cấu hình lỗi — ${firstLine(e)}`),
  ];
}

function jobLine(job) {
  const reason = job.parkReason && job.state === 'parked' ? ` — ${firstLine(job.parkReason)}` : '';
  return `- #${job.id} ${job.project} ${job.kind} ${job.key}: ${STATES[job.state]}, lần ${job.attempt}${reason}`;
}

function statusLines(ctx, now) {
  const quota = loadQuota(ctx.db, now);
  const projects = attempt(() => projectLines(ctx));
  const open = jobs.listJobs(ctx.db, { states: Object.keys(STATES) });
  const state = attempt(() => intakeState(ctx, ctx.rulesFor().rules, now));
  const block = startBlock(ctx.db, now);
  const waiting = ctx.db.prepare("SELECT COUNT(*) AS n FROM waits WHERE state = 'open'").get().n;
  const specs = ctx.db.prepare("SELECT state, COUNT(*) AS n FROM specs WHERE state NOT IN ('approved', 'done') GROUP BY state ORDER BY state").all();
  const lines = [
    `Service: ${attempt(() => serviceLine(ctx))}`,
    `Nhận việc: ${typeof state === 'string' ? state : intakeLine(state)}`,
    `Hạn mức: ${quotaLine(quota, state)}`,
    ...(block ? [`Worker: không mở được claude — ${firstLine(block.error)}`] : []),
    `Sandbox: ${sandboxLine(ctx)}`,
    `Web: ${kv.get(ctx.db, 'web:url') ?? 'chưa chạy'}`,
    'Project:',
    ...(Array.isArray(projects) ? projects : [`- ${projects}`]),
    ...(specs.length ? [`Spec đang làm: ${specs.map(row => `${row.state} ${row.n}`).join(', ')}`] : []),
    `Việc đang mở: ${open.length}`,
    ...open.map(jobLine),
    `Đang chờ người: ${waiting}`,
  ];
  const bad = ctx.ruleStore.lastError();
  if (bad) lines.push(`Rule lỗi: ${bad.file} — ${firstLine(bad)}`);
  return lines;
}

module.exports = { statusLines, clock, attempt, serviceLine, intakeLine, quotaLine, projectLine };
