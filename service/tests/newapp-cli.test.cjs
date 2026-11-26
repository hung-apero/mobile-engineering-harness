const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { newapp, appFrom } = require('../src/newapp-commands.cjs');
const { ExpectedError } = require('../src/run.cjs');
const { setup, deps, fullSecrets, APP } = require('./newapp-fixtures.cjs');

const START = ['start', 'AIP900', '--name', 'Demo Learn', '--package', 'demolearn', '--application-id', 'com.apero.demolearn', '--repo', 'apero/demo-learn', '--firebase-project', 'apero-demolearn', '--tester-group', 'internal-testers', '--jira-project', 'AIP900', '--signing', 'release', '--discord-channel', APP.discord.channelId, '--po', APP.discord.po, '--qa', APP.discord.qa, '--dev', APP.discord.devOnCall, '--temporary', 'ads,license,api'];

test('appFrom maps flags to the app shape', () => {
  const app = appFrom('AIP900', START.slice(2));
  assert.equal(app.applicationId, 'com.apero.demolearn');
  assert.equal(app.discord.devOnCall, APP.discord.devOnCall);
  assert.deepEqual(app.optional, { ads: 'temporary', license: 'temporary', api: 'temporary' });
});

test('start then status then check then create runs the whole flow', async t => {
  const ctx = setup(t);
  const d = deps();
  const started = (await newapp(ctx, START, 1, d)).join('\n');
  assert.match(started, /\$DZ_HOME\/secrets\/newapp\/AIP900\/google-services\.json/);
  assert.match((await newapp(ctx, ['status', 'AIP900'], 2, d)).join('\n'), /unchecked/);
  assert.match((await newapp(ctx, ['check', 'AIP900'], 3, d))[0], /Còn thiếu/);
  fullSecrets(ctx);
  assert.equal((await newapp(ctx, ['check', 'AIP900'], 4, d))[0], 'Đủ mục bắt buộc');
  const created = (await newapp(ctx, ['create', 'AIP900', '--spec-url', 'https://example.com/s', '--figma-url', 'https://figma.com/f'], 5, d)).join('\n');
  assert.match(created, /enabled: false/);
  assert.match(created, /Thay trước khi lên store: optional-ads/);
  assert.ok(fs.existsSync(path.join(ctx.projectsDir, 'AIP900.yaml')));
});

test('create with a missing item is an ExpectedError naming the item', async t => {
  const ctx = setup(t);
  await newapp(ctx, START, 1, deps());
  await assert.rejects(newapp(ctx, ['create', 'AIP900', '--spec-url', 'a', '--figma-url', 'b'], 2, deps()), error => error instanceof ExpectedError && /google-services \(missing\)/.test(error.message));
  assert.deepEqual(fs.readdirSync(ctx.projectsDir), []);
});

test('unknown subcommand, missing key and duplicate flags are rejected', async t => {
  const ctx = setup(t);
  await assert.rejects(newapp(ctx, ['bogus', 'AIP900'], 1, deps()), /dùng: newapp/);
  await assert.rejects(newapp(ctx, ['start'], 1, deps()), /thiếu mã app/);
  await assert.rejects(newapp(ctx, ['start', 'AIP900', '--name', 'a', '--name', 'b'], 1, deps()), /không hợp lệ/);
});
