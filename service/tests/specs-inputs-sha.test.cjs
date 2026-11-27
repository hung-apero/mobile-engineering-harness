const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const files = require('../src/specs/repo-files.cjs');

function repoWith(t, entries) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'dz-sha-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  fs.mkdirSync(path.join(repo, '.harness-run', 'inputs'), { recursive: true });
  for (const [name, bytes] of Object.entries(entries)) fs.writeFileSync(path.join(repo, '.harness-run', 'inputs', name), bytes);
  return repo;
}

test('inputsSha never blocks on a fifo and still changes when one appears', t => {
  const repo = repoWith(t, { 'spec-v1.md': '# a\n' });
  const before = files.inputsSha(repo);
  execFileSync('mkfifo', [path.join(repo, '.harness-run', 'inputs', 'x')]);
  const out = spawnSync(process.execPath, ['-e', `process.stdout.write(require(${JSON.stringify(require.resolve('../src/specs/repo-files.cjs'))}).inputsSha(${JSON.stringify(repo)}))`], { timeout: 5000, encoding: 'utf8' });
  assert.equal(out.signal, null);
  assert.match(out.stdout, /^[0-9a-f]{64}$/);
  assert.notEqual(out.stdout, before);
});

test('inputsSha tells apart different invalid bytes', t => {
  const a = files.inputsSha(repoWith(t, { 'spec-v1.md': Buffer.from([0xff, 0x01]) }));
  const b = files.inputsSha(repoWith(t, { 'spec-v1.md': Buffer.from([0xfe, 0x01]) }));
  assert.notEqual(a, b);
});
