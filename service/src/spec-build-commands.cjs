const store = require('./specs/store.cjs');
const bugs = require('./bugs/store.cjs');
const { isClosed } = require('./bugs/closing.cjs');
const { parsePrereqs, suggestionsOf, label, PrereqError } = require('./specs/prereq.cjs');
const { sourceChange } = require('./specs/change.cjs');
const { isBuilding } = require('./specs/build-kit.cjs');
const { closeWaits } = require('./specs/kit.cjs');
const { record } = require('./decisions.cjs');
const { ruleVersionOf } = require('./bugs/effects.cjs');
const { loadedProject } = require('./commands.cjs');
const { ExpectedError } = require('./run.cjs');

const ID = /^[1-9]\d{0,14}$/;

function validBuild([id, flag, version, ...rest]) {
  return ID.test(id ?? '') && flag === '--version' && bugs.VERSION_RE.test(version ?? '') && rest.length === 0;
}

function prereqFlags(args) {
  const out = { prs: [], branches: [], clear: false };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--clear') out.clear = true;
    else if (args[i] === '--pr' && args[i + 1]) out.prs.push(args[++i]);
    else if (args[i] === '--branch' && args[i + 1]) out.branches.push(args[++i]);
    else return null;
  }
  return out.clear && (out.prs.length || out.branches.length) ? null : out;
}

const validPrereq = ([id, ...rest]) => ID.test(id ?? '') && prereqFlags(rest) !== null;

function note(ctx, spec, action, evidence, now) {
  record(ctx.db, { project: spec.project, code: 'F03', ruleVersion: ruleVersionOf(ctx, spec.project), evidence: { specId: spec.id, ...evidence }, action }, now);
}

function listLines(ctx, spec, project) {
  const list = spec.data.prerequisites ?? [];
  const suggested = suggestionsOf(spec, project.repo);
  return [
    ...(list.length ? ['Điều kiện trước:', ...list.map(item => `- ${label(item)}`)] : ['Chưa đặt điều kiện trước nào']),
    ...(suggested.length ? ['Gợi ý từ nội dung spec (chưa áp dụng):', ...suggested.map(flag => `- dz spec prereq ${spec.id} ${flag}`)] : []),
  ];
}

function build(ctx, spec, [, , version], now) {
  const project = loadedProject(ctx, spec.project);
  if (spec.state !== 'approved') throw new ExpectedError(`spec #${spec.id} đang ở ${spec.state}, chỉ bắt đầu code spec đã duyệt`);
  if (bugs.getVersion(ctx.db, spec.project, version)?.state === 'closed' || isClosed(ctx.db, spec.project, version)) throw new ExpectedError(`bản ${version} đã đóng`);
  const next = store.transitionSpec(ctx.db, spec.id, ['approved'], 'waiting-prereq', now, { data: { build: { version, at: now, notes: {}, fixes: 0, uidiff: { round: 1 } } } });
  if (!next) throw new ExpectedError(`spec #${spec.id} vừa chuyển trạng thái, chạy lại lệnh`);
  note(ctx, spec, 'spec-build', { version, approvedSha: spec.approvedSha, live: project.live === true }, now);
  return [`Spec #${spec.id} sẽ được code cho bản ${version}${project.live ? '' : ' (chạy khô: không push, không PR, không gửi bản cài)'}`, ...listLines(ctx, next, project)];
}

function prereq(ctx, spec, [, ...rest], now) {
  const project = loadedProject(ctx, spec.project);
  const flags = prereqFlags(rest);
  if (!rest.length) return listLines(ctx, spec, project);
  let list;
  try {
    list = parsePrereqs(flags, project.repo);
  } catch (error) {
    if (error instanceof PrereqError) throw new ExpectedError(error.message);
    throw error;
  }
  const next = store.patchData(ctx.db, spec.id, { prerequisites: list }, now);
  closeWaits(ctx.db, spec.id, now, 'prereq');
  note(ctx, spec, 'spec-prereq', { prerequisites: list.map(label) }, now);
  return listLines(ctx, next, project);
}

function refreshBuilding(ctx, spec, { markdown, rawSha }, now) {
  const change = sourceChange(ctx.db, spec, { markdown, rawSha }, now);
  if (!change) return [`Spec #${spec.id} chỉ đổi khoảng trắng`];
  record(ctx.db, { project: spec.project, code: 'S04', ruleVersion: ruleVersionOf(ctx, spec.project), evidence: { specId: spec.id, from: spec.state, ...change }, action: 'spec-changed-while-building' }, now);
  return [`Spec #${spec.id} đổi khi đang code: PO duyệt phần đổi (${change.names.join(', ')})`, 'Duyệt xong thì phần đổi gửi lại cho đoạn code'];
}

module.exports = { build, prereq, validBuild, validPrereq, refreshBuilding, isBuilding };
