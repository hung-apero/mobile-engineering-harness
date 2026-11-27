const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const kv = require('../src/kv.cjs');
const { loadProjects } = require('../src/projects.cjs');
const newapp = require('../src/newapp/index.cjs');
const { setup, app, deps, fullSecrets, secretFile, services } = require('./newapp-fixtures.cjs');

const SPEC = { specUrl: 'https://example.com/spec', figmaUrl: 'https://figma.com/file/x' };
const target = (ctx, key = 'AIP900') => path.join(ctx.projectsDir, `${key}.yaml`);

test('start creates a 700 secret dir, stores the draft in kv and returns the checklist', t => {
  const ctx = setup(t);
  const { items } = newapp.start(ctx, app(), 5);
  assert.equal(items.length, 15);
  const dir = path.join(ctx.secretsDir, 'newapp', 'AIP900');
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(kv.get(ctx.db, 'newapp:AIP900').repo, 'apero/demo-learn');
  assert.equal(fs.existsSync(target(ctx)), false);
});

test('start refuses an existing project and a bad key', t => {
  const ctx = setup(t);
  fs.writeFileSync(target(ctx), 'key: AIP900\n');
  assert.throws(() => newapp.start(ctx, app(), 5), /đã tồn tại/);
  assert.throws(() => newapp.start(ctx, app({ key: 'abc' }), 5), /app\.key/);
  assert.equal(fs.readFileSync(target(ctx), 'utf8'), 'key: AIP900\n');
});

test('status shows unchecked before verify and the last result after', async t => {
  const ctx = setup(t);
  newapp.start(ctx, app(), 5);
  assert.ok(newapp.status(ctx, 'AIP900').items.every(i => i.state === 'unchecked'));
  fullSecrets(ctx);
  await newapp.verifyAll(ctx, app(), 9, deps());
  const view = newapp.status(ctx, 'AIP900');
  assert.equal(view.ok, true);
  assert.equal(view.checkedAt, 9);
  assert.ok(view.items.every(i => i.state === 'ok'));
});

test('create writes a disabled, dry project that loadProjects accepts', async t => {
  const ctx = setup(t);
  newapp.start(ctx, app(), 5);
  fullSecrets(ctx);
  const { file, temporary } = await newapp.create(ctx, 'AIP900', SPEC, 10, deps());
  assert.equal(file, target(ctx));
  assert.deepEqual(temporary, ['optional-ads', 'optional-license', 'optional-api']);
  const { projects, errors } = loadProjects(ctx.projectsDir, { dzHome: ctx.dzHome });
  assert.deepEqual(errors, []);
  const project = projects.get('AIP900');
  assert.equal(project.enabled, false);
  assert.equal(project.live, false);
  assert.equal(project.package, 'com.apero.demolearn');
  assert.equal(project.people.po, '123456789012345678');
  assert.equal(project.channel, '423456789012345678');
  assert.equal(project.harnessCommit, 'b4f5855');
  assert.deepEqual(fs.readdirSync(ctx.projectsDir), ['AIP900.yaml']);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('create with one item missing names exactly that item and writes nothing', async t => {
  const ctx = setup(t);
  newapp.start(ctx, app(), 5);
  secretFile(ctx, 'AIP900', 'google-services.json', services());
  await assert.rejects(newapp.create(ctx, 'AIP900', SPEC, 10, deps()), error => {
    assert.match(error.message, /^chưa đủ mục, không tạo project: signing \(missing\)/);
    assert.doesNotMatch(error.message, /google-services|repo-empty/);
    return true;
  });
  assert.deepEqual(fs.readdirSync(ctx.projectsDir), []);
});

test('create rejects a google-services.json with the wrong package and writes nothing', async t => {
  const ctx = setup(t);
  newapp.start(ctx, app(), 5);
  fullSecrets(ctx);
  secretFile(ctx, 'AIP900', 'google-services.json', services('com.other.app'));
  await assert.rejects(newapp.create(ctx, 'AIP900', SPEC, 10, deps()), /google-services \(wrong\)/);
  assert.deepEqual(fs.readdirSync(ctx.projectsDir), []);
});

test('create never overwrites an existing project file', async t => {
  const ctx = setup(t);
  newapp.start(ctx, app(), 5);
  fullSecrets(ctx);
  fs.writeFileSync(target(ctx), 'keep: me\n');
  await assert.rejects(newapp.create(ctx, 'AIP900', SPEC, 10, deps()), /đã tồn tại/);
  assert.equal(fs.readFileSync(target(ctx), 'utf8'), 'keep: me\n');
  assert.deepEqual(fs.readdirSync(ctx.projectsDir), ['AIP900.yaml']);
});

test('create refuses a spec that loadProjects rejects and leaves no file', async t => {
  const ctx = setup(t);
  newapp.start(ctx, app(), 5);
  fullSecrets(ctx);
  await assert.rejects(newapp.create(ctx, 'AIP900', { specUrl: '', figmaUrl: 'x' }, 10, deps()), /không hợp lệ/);
  assert.deepEqual(fs.readdirSync(ctx.projectsDir), []);
});

test('create without start fails clearly', async t => {
  const ctx = setup(t);
  await assert.rejects(newapp.create(ctx, 'AIP900', SPEC, 10, deps()), /chưa có danh sách/);
});

test('prerequisites: code needs the repo and identity, distribution needs Firebase', async t => {
  const ctx = setup(t);
  newapp.start(ctx, app(), 5);
  assert.deepEqual(newapp.prerequisites(ctx, 'AIP900'), { code: false, distribute: false });
  secretFile(ctx, 'AIP900', 'google-services.json', services());
  await newapp.verifyAll(ctx, app(), 6, deps());
  assert.deepEqual(newapp.prerequisites(ctx, 'AIP900'), { code: true, distribute: true });
  await newapp.verifyAll(ctx, app(), 7, deps({ repo: { lsRemote: async () => 2, permissions: async () => ({ push: true }) } }));
  assert.deepEqual(newapp.prerequisites(ctx, 'AIP900'), { code: false, distribute: true });
});
