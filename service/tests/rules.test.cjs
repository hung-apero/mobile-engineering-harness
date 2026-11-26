const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadRules, createRuleStore, RuleError } = require('../src/rules.cjs');

const DEFAULT_FILE = path.join(__dirname, '..', 'rules', 'default.yaml');

function tmpRules(files = {}, withDefault = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dz-rules-'));
  if (withDefault) fs.copyFileSync(DEFAULT_FILE, path.join(dir, 'default.yaml'));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}

test('default file loads with the values above', () => {
  const dir = tmpRules();
  const loaded = loadRules(dir);
  assert.deepEqual(loaded.limits, { code_agents_working: 2, code_agents_off: 3, reserved_for_bug: 1, build: 1, bugs_per_project: 2, batch: { max_bugs: 8, max_hours: 4 } });
  assert.deepEqual(loaded.rules, {
    P01: { every_working_hours: 4, backup_from_ping: 3, daily_after_ping: 3 },
    P02: { every_working_days: 1 },
    P03: { every_working_days: 1 },
    X01: { stop_new_at: 0.8 },
    X02: { silent_minutes: 30, max_resumes: 1 },
    X05: { min_free_gb: 15 },
    X07: { max_consecutive_failures: 3 },
    B09: { reopen_limit: 3 },
    F01: { fix_rounds: 2 },
    F07: { max_pr_lines: 400 },
    Q03: { max_build_failures: 4 },
    Q06: { quiet_hours: 24 },
  });
  assert.match(loaded.version, /^[0-9a-f]{12}$/);
  assert.deepEqual(loadRules(dir, 'NOPE').rules, loaded.rules);
});

test('project file overrides one number and keeps the rest', () => {
  const dir = tmpRules({ 'ABC1.yaml': 'rules:\n  P01: { every_working_hours: 2 }\n' });
  const loaded = loadRules(dir, 'ABC1');
  assert.equal(loaded.rules.P01.every_working_hours, 2);
  assert.equal(loaded.rules.P01.backup_from_ping, 3);
  assert.equal(loaded.rules.P02.every_working_days, 1);
});

test('unknown rule code, unknown field, wrong type and out-of-range each throw RuleError naming the path', () => {
  const cases = [
    ['rules:\n  Z99: { a: 1 }\n', 'rules.Z99'],
    ['rules:\n  P01: { nope: 1 }\n', 'rules.P01.nope'],
    ['rules:\n  P01: { every_working_hours: "4" }\n', 'rules.P01.every_working_hours'],
    ['rules:\n  P01: { every_working_hours: 2.5 }\n', 'rules.P01.every_working_hours'],
    ['rules:\n  P01: { every_working_hours: 0 }\n', 'rules.P01.every_working_hours'],
    ['rules:\n  X01: { stop_new_at: 1.5 }\n', 'rules.X01.stop_new_at'],
  ];
  for (const [text, expected] of cases) {
    const dir = tmpRules({ 'ABC1.yaml': text });
    assert.throws(() => loadRules(dir, 'ABC1'), err => {
      assert.ok(err instanceof RuleError);
      assert.equal(err.path, expected);
      assert.equal(path.basename(err.file), 'ABC1.yaml');
      return true;
    });
  }
  const dir = tmpRules();
  const text = fs.readFileSync(path.join(dir, 'default.yaml'), 'utf8').replace('  X05: { min_free_gb: 15 }\n', '');
  fs.writeFileSync(path.join(dir, 'default.yaml'), text);
  assert.throws(() => loadRules(dir), err => err instanceof RuleError && err.path === 'rules.X05');
});

test('project file may not set limits', () => {
  const dir = tmpRules({ 'ABC1.yaml': 'limits: { build: 2 }\n' });
  assert.throws(() => loadRules(dir, 'ABC1'), err => err instanceof RuleError && err.path === 'limits');
  const bad = tmpRules();
  const text = fs.readFileSync(path.join(bad, 'default.yaml'), 'utf8').replace('build: 1', 'build: -1');
  fs.writeFileSync(path.join(bad, 'default.yaml'), text);
  assert.throws(() => loadRules(bad), err => err instanceof RuleError && err.path === 'limits.build');
});

test('version changes when content changes and not when mtime changes', () => {
  const dir = tmpRules();
  const file = path.join(dir, 'default.yaml');
  const before = loadRules(dir).version;
  const future = new Date(Date.now() + 3600 * 1000);
  fs.utimesSync(file, future, future);
  assert.equal(loadRules(dir).version, before);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('min_free_gb: 15', 'min_free_gb: 20'));
  assert.notEqual(loadRules(dir).version, before);
  const projectless = loadRules(dir).version;
  fs.writeFileSync(path.join(dir, 'ABC1.yaml'), 'rules:\n  P02: { every_working_days: 2 }\n');
  assert.notEqual(loadRules(dir, 'ABC1').version, projectless);
});

test('broken edit keeps the last good rules and reports lastError; a fix clears it', () => {
  const dir = tmpRules();
  const store = createRuleStore(dir);
  const good = store.get('ABC1');
  assert.equal(store.lastError(), null);
  const file = path.join(dir, 'ABC1.yaml');
  fs.writeFileSync(file, 'rules:\n  P01: { every_working_hours: 999 }\n');
  const during = store.get('ABC1');
  assert.deepEqual(during, good);
  assert.ok(store.lastError() instanceof RuleError);
  assert.equal(store.lastError().path, 'rules.P01.every_working_hours');
  fs.writeFileSync(file, 'rules:\n  P01: { every_working_hours: 2 }\n');
  const fixed = store.get('ABC1');
  assert.equal(fixed.rules.P01.every_working_hours, 2);
  assert.notEqual(fixed.version, good.version);
  assert.equal(store.lastError(), null);
});

test('broken file at first load throws', () => {
  const dir = tmpRules({ 'ABC1.yaml': 'rules: [unclosed\n' });
  const store = createRuleStore(dir);
  assert.throws(() => store.get('ABC1'), RuleError);
  assert.ok(store.lastError() instanceof RuleError);
  assert.throws(() => loadRules(tmpRules({}, false)), RuleError);
});

test('batch limits are validated per field and required', () => {
  const bad = tmpRules();
  const text = fs.readFileSync(path.join(bad, 'default.yaml'), 'utf8').replace('max_bugs: 8', 'max_bugs: 0');
  fs.writeFileSync(path.join(bad, 'default.yaml'), text);
  assert.throws(() => loadRules(bad), err => err instanceof RuleError && err.path === 'limits.batch.max_bugs');
  const missing = tmpRules();
  const gone = fs.readFileSync(path.join(missing, 'default.yaml'), 'utf8').replace(', batch: { max_bugs: 8, max_hours: 4 }', '');
  fs.writeFileSync(path.join(missing, 'default.yaml'), gone);
  assert.throws(() => loadRules(missing), err => err instanceof RuleError && err.path === 'limits.batch.max_bugs');
});
