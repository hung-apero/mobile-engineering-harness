const defaultDevices = require('../devices.cjs');
const kv = require('../kv.cjs');
const { firstLine } = require('../redact.cjs');
const { readJournal, installedByUs, removedByUs } = require('./journal.cjs');

const MAX_TRIES = 16;
const slug = text => text.replace(/[^A-Za-z0-9]/g, '-');
const prefixOf = (project, version) => `spec:e2e-${project.key}-${slug(version)}:`;
const ownKey = (serial, pkg) => `e2e-device:${serial}:${pkg}`;
const devicesOf = ctx => ctx.e2e?.devices ?? defaultDevices;
const stateOf = (ctx, project, serial) => devicesOf(ctx).packageState({ serial, pkg: project.package, adb: ctx.e2e?.adb });

function isOurs(ctx, project, serial, found) {
  if (!found.present) return true;
  const known = kv.get(ctx.db, ownKey(serial, project.package));
  return found.lastUpdate !== null && known?.lastUpdate === found.lastUpdate;
}

async function tryLock(ctx, project, version, reinstall, skip) {
  const devices = devicesOf(ctx);
  const { dzHome } = ctx;
  const prefix = prefixOf(project, version);
  const serial = await devices.pick({ dzHome, project, adb: ctx.e2e?.adb, only: project.e2eDevices ?? [], skip });
  if (!serial || skip.includes(serial) || !project.e2eDevices?.includes(serial)) return null;
  const lock = await devices.acquire({ dzHome, holder: `${prefix}run`, serial });
  if (!lock) return { skip: serial };
  const clean = isOurs(ctx, project, serial, await stateOf(ctx, project, serial));
  if (clean || reinstall) return { lock: { ...lock, clean } };
  await devices.releaseAll({ dzHome, prefix });
  return { skip: serial, taken: true };
}

async function lockDevice(ctx, project, version, { reinstall }) {
  const skip = [];
  const taken = [];
  try {
    await devicesOf(ctx).releaseAll({ dzHome: ctx.dzHome, prefix: prefixOf(project, version) });
    while (skip.length < MAX_TRIES) {
      const found = await tryLock(ctx, project, version, reinstall, skip);
      if (!found) break;
      if (found.lock) return found.lock;
      skip.push(found.skip);
      if (found.taken) taken.push(found.skip);
    }
  } catch (error) {
    await devicesOf(ctx).releaseAll({ dzHome: ctx.dzHome, prefix: prefixOf(project, version) }).catch(() => {});
    return { reason: firstLine(error) };
  }
  return { reason: taken.length ? `app ${project.package} đã có sẵn trên ${taken.join(', ')}, không gỡ khi e2e/${project.key}.json chưa ghi reinstall: true` : 'không có máy rảnh trong e2eDevices' };
}

async function rememberApp(ctx, project, { serial, clean, root }, now) {
  const key = ownKey(serial, project.package);
  const journal = readJournal(root);
  if (!installedByUs(journal)) return;
  kv.del(ctx.db, key);
  if (!clean && !removedByUs(journal)) return;
  try {
    const { present, lastUpdate } = await stateOf(ctx, project, serial);
    if (present && lastUpdate) kv.set(ctx.db, key, { lastUpdate }, now);
  } catch {}
}

const freeDevice = (ctx, project, version) => devicesOf(ctx).releaseAll({ dzHome: ctx.dzHome, prefix: prefixOf(project, version) });

module.exports = { lockDevice, rememberApp, freeDevice, prefixOf };
