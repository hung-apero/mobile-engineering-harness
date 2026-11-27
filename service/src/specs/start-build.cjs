const store = require('./store.cjs');
const bugs = require('../bugs/store.cjs');
const { isClosed } = require('../bugs/closing.cjs');
const { record } = require('../decisions.cjs');
const { ruleVersionOf } = require('../bugs/effects.cjs');
const { closeWaits } = require('./kit.cjs');

const AUTO_WAIT = 'auto-build';

const versionClosed = (db, project, version) => bugs.getVersion(db, project, version)?.state === 'closed' || isClosed(db, project, version);

function startBuild(ctx, spec, version, now, evidence = {}) {
  if (spec.state !== 'approved') return { problem: `spec #${spec.id} đang ở ${spec.state}, chỉ bắt đầu code spec đã duyệt` };
  if (versionClosed(ctx.db, spec.project, version)) return { problem: `bản ${version} đã đóng` };
  const data = { build: { version, at: now, notes: {}, fixes: 0, uidiff: { round: 1 } }, autoBuild: null };
  const next = store.transitionSpec(ctx.db, spec.id, ['approved'], 'waiting-prereq', now, { data });
  if (!next) return { problem: `spec #${spec.id} vừa chuyển trạng thái, chạy lại lệnh` };
  closeWaits(ctx.db, spec.id, now, AUTO_WAIT);
  record(ctx.db, { project: spec.project, code: 'F03', ruleVersion: ruleVersionOf(ctx, spec.project), evidence: { specId: spec.id, version, approvedSha: spec.approvedSha, ...evidence }, action: 'spec-build' }, now);
  return { next };
}

module.exports = { startBuild, versionClosed, AUTO_WAIT };
