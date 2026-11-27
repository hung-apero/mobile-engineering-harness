const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { checklist } = require('../src/newapp/items.cjs');
const { verifyAll } = require('../src/newapp/index.cjs');
const { setup, app, deps, secretFile, fullSecrets, services, states } = require('./newapp-fixtures.cjs');

const check = async (t, patch, d = deps(), prepare = fullSecrets) => {
  const ctx = setup(t);
  prepare?.(ctx);
  return { ctx, d, result: await verifyAll(ctx, app(patch), 1000, d) };
};

test('checklist lists every item with Vietnamese text and the secret file path', () => {
  const items = checklist(app());
  assert.deepEqual(items.map(i => i.id), ['repo-empty', 'repo-writable', 'app-key', 'app-package', 'app-application-id', 'app-name', 'google-services', 'firebase-tester-group', 'signing', 'jira-project', 'discord-channel', 'discord-people', 'optional-ads', 'optional-license', 'optional-api']);
  assert.match(items.find(i => i.id === 'google-services').file, /^\$DZ_HOME\/secrets\/newapp\/AIP900\/google-services\.json$/);
  assert.match(items.find(i => i.id === 'google-services').text, /600/);
  assert.equal(items.filter(i => !i.required).length, 3);
});

test('a complete valid app passes every required item', async t => {
  const { result, d } = await check(t, {});
  assert.equal(result.ok, true);
  assert.ok(result.items.every(i => i.state === 'ok'), JSON.stringify(result.items.filter(i => i.state !== 'ok')));
  assert.deepEqual(d.calls.filter(c => c[0] !== 'keytool').map(c => c[0]), ['lsRemote', 'permissions', 'search']);
});

test('a non-empty repo is wrong and a read-only repo is wrong', async t => {
  const empty = await check(t, {}, deps({ repo: { lsRemote: async () => 3, permissions: async () => ({ push: false, pull: true }) } }));
  assert.equal(empty.result.ok, false);
  assert.equal(states(empty.result)['repo-empty'], 'wrong');
  assert.equal(states(empty.result)['repo-writable'], 'wrong');
});

test('a repo that cannot be read is wrong with a redacted one-line reason', async t => {
  const { result } = await check(t, {}, deps({ repo: { lsRemote: async () => { throw new Error('fatal: token ghp_abcdef123456\nsecond line'); }, permissions: async () => ({ push: true }) } }));
  const item = result.items.find(i => i.id === 'repo-empty');
  assert.equal(item.state, 'wrong');
  assert.doesNotMatch(item.detail, /ghp_|second line/);
});

test('key, package, application id and name formats are checked and missing values are missing', async t => {
  const { result } = await check(t, { key: 'abc', package: 'Bad-Pkg', applicationId: 'com.only', name: 'x'.repeat(61) });
  const s = states(result);
  assert.deepEqual([s['app-key'], s['app-package'], s['app-application-id'], s['app-name']], ['wrong', 'wrong', 'wrong', 'wrong']);
  const gone = await check(t, { package: undefined, name: undefined });
  assert.deepEqual([states(gone.result)['app-package'], states(gone.result)['app-name']], ['missing', 'missing']);
});

test('google-services.json with another package is wrong and names both packages', async t => {
  const { result } = await check(t, {}, deps(), ctx => {
    fullSecrets(ctx);
    secretFile(ctx, 'AIP900', 'google-services.json', services('com.other.app'));
  });
  const item = result.items.find(i => i.id === 'google-services');
  assert.equal(item.state, 'wrong');
  assert.match(item.detail, /com\.other\.app/);
  assert.match(item.detail, /com\.apero\.demolearn/);
  assert.equal(result.ok, false);
});

