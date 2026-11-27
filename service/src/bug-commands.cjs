const kv = require('./kv.cjs');
const store = require('./bugs/store.cjs');
const polling = require('./bugs/polling.cjs');
const { pollVersion, onlyKey, backoffKey } = require('./bugs/step.cjs');
const { parseList, namesKey } = require('./bugs/fix-versions.cjs');
const { releaseKey } = require('./bugs/release.cjs');
const { loadedProject } = require('./commands.cjs');
const { ExpectedError } = require('./run.cjs');
const { clock } = require('./status.cjs');

const KEY = /^[A-Z][A-Z0-9]+$/;
const FLAGS = ['--only', '--base', '--fix-version'];
const MAX_ONLY = 50;

function flagsOf(rest) {
  const flags = {};
  for (let i = 0; i < rest.length; i += 2) {
    const [name, value] = [rest[i], rest[i + 1]];
    if (!FLAGS.includes(name) || value === undefined || Object.hasOwn(flags, name)) return null;
    flags[name] = value;
  }
  return flags;
}

function validDay(text) {
  return /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(Date.parse(`${text}T00:00:00Z`)) && new Date(`${text}T00:00:00Z`).toISOString().startsWith(text);
}

function validOn([, key, version, ...rest]) {
  const flags = flagsOf(rest);
  if (!flags || !KEY.test(key) || !store.VERSION_RE.test(version ?? '')) return false;
  const only = flags['--only']?.split(',');
  if (only && (only.length > MAX_ONLY || !only.every(k => store.KEY_RE.test(k) && k.startsWith(`${key}-`)))) return false;
  if (flags['--fix-version'] !== undefined && !parseList(flags['--fix-version'])) return false;
  return flags['--base'] === undefined || validDay(flags['--base']);
}

function validBugs(args) {
  const [sub, key, version] = args;
  if (sub === 'on') return args.length >= 3 && validOn(args);
  if (sub === 'off') return args.length === 3 && KEY.test(key) && store.VERSION_RE.test(version);
  if (sub === 'status') return args.length === 1 || (args.length === 2 && KEY.test(key));
  if (sub === 'poll') return args.length === 2 && KEY.test(key);
  if (sub === 'reset-dry') return args.length === 3 && KEY.test(key) && store.VERSION_RE.test(version);
  return false;
}

const ID = /^[1-9]\d{0,14}$/;
const validBatch = args => (args.length === 1 && ID.test(args[0])) || (args.length === 2 && args[0] === 'park' && ID.test(args[1]));

function turnOn(ctx, [, key, version, ...rest], now) {
  const project = loadedProject(ctx, key);
  const flags = flagsOf(rest);
  store.ensureVersion(ctx.db, { project: key, version });
  if (flags['--base']) {
    ctx.db.prepare('UPDATE versions SET baseline_at = ? WHERE project = ? AND version = ?').run(Date.parse(`${flags['--base']}T00:00:00+07:00`), key, version);
  }
  const row = polling.setPolling(ctx.db, key, version, true, now);
  const only = flags['--only']?.split(',');
  if (only) kv.set(ctx.db, onlyKey(key, version), only, now);
  else kv.del(ctx.db, onlyKey(key, version));
  if (flags['--fix-version']) kv.set(ctx.db, namesKey(key, version), parseList(flags['--fix-version']), now);
  else kv.del(ctx.db, namesKey(key, version));
  return [
    `Đã bật theo dõi bug ${key} ${version}, mốc tính bug ${clock(row.baselineAt)}`,
    only ? `Chỉ nhận: ${only.join(', ')}` : 'Nhận mọi bug của bản',
    `Version Jira: ${[version, ...(kv.get(ctx.db, namesKey(key, version)) ?? [])].join(', ')}`,
    project.live ? 'Project live: sẽ ghi ra Jira và GitHub' : 'Project chạy khô: không ghi gì ra ngoài',
  ];
}

function turnOff(ctx, [, key, version], now) {
  loadedProject(ctx, key);
  if (!store.getVersion(ctx.db, key, version)) throw new ExpectedError(`chưa có version ${key} ${version}`);
  polling.setPolling(ctx.db, key, version, false, now);
  return [`Đã tắt theo dõi bug ${key} ${version}`];
}

async function pollOnce(ctx, [, key], now) {
  const project = loadedProject(ctx, key);
  const versions = store.listVersions(ctx.db, key).filter(v => v.state === 'open');
  if (!versions.length) throw new ExpectedError(`${key} chưa có version nào, chạy dz bugs on ${key} <version> trước`);
  const lines = [];
  for (const version of versions) {
    const result = await pollVersion(ctx, project, version, now);
    lines.push(`${key} ${version.version}: ${result.accepted.length} ticket mới, ${result.skipped.length} bị bỏ qua`);
  }
  return lines;
}

