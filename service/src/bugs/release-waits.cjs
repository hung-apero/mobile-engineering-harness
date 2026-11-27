const { resolveWait } = require('../pings.cjs');
const { openTracked, adoptDry } = require('./dry-release-waits.cjs');
const { record } = require('../decisions.cjs');
const { ruleVersionOf } = require('./effects.cjs');
const { isClosed, buildsAfterClose, MAX_BUILDS } = require('./closing.cjs');

const PO_WAITS = ['defer', 'stuckPo'];
const ownWaits = state => new Set(PO_WAITS.map(name => state?.waits?.[name]).filter(id => id != null));

function setWait(ctx, project, state, name, wanted, role, subject, now) {
  const id = state.waits[name];
  if (wanted && id == null) {
    state.waits[name] = openTracked(ctx, project, { role, subject }, now);
    return true;
  }
  if (!wanted && id != null) {
    resolveWait(ctx.db, id, now);
    delete state.waits[name];
  }
  return false;
}

function note(ctx, project, code, action, evidence, now) {
  record(ctx.db, { project: project.key, code, ruleVersion: ruleVersionOf(ctx, project.key), evidence, action }, now);
}

function askDefer(ctx, project, state, name, result, now) {
  const keys = result.pendingLow;
  const wanted = isClosed(ctx.db, project.key, name) && keys.length > 0;
  const shown = `${keys.slice(0, 5).join(', ')}${keys.length > 5 ? ` và ${keys.length - 5} bug khác` : ''}`;
  if (setWait(ctx, project, state, 'defer', wanted, 'po', `Bản ${name}: chọn hoãn bug Medium/Low sang bản sau (${shown}) (R03)`, now)) note(ctx, project, 'R03', 'ask-defer', { version: name, keys: keys.slice(0, 50) }, now);
}

function warnStuck(ctx, project, state, name, result, now) {
  const builds = buildsAfterClose(ctx.db, project.key, name);
  const missing = result.conditions.filter(c => c.ok !== true && !(c.n === 1 && result.ready === 'merge')).map(c => c.n);
  const wanted = builds >= MAX_BUILDS && missing.length > 0;
  const subject = `Bản ${name}: đã ${builds} bản build sau khi đóng mà còn thiếu điều kiện ${missing.join(', ')} (R04)`;
  const opened = setWait(ctx, project, state, 'stuckPo', wanted, 'po', subject, now);
  setWait(ctx, project, state, 'stuckDev', wanted, 'dev', subject, now);
  if (opened) note(ctx, project, 'R04', 'release-stuck', { version: name, builds, missing }, now);
}

function afterClose(ctx, project, version, state, result, now) {
  adoptDry(ctx, project, state, now);
  const name = version.version;
  setWait(ctx, project, state, 'merge', result.ready === 'merge', 'dev', `Nhánh version ${name}: đủ điều kiện 2–6, dev merge PR vào nhánh gốc (R01)`, now);
  setWait(ctx, project, state, 'release', result.ready === 'release', 'dev', `Bản ${name} đủ điều kiện release (R01)`, now);
  askDefer(ctx, project, state, name, result, now);
  warnStuck(ctx, project, state, name, result, now);
}

module.exports = { afterClose, ownWaits, setWait };
