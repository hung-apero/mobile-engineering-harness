const fs = require('node:fs');
const path = require('node:path');
const { loadProjects } = require('./projects.cjs');
const { createDeskManager, setWanted, deskProjects } = require('./desk.cjs');
const { ensureDirs, CHANNELS_DIR } = require('./desk-config.cjs');
const { deskChecks } = require('./desk-doctor.cjs');
const { runCommand } = require('./doctor-exec.cjs');
const { firstLine } = require('./redact.cjs');
const { clock } = require('./status.cjs');
const { ExpectedError } = require('./run.cjs');

const SUBS = ['start', 'stop', 'status', 'setup'];
const validDesk = args => args.length === 1 && SUBS.includes(args[0]);

const managerOf = ctx => ctx.desk ?? createDeskManager({ db: ctx.db, dzHome: ctx.dzHome, bot: null, env: ctx.env, claudeBin: ctx.claudeBin, log: ctx.log });

function start(ctx, now) {
  const { projects } = loadProjects(ctx.projectsDir, { dzHome: ctx.dzHome });
  if (deskProjects(projects.values()).length === 0) throw new ExpectedError('chưa project nào đang bật có khai kênh Discord (channel)');
  const checks = deskChecks({ dzHome: ctx.dzHome, projectsDir: ctx.projectsDir, exec: runCommand, baseEnv: ctx.env, bin: ctx.claudeBin });
  const problems = checks.filter(check => check.level === 'THIẾU' && check.name !== 'cấu hình desk');
  if (problems.length > 0) throw new ExpectedError(`chưa mở được bàn điều phối: ${problems.map(check => `${check.name}: ${check.detail}`).join('; ')}`);
  try {
    managerOf(ctx).prepare(projects.values());
  } catch (error) {
    throw new ExpectedError(firstLine(error));
  }
  setWanted(ctx.db, true, now);
  return ['Đã bật bàn điều phối. Service đang chạy sẽ mở phiên trong vòng một phút (xem bằng dz desk status).'];
}

async function stop(ctx, now) {
  return [(await managerOf(ctx).stop(now)) ? 'Đã tắt bàn điều phối và dừng phiên.' : 'Đã tắt bàn điều phối. Không có phiên nào đang chạy.'];
}

function status(ctx, now) {
  const view = managerOf(ctx).status(now);
  return [
    `Bàn điều phối: ${view.wanted ? 'bật' : 'tắt'}${view.held ? ', đang chờ dev' : ''}`,
    view.alive ? `Phiên: đang chạy (pid ${view.pid}, từ ${clock(view.startedAt)})` : 'Phiên: không chạy',
    `Tin chưa ack: ${view.pending}, quá 2 phút: ${view.overdue}`,
    `Khởi động lại trong một giờ: ${view.restarts}`,
    ...(view.alive ? [`Xem phiên: ${view.attach}`] : []),
  ];
}

function setup(ctx) {
  ensureDirs(ctx.dzHome);
  return fs.readFileSync(path.join(CHANNELS_DIR, 'setup.md'), 'utf8').trimEnd().split('{{DZ_HOME}}').join(ctx.dzHome).split('\n');
}

const RUN = { start, stop, status, setup };

async function desk(ctx, [sub], now) {
  return RUN[sub](ctx, now);
}

module.exports = { desk, validDesk };
