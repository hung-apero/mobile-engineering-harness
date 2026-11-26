const fs = require('fs');
const path = require('path');

let cached;
function current() {
  if (cached === undefined) {
    try {
      cached = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.claude-plugin', 'plugin.json'), 'utf8')).version || null;
    } catch {
      cached = null;
    }
  }
  return cached;
}

function compare(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i += 1) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

function assertNotOlder(state, running = current(), env = process.env) {
  if (!state.pluginVersion || !running || env.LEARN_APP_ALLOW_OLDER === '1') return;
  if (compare(running, state.pluginVersion) >= 0) return;
  throw new Error(`learn-app đang chạy bản ${running} (${path.join(__dirname, '..')}) nhưng .learn-app đã được bản ${state.pluginVersion} ghi. Bản cũ sẽ ghi sai kết quả. Cập nhật plugin (/plugin update learn-app) rồi mở lại phiên Claude Code. Chắc chắn muốn chạy bản cũ: đặt LEARN_APP_ALLOW_OLDER=1.`);
}

function assertRoot(root) {
  let state;
  try {
    state = JSON.parse(fs.readFileSync(path.join(root, '.learn-app', 'state.json'), 'utf8'));
  } catch {
    return;
  }
  assertNotOlder(state);
}

function stamp(state, running = current()) {
  if (running && (!state.pluginVersion || compare(running, state.pluginVersion) > 0)) state.pluginVersion = running;
  return state;
}

module.exports = { current, compare, assertNotOlder, assertRoot, stamp };
