const { isBuilding } = require('./build-kit.cjs');
const { openItems, openRound, countsOf, ROLE_NAMES } = require('./provisional.cjs');
const { createRun } = require('./kit.cjs');

const countLine = counts => Object.entries(counts).filter(([, n]) => n > 0).map(([role, n]) => `${ROLE_NAMES[role]} ${n}`).join(' · ');

function askNow(ctx, project, spec, now) {
  if (!isBuilding(spec) || spec.state === 'landing') return { ok: false, error: `spec #${spec.id} đang ở ${spec.state}, chưa có câu phát sinh khi code để gửi` };
  const open = openItems(spec).length;
  if (!open) return { ok: false, error: `spec #${spec.id} không còn câu nào chờ chốt` };
  openRound(createRun(ctx, project, spec, now), `ask-${now}`);
  return { ok: true, count: open, line: `Đã gửi ${open} câu chờ chốt của spec #${spec.id}: ${countLine(countsOf(spec))}` };
}

module.exports = { askNow, countLine };
