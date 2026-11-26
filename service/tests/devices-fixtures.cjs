const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FAKE_DEVICES = `import json, os, sys
def _file():
    d = os.environ["BUG_FIX_STATE_DIR"]
    os.makedirs(d, exist_ok=True)
    return os.path.join(d, "devices.json")
def _load():
    f = _file()
    return json.load(open(f)) if os.path.exists(f) else {}
def _save(data):
    json.dump(data, open(_file(), "w"))
def acquire(serial, holder, is_live=None, start=None):
    data = _load()
    cur = data.get(serial)
    if cur and cur["holder"] != holder:
        return False, cur["holder"], 1
    data[serial] = {"holder": holder, "since": 0}
    _save(data)
    return True, None, 0
def release(serial, holder, start=None):
    data = _load()
    if data.get(serial, {}).get("holder") == holder:
        del data[serial]
        _save(data)
        return True
    return False
def snapshot(start=None):
    return _load()
`;

function world(t, { adbOutput } = {}) {
  const dzHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dz-devices-')));
  t.after(() => fs.rmSync(dzHome, { recursive: true, force: true }));
  const scripts = path.join(dzHome, 'harness', 'skills', 'bug-fix', 'scripts');
  fs.mkdirSync(scripts, { recursive: true });
  fs.writeFileSync(path.join(scripts, 'devices.py'), FAKE_DEVICES);
  const bin = path.join(dzHome, 'fake-bin');
  fs.mkdirSync(bin);
  const log = path.join(dzHome, 'adb-calls.log');
  const adb = path.join(bin, 'adb');
  const out = adbOutput ?? 'List of devices attached\nAAA\tdevice\nBBB\toffline\nCCC\tunauthorized\nemulator-5554\tdevice\nDDD\tdevice\n\n';
  fs.writeFileSync(adb, `#!/bin/sh\necho "$@" >> '${log}'\nprintf '%s' '${out.replaceAll("'", '')}'\n`, { mode: 0o755 });
  const state = path.join(dzHome, 'bug-fix-state');
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []);
  const lock = (serial, holder) => {
    fs.mkdirSync(state, { recursive: true });
    const file = path.join(state, 'devices.json');
    const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    data[serial] = { holder, since: 0 };
    fs.writeFileSync(file, JSON.stringify(data));
  };
  const held = () => (fs.existsSync(path.join(state, 'devices.json')) ? JSON.parse(fs.readFileSync(path.join(state, 'devices.json'), 'utf8')) : {});
  return { dzHome, adb, bin, calls, lock, held, project: { key: 'AAP864', excludedDevices: [] } };
}

module.exports = { world };
