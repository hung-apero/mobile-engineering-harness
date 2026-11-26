const devices = require('../devices.cjs');
const { decide, closeWaits } = require('./kit.cjs');
const { buildOf, saveBuild, devWait } = require('./build-kit.cjs');
const { firstLine } = require('../redact.cjs');

const RETRY_MS = 2 * 60 * 1000;
const toolsOf = run => run.ctx.specs.devices ?? devices;
const prefixOf = spec => `spec:${spec.id}:`;

async function attempt(run) {
  const tools = toolsOf(run);
  const { dzHome } = run.ctx;
  try {
    await tools.releaseAll({ dzHome, prefix: prefixOf(run.spec) });
    const serial = await tools.pick({ dzHome, project: run.project, adb: run.ctx.specs.adb });
    const lock = serial ? await tools.acquire({ dzHome, holder: `${prefixOf(run.spec)}run`, serial }) : null;
    return lock ?? { reason: 'không có máy rảnh' };
  } catch (error) {
    return { reason: firstLine(error) };
  }
}

async function leaseDevice(run) {
  if ((buildOf(run).deviceAt ?? 0) > run.now) return null;
  const lock = await attempt(run);
  if (!lock.reason) {
    closeWaits(run.db, run.spec.id, run.now, 'device');
    saveBuild(run, { deviceAt: 0, device: lock });
    return lock;
  }
  if (!buildOf(run).deviceAt) decide(run, 'F05', 'spec-no-device', { reason: lock.reason });
  devWait(run, 'device', `thiếu thiết bị nên chưa chạy thử và chưa gửi bản cài (F05): ${lock.reason}`);
  saveBuild(run, { deviceAt: run.now + RETRY_MS });
  return null;
}

async function freeDevice(run) {
  if (!buildOf(run).device) return;
  await toolsOf(run).releaseAll({ dzHome: run.ctx.dzHome, prefix: prefixOf(run.spec) });
  saveBuild(run, { device: null });
}

module.exports = { leaseDevice, freeDevice };