test('google-services.json missing, broken JSON, wrong project id and loose mode are each rejected', async t => {
  assert.equal(states((await check(t, {}, deps(), null)).result)['google-services'], 'missing');
  const broken = await check(t, {}, deps(), ctx => { fullSecrets(ctx); secretFile(ctx, 'AIP900', 'google-services.json', '{nope'); });
  assert.equal(states(broken.result)['google-services'], 'wrong');
  const project = await check(t, {}, deps(), ctx => { fullSecrets(ctx); secretFile(ctx, 'AIP900', 'google-services.json', services(undefined, 'other-project')); });
  assert.equal(states(project.result)['google-services'], 'wrong');
  const loose = await check(t, {}, deps(), ctx => { fullSecrets(ctx); secretFile(ctx, 'AIP900', 'google-services.json', services(), 0o644); });
  assert.match(loose.result.items.find(i => i.id === 'google-services').detail, /600/);
});

test('tester group must be present and well formed', async t => {
  assert.equal(states((await check(t, { testerGroup: undefined })).result)['firebase-tester-group'], 'missing');
  assert.equal(states((await check(t, { testerGroup: 'bad group!' })).result)['firebase-tester-group'], 'wrong');
});

test('signing: missing, wrong password, dev-only, and a good keystore; the password never appears in the result', async t => {
  assert.equal(states((await check(t, {}, deps(), ctx => secretFile(ctx, 'AIP900', 'google-services.json', services()))).result).signing, 'missing');
  const bad = await check(t, {}, deps(), ctx => {
    fullSecrets(ctx);
    secretFile(ctx, 'AIP900', 'signing.properties', 'storeFile=release.keystore\nstorePassword=nottherightone\nkeyAlias=a\nkeyPassword=nottherightone\n');
  });
  assert.equal(states(bad.result).signing, 'wrong');
  assert.doesNotMatch(JSON.stringify(bad.result), /nottherightone/);
  const dev = await check(t, { signing: 'dev-only' }, deps(), null);
  assert.equal(states(dev.result).signing, 'ok');
  const good = await check(t, {});
  assert.equal(states(good.result).signing, 'ok');
  assert.doesNotMatch(JSON.stringify(good.result), /hunter2pass/);
});

test('signing.properties with missing fields is wrong and a storeFile escaping the secrets dir falls back to release.keystore', async t => {
  const partial = await check(t, {}, deps(), ctx => { fullSecrets(ctx); secretFile(ctx, 'AIP900', 'signing.properties', 'storeFile=release.keystore\nstorePassword=hunter2pass\n'); });
  assert.equal(states(partial.result).signing, 'wrong');
  const seen = [];
  const spy = deps({ keytool: ({ keystore }) => seen.push(keystore) });
  await check(t, {}, spy, ctx => { fullSecrets(ctx); secretFile(ctx, 'AIP900', 'signing.properties', 'storeFile=../../../etc/passwd\nstorePassword=hunter2pass\nkeyAlias=a\nkeyPassword=hunter2pass\n'); });
  assert.equal(seen.length, 1);
  assert.match(seen[0], /newapp\/AIP900\/release\.keystore$/);
});

test('Jira project that cannot be read is wrong; bad key format is wrong; missing is missing', async t => {
  const refused = await check(t, {}, deps({ jira: { search: async () => { throw new Error('403 forbidden'); } } }));
  assert.equal(states(refused.result)['jira-project'], 'wrong');
  assert.equal(states((await check(t, { jiraProject: 'bad-key' })).result)['jira-project'], 'wrong');
  const other = await check(t, { jiraProject: 'AAP864' });
  assert.equal(states(other.result)['jira-project'], 'wrong');
  assert.match(other.result.items.find(i => i.id === 'jira-project').detail, /AIP900/);
  assert.equal(states((await check(t, { jiraProject: undefined })).result)['jira-project'], 'missing');
});

