const kv = require('./kv.cjs');
const store = require('./bugs/store.cjs');
const { assess, releaseKey } = require('./bugs/release.cjs');
const { isClosed, closedAt, buildsAfterClose } = require('./bugs/closing.cjs');
const { deferTickets, deferList, deferred, DeferError, NAME } = require('./bugs/defer.cjs');
const { finishVersion, FinishError } = require('./bugs/finish.cjs');
const { acceptE2e, continueE2e, QaError } = require('./e2e/qa.cjs');
const e2eState = require('./e2e/state.cjs');
const { loadedProject } = require('./commands.cjs');
const { ExpectedError } = require('./run.cjs');
const { clock } = require('./status.cjs');

const KEY = /^[A-Z][A-Z0-9]+$/;
const USAGE = 'release status <KEY> <version> | release defer <KEY> <version> <TICKET…> --by <tên> | release e2e <KEY> <version> accept|continue --by <tên> | release done|cancel <KEY> <version>';
const EXPECTED = [DeferError, FinishError, QaError];
const MARKS = new Map([[true, 'đạt'], [false, 'chưa'], [null, 'chưa có']]);

const validBy = args => args.at(-2) === '--by' && NAME.test(args.at(-1) ?? '');

function validRelease(args) {
  const [sub, key, version, ...rest] = args;
  if (!['status', 'defer', 'e2e', 'done', 'cancel'].includes(sub) || !KEY.test(key ?? '') || !store.VERSION_RE.test(version ?? '')) return false;
  if (sub === 'defer') return rest.length >= 3 && validBy(rest) && rest.slice(0, -2).every(ticket => store.KEY_RE.test(ticket) && ticket.startsWith(`${key}-`));
  if (sub === 'e2e') return rest.length === 3 && ['accept', 'continue'].includes(rest[0]) && validBy(rest);
  return rest.length === 0;
}

async function releaseStatus(ctx, project, version, now, { fresh = true } = {}) {
  const { db } = ctx;
  const { key } = project;
  const name = version.version;
  const e2e = e2eState.load(db, key, name);
  const saved = kv.get(db, releaseKey(key, name));
  const result = fresh ? await assess(ctx, project, version, now) : { conditions: (saved?.flags ?? []).map((ok, i) => ({ n: i + 1, ok, detail: '' })), ready: saved?.ready ?? 'none' };
  return {
    project: key, version: name, branch: version.branch, state: version.state, polling: version.polling, ready: result.ready,
    conditions: result.conditions.map(({ n, ok, detail }) => ({ n, ok, detail })),
    closedAt: closedAt(db, key, name), closed: isClosed(db, key, name), buildsAfterClose: buildsAfterClose(db, key, name),
    deferred: deferred(db, key, name), checkedAt: saved?.at ?? null,
    e2e: { running: e2e.run !== null, failedRounds: e2e.failedRounds, waiting: Object.keys(e2e.waits), result: e2e.result },
  };
}

function statusLines(found) {
  const { e2e } = found;
  return [
    `${found.project} ${found.version} (${found.branch}): ${found.state === 'closed' ? 'đã kết thúc' : found.ready === 'release' ? 'đủ điều kiện release' : found.ready === 'merge' ? 'chờ dev merge' : 'chưa đủ'}`,
    ...found.conditions.map(c => `  ${c.n}. ${MARKS.get(c.ok)}: ${c.detail}`),
    found.closed ? `  Đóng bản lúc ${clock(found.closedAt)}, ${found.buildsAfterClose} bản build sau khi đóng` : '  Chưa đóng bản',
    `  E2E: ${e2e.running ? 'đang chạy' : e2e.result ? e2e.result.status : 'chưa có'}, ${e2e.failedRounds} vòng lỗi${e2e.waiting.length ? `, chờ: ${e2e.waiting.join(', ')}` : ''}`,
    ...found.deferred.map(entry => `  Hoãn ${entry.key}: ${entry.by}, ${clock(entry.at)}`),
  ];
}

async function run(ctx, [sub, key, name, ...rest], now) {
  const project = loadedProject(ctx, key);
  const version = store.getVersion(ctx.db, key, name);
  if (!version) throw new ExpectedError(`chưa có version ${key} ${name}`);
  const by = rest.at(-1);
  if (sub === 'status') return statusLines(await releaseStatus(ctx, project, version, now));
  if (sub === 'defer') {
    const done = await deferTickets(ctx, project, version, { keys: rest.slice(0, -2), by }, now);
    return [`Đã hoãn khỏi ${key} ${name}: ${done.deferred.join(', ') || 'không có ticket mới'} (${by})`, ...(done.already.length ? [`Đã hoãn từ trước: ${done.already.join(', ')}`] : [])];
  }
  if (sub === 'e2e' && rest[0] === 'accept') {
    const done = await acceptE2e(ctx, project, version, { by }, now);
    return [`${by} chấp nhận E2E ${key} ${name} trên cây ${done.tree.slice(0, 8)}, còn: ${done.left.join(', ')}`];
  }
  if (sub === 'e2e') return [continueE2e(ctx, project, version, { by }, now).rerun ? 'E2E sẽ chạy lại' : 'Sửa tiếp: E2E chạy lại khi có bản build mới'];
  const done = finishVersion(ctx, project, version, sub, now);
  if (done.already) return [`${key} ${name} đã kết thúc từ trước`];
  return [`Đã ${sub === 'done' ? 'ghi nhận release' : 'huỷ'} ${key} ${name}: tắt theo dõi bug, đóng ${done.closed} việc chờ`];
}

async function release(ctx, args, now) {
  try {
    return await run(ctx, args, now);
  } catch (error) {
    if (EXPECTED.some(kind => error instanceof kind)) throw new ExpectedError(error.message);
    throw error;
  }
}

module.exports = { release, validRelease, releaseStatus, deferList, deferTickets, USAGE };
