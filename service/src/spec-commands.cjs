const fs = require('node:fs');
const path = require('node:path');
const jobs = require('./jobs.cjs');
const kv = require('./kv.cjs');
const store = require('./specs/store.cjs');
const { createFacade, cleanFigma } = require('./specs/facade.cjs');
const { loadSource } = require('./specs/intake.cjs');
const { hashText } = require('./text-hash.cjs');
const { refreshSpec, FROM } = require('./specs/refresh.cjs');
const { fresh, NAMES } = require('./specs/segment.cjs');
const { openItems } = require('./specs/provisional.cjs');
const { closeWaits, linkFor, webBase, nameOf } = require('./specs/kit.cjs');
const building = require('./spec-build-commands.cjs');
const { cancelSpec } = require('./specs/cancel.cjs');
const { askNow } = require('./specs/ask-now.cjs');
const { record } = require('./decisions.cjs');
const { ruleVersionOf } = require('./bugs/effects.cjs');
const { clearParked } = require('./blocks.cjs');
const { failuresKey } = require('./launch.cjs');
const { loadedProject } = require('./commands.cjs');
const { ExpectedError } = require('./run.cjs');
const { clock } = require('./status.cjs');

const KEY = /^[A-Z][A-Z0-9]+$/;
const ID = /^[1-9]\d{0,14}$/;
const SUBS = { show: validId, link: validId, refresh: validId, retry: validRetry, cancel: validId, ask: validId, build: building.validBuild, prereq: building.validPrereq, list: args => args.length === 0 || (args.length === 1 && KEY.test(args[0])) };

function validId(args) {
  return args.length === 1 && ID.test(args[0]);
}

function validRetry([id, ...rest]) {
  return ID.test(id ?? '') && (rest.length === 0 || (rest.length === 2 && rest[0] === '--figma'));
}

function flagsOf(rest) {
  const flags = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!['--project', '--figma'].includes(rest[i]) || rest[i + 1] === undefined || Object.hasOwn(flags, rest[i])) return null;
    flags[rest[i]] = rest[i + 1];
  }
  return flags;
}

function validSpec([first, ...rest]) {
  if (first === undefined || first.startsWith('-')) return false;
  if (Object.hasOwn(SUBS, first)) return SUBS[first](rest);
  return KEY.test(flagsOf(rest)?.['--project'] ?? '');
}

function expected(work) {
  try {
    return work();
  } catch (error) {
    if (['INVALID', 'STATE', 'NOT_FOUND'].includes(error.code)) throw new ExpectedError(error.message);
    throw error;
  }
}

function specOf(ctx, id) {
  const spec = store.getSpec(ctx.db, Number(id));
  if (!spec) throw new ExpectedError(`không có spec #${id}`);
  return spec;
}

function create(ctx, [ref, ...rest], now) {
  const flags = flagsOf(rest);
  const project = loadedProject(ctx, flags['--project']);
  const source = path.isAbsolute(ref) ? { type: 'path', ref } : { type: 'url', ref };
  const spec = expected(() => createFacade(ctx).newSpec({ project: project.key, source, figma: flags['--figma'] ?? null, title: null }, now));
  return [`Đã nhận spec #${spec.id} của ${project.key}`, project.live ? 'Project live' : `Project chạy khô: không comment Confluence${project.discord ? ', Discord vẫn bật' : ', không Discord'}`];
}

function list(ctx, [key]) {
  const specs = store.listSpecs(ctx.db, key ? { project: key } : {});
  return specs.length ? specs.map(spec => `#${spec.id} ${spec.project} ${spec.state} lần hỏi ${spec.round}: ${spec.title || 'chưa có tên'} (${clock(spec.updatedAt)})`) : ['Chưa có spec nào'];
}

function show(ctx, [id]) {
  const spec = specOf(ctx, id);
  const { data } = spec;
  const { build } = data;
  const counts = Object.values(data.answered ?? {}).reduce((out, { kind }) => ({ ...out, [kind]: (out[kind] ?? 0) + 1 }), {});
  return [
    `Spec ${nameOf(spec)} của ${spec.project}: ${spec.state}, lần hỏi ${spec.round}`,
    `Nguồn: ${spec.source.type} ${spec.source.ref ?? ''}`,
    ...(data.repo ? [`Bản clone: ${data.repo}`] : []),
    ...(data.segment ? [`Đoạn: ${data.segment.name} #${data.segment.serial}, lần ${data.segment.tries}`] : []),
    ...(data.questions?.length ? [`Câu hỏi: ${data.questions.length}; PO trả lời ${counts.po ?? 0}, agent tự chốt ${counts.agent ?? 0}`] : []),
    ...(spec.state === 'needs-input' ? [`Cần bổ sung (${data.needs.kind}): ${data.needs.reason}`] : []),
    ...(spec.state === 'parked' ? [`Đang gác: ${data.parked.reason}`] : []),
    ...(spec.approvedSha ? [`Đã duyệt bản ${spec.approvedSha}`] : []),
    ...(build ? [`Code cho bản ${build.version}${build.candidate ? `, bản cài số ${build.candidate.n} commit ${build.candidate.sha.slice(0, 12)}` : ''}`] : []),
    ...(build?.missing?.length && spec.state === 'waiting-prereq' ? [`Chờ: ${build.missing.join('; ')}`] : []),
    ...(spec.state === 'landed-dry' ? [`Đã gộp khi chạy khô; muốn gộp thật: dz bugs reset-dry ${spec.project} ${build.version}, rồi PO duyệt lại bản cài`] : []),
    ...(data.change && data.change.state !== 'applied' ? [`Spec đổi đang chờ: ${data.change.names.join(', ')}`] : []),
  ];
}