function versionLines(ctx, version) {
  const row = version;
  const lines = [`  ${row.version}: polling ${row.polling ? 'bật' : 'tắt'}, mốc ${row.baselineAt ? clock(row.baselineAt) : 'chưa có'}, poll gần nhất ${row.lastPollAt ? clock(row.lastPollAt) : 'chưa'}, build hỏng ${row.buildFailures}`];
  const only = kv.get(ctx.db, onlyKey(row.project, row.version));
  if (only) lines.push(`    chỉ nhận: ${only.join(', ')}`);
  for (const batch of store.listBatches(ctx.db, { project: row.project, version: row.version, states: ['open', 'running'] })) {
    lines.push(`    đợt #${batch.id} ${batch.kind} ${batch.data?.phase ?? 'open'}: ${batch.keys.join(', ')}`);
  }
  const counts = {};
  for (const ticket of store.listTickets(ctx.db, { project: row.project, version: row.version })) counts[ticket.state] = (counts[ticket.state] ?? 0) + 1;
  if (Object.keys(counts).length) lines.push(`    ticket: ${Object.entries(counts).map(([state, n]) => `${state} ${n}`).join(', ')}`);
  const release = kv.get(ctx.db, releaseKey(row.project, row.version));
  if (release) lines.push(`    release: ${release.ready}, điều kiện ${(release.flags ?? []).map((ok, i) => `${i + 1}${ok === true ? '✓' : ok === false ? '✗' : '?'}`).join(' ')}`);
  return lines;
}

function status(ctx, [, key]) {
  const keys = key ? [loadedProject(ctx, key).key] : ctx.db.prepare('SELECT DISTINCT project FROM versions ORDER BY project').all().map(r => r.project);
  if (!keys.length) return ['Chưa bật theo dõi bug cho project nào'];
  return keys.flatMap(k => {
    const backoff = kv.get(ctx.db, backoffKey(k));
    return [
      k,
      ...(backoff ? [`  Jira lỗi ${backoff.failures} lần liên tiếp (X06), thử lại lúc ${clock(backoff.until)}`] : []),
      ...store.listVersions(ctx.db, k).flatMap(v => versionLines(ctx, v)),
    ];
  });
}

async function resetDry(ctx, [, key, version]) {
  const project = loadedProject(ctx, key);
  const run = ctx.bugs.resetDry ?? require('./bugs/reset-dry.cjs').resetDry;
  const result = await run(ctx, project, version);
  const detail = result && typeof result === 'object' ? [JSON.stringify(result)] : [];
  return [`Đã dọn dấu vết chạy khô của ${key} ${version} (reset-dry)`, ...detail];
}

async function bugs(ctx, args, now) {
  if (args[0] === 'reset-dry') return resetDry(ctx, args);
  if (args[0] === 'on') return turnOn(ctx, args, now);
  if (args[0] === 'off') return turnOff(ctx, args, now);
  if (args[0] === 'poll') return pollOnce(ctx, args, now);
  return status(ctx, args);
}

function park(ctx, id, now) {
  const found = store.getBatch(ctx.db, Number(id));
  if (!found) throw new ExpectedError(`không có đợt #${id}`);
  if (store.FINISHED.includes(found.state)) throw new ExpectedError(`đợt #${id} đã ${found.state}, không gác được`);
  (ctx.bugs.requestPark ?? require('./bugs/park-request.cjs').requestPark)(ctx.db, found.id, now);
  return [`Đã yêu cầu gác đợt #${id}, service gác ở nhịp tiếp theo`];
}

function batch(ctx, args, now) {
  if (args[0] === 'park') return park(ctx, args[1], now);
  const [id] = args;
  const found = store.getBatch(ctx.db, Number(id));
  if (!found) throw new ExpectedError(`không có đợt #${id}`);
  const lines = [`Đợt #${found.id} ${found.project} ${found.version} (${found.kind}): ${found.state}, pha ${found.data?.phase ?? 'open'}`];
  for (const key of found.keys) {
    const ticket = store.getTicket(ctx.db, found.project, key);
    lines.push(`- ${key}: ${ticket ? `${ticket.state}${ticket.verdict ? `, ${ticket.verdict}` : ''}` : 'chưa có'}`);
  }
  const rows = ctx.db.prepare('SELECT code, action, evidence, at FROM decisions WHERE evidence LIKE ? OR evidence LIKE ? ORDER BY id DESC LIMIT 10')
    .all(`%"batchId":${found.id},%`, `%"batchId":${found.id}}%`);
  if (rows.length) lines.push('Quyết định gần nhất:');
  for (const row of rows.reverse()) lines.push(`- ${clock(row.at)} ${row.code} ${row.action} ${String(row.evidence).slice(0, 200)}`);
  return lines;
}

module.exports = { bugs, batch, validBugs, validBatch };