test('discord channel and people ids are format checked', async t => {
  const s = states((await check(t, { discord: { channelId: '12ab', po: '1' } })).result);
  assert.equal(s['discord-channel'], 'wrong');
  assert.equal(s['discord-people'], 'wrong');
  const none = states((await check(t, { discord: { channelId: undefined, po: undefined } })).result);
  assert.equal(none['discord-channel'], 'missing');
  assert.equal(none['discord-people'], 'missing');
});

test('optional keys may be temporary, are listed for replacement, and do not block ok', async t => {
  const { result } = await check(t, { optional: { ads: undefined, license: 'temporary', api: 'provided' } });
  const s = states(result);
  assert.equal(s['optional-license'], 'ok');
  assert.match(result.items.find(i => i.id === 'optional-license').detail, /thay trước khi lên store/);
  assert.equal(s['optional-ads'], 'missing');
  assert.equal(s['optional-api'], 'missing');
  assert.equal(result.ok, true);
});

test('a provided optional key is ok once product-secrets.properties carries it with mode 600', async t => {
  const { result } = await check(t, { optional: { license: 'provided' } }, deps(), ctx => {
    fullSecrets(ctx);
    secretFile(ctx, 'AIP900', 'product-secrets.properties', 'apero.licenseKey=abc123\n');
  });
  assert.equal(states(result)['optional-license'], 'ok');
  const loose = await check(t, { optional: { license: 'provided' } }, deps(), ctx => {
    fullSecrets(ctx);
    secretFile(ctx, 'AIP900', 'product-secrets.properties', 'apero.licenseKey=abc123\n', 0o644);
  });
  assert.equal(states(loose.result)['optional-license'], 'wrong');
});

test('a thrown dependency error becomes wrong, never a crash', async t => {
  const { result } = await check(t, {}, deps({ jira: { search: async () => { throw new TypeError('boom'); } } }));
  assert.equal(result.ok, false);
});

test('the key alias and the key password are checked with keytool, not only the store password', async t => {
  const seen = [];
  const good = await check(t, {}, deps({ keytool: args => seen.push(args) }));
  assert.equal(states(good.result).signing, 'ok');
  assert.deepEqual([seen[0].alias, seen[0].keyPassword], ['release', 'hunter2pass']);
  const alias = await check(t, {}, deps({ keytool: ({ alias }) => { if (alias) throw new Error('alias does not exist'); } }));
  assert.equal(states(alias.result).signing, 'wrong');
  assert.match(alias.result.items.find(i => i.id === 'signing').detail, /keyAlias|keyPassword/);
});

test('the real keytool is asked for the alias and a certificate request, with no password on the command line', () => {
  const { keytoolCalls } = require('../src/newapp/default-deps.cjs');
  const calls = keytoolCalls({ keystore: '/k', password: 'p1', alias: 'release', keyPassword: 'p2' });
  assert.deepEqual(calls.map(call => call.args[0]), ['-list', '-certreq']);
  assert.deepEqual(calls[1].args, ['-certreq', '-keystore', '/k', '-alias', 'release', '-storepass:env', 'DZ_NEWAPP_STOREPASS', '-keypass:env', 'DZ_NEWAPP_KEYPASS']);
  assert.ok(!calls.some(call => /p1|p2/.test(call.args.join(' '))));
  assert.throws(() => keytoolCalls({ keystore: '/k', password: 'p', alias: '-x', keyPassword: 'p' }), /keyAlias/);
});

test('a PKCS12 keystore with a key password of its own is refused, as Gradle cannot open it', t => {
  const ctx = require('./newapp-fixtures.cjs').setup(t);
  const { secretFile } = require('./newapp-fixtures.cjs');
  const keystore = secretFile(ctx, 'AIP900', 'release.keystore', Buffer.from('3082aaaa', 'hex'));
  const { defaultDeps } = require('../src/newapp/default-deps.cjs');
  assert.throws(() => defaultDeps({}).keytool({ keystore, password: 'aaaaaa', alias: 'release', keyPassword: 'bbbbbb' }), /PKCS12/);
});