function link(ctx, [id], now) {
  const spec = specOf(ctx, id);
  const inBuild = building.isBuilding(spec);
  if (!['quiz', 'review', 'approved'].includes(spec.state) && !inBuild) throw new ExpectedError(`spec #${id} đang ở ${spec.state}, chưa có link cho PO`);
  const quiz = spec.state === 'quiz' || (inBuild && openItems(spec).length > 0);
  return [...(quiz ? [linkFor(ctx, spec.id, 'quiz', now)] : []), ...(quiz && !inBuild ? [] : [linkFor(ctx, spec.id, 'review', now)])];
}

async function refresh(ctx, [id], now) {
  const spec = specOf(ctx, id);
  const project = loadedProject(ctx, spec.project);
  const inBuild = building.isBuilding(spec);
  if (!FROM.includes(spec.state) && (!inBuild || spec.state === 'landing')) throw new ExpectedError(`spec #${id} đang ở ${spec.state}, chờ xong đoạn này rồi chạy lại`);
  if (spec.source.type === 'pasted') throw new ExpectedError('spec dán tay không đọc lại được, hãy gửi spec mới');
  const { markdown } = await loadSource(spec.source, { confluence: ctx.specs.confluence(project) });
  if (spec.data.rawSha === hashText(markdown)) return [`Spec #${id} không đổi so với nguồn`];
  if (inBuild) return building.refreshBuilding(ctx, spec, { markdown, rawSha: hashText(markdown) }, now);
  if (!refreshSpec(ctx, spec, now)) throw new ExpectedError(`spec #${id} vừa chuyển trạng thái, chạy lại lệnh`);
  record(ctx.db, { project: project.key, code: 'S04', ruleVersion: ruleVersionOf(ctx, project.key), evidence: { specId: spec.id, from: spec.state, approvedSha: spec.approvedSha }, action: 'spec-refreshed' }, now);
  return [`Spec #${id} đã đổi: đọc lại từ đầu kèm câu trả lời cũ, lời duyệt cũ hết hiệu lực`];
}

function ask(ctx, [id], now) {
  const spec = specOf(ctx, id);
  const sent = askNow(ctx, loadedProject(ctx, spec.project), spec, now);
  if (!sent.ok) throw new ExpectedError(sent.error);
  return [sent.line];
}

async function cancel(ctx, [id], now) {
  const { from } = await cancelSpec(ctx, specOf(ctx, id).id, now);
  return [`Spec #${id} đã huỷ (từ ${from})`];
}

function retryJob(ctx, job, now) {
  jobs.retry(ctx.db, job.id, now);
  kv.del(ctx.db, failuresKey(job.id));
  clearParked(ctx.db, job.id, now);
}

function retry(ctx, [id, , figma], now) {
  const spec = specOf(ctx, id);
  if (!['needs-input', 'parked'].includes(spec.state)) throw new ExpectedError(`spec #${id} đang ở ${spec.state}, không cần chạy lại`);
  const held = spec.state === 'parked' ? spec.data.parked : spec.data.needs;
  const job = held.jobId ? jobs.getJob(ctx.db, held.jobId) : null;
  if (figma !== undefined && spec.data.build) throw new ExpectedError(`spec #${id} đã vào bước code, không đổi Figma được`);
  const link = figma === undefined ? null : expected(() => cleanFigma(figma));
  const target = link ? 'reading' : held.from;
  const name = NAMES[target];
  const keepJob = !link && job?.state === 'parked';
  const data = { needs: null, parked: null, readAt: 0, readFailures: 0, ...(link && { figma: link }), ...(name && !keepJob && fresh(spec, name)), ...(spec.data.build && { build: { ...spec.data.build, fixes: 0, deviceAt: 0, launches: 0, landingTries: 0 } }) };
  if (!store.transitionSpec(ctx.db, spec.id, [spec.state], target, now, { data })) throw new ExpectedError(`spec #${id} vừa chuyển trạng thái, chạy lại lệnh`);
  if (keepJob) retryJob(ctx, job, now);
  for (const prefix of ['needs', 'parked']) closeWaits(ctx.db, spec.id, now, prefix);
  return [`Spec #${id} chạy lại từ ${target}`];
}

async function spec(ctx, args, now) {
  const [first, ...rest] = args;
  if (first === 'build') return building.build(ctx, specOf(ctx, rest[0]), rest, now);
  if (first === 'prereq') return building.prereq(ctx, specOf(ctx, rest[0]), rest, now);
  const run = { list, show, link, refresh, retry, cancel, ask }[Object.hasOwn(SUBS, first) ? first : ''];
  return run ? run(ctx, rest, now) : create(ctx, args, now);
}

function web(ctx) {
  const file = path.join(ctx.secretsDir, 'web-operator-token');
  const info = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!info?.isFile()) throw new ExpectedError('trang web chưa chạy, chạy dz run trước');
  return [`${webBase(ctx)}/?k=${fs.readFileSync(file, 'utf8').trim()}`];
}

module.exports = { spec, web, validSpec };
