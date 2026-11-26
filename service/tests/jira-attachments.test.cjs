const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createJira } = require('../src/bugs/jira.cjs');
const { createFakeJira } = require('./fixtures/fake-jira.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dz-att-'));
const big = Buffer.alloc(10 * 1024 * 1024 + 1).toString('latin1');

test('attachments keep only image/txt/log/json under 10 MB, sanitise names and stay inside dir', async () => {
  const fake = createFakeJira({ issues: { 'A-1': { status: 'Open', files: [
    { name: 'shot.png', data: 'png' },
    { name: 'crash.log', data: 'log' },
    { name: 'run.apk', data: 'apk' },
    { name: 'huge.txt', data: big },
    { name: '../../evil name!.json', data: '{}' },
  ] } } });
  const jira = createJira({ configFile: '/none', live: true, record() {}, connect: fake.connect });
  const dir = tmp();
  const saved = await jira.attachments('A-1', dir);
  const files = fs.readdirSync(dir).sort();
  assert.deepEqual(files, ['crash.log', 'evil_name_.json', 'shot.png']);
  assert.equal(saved.length, 3);
  assert.ok(saved.every(f => path.resolve(f).startsWith(path.resolve(dir) + path.sep)));
  assert.ok(!fs.existsSync(path.join(dir, '..', '..', 'evil name!.json')));
});
