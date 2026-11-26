const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadProjects } = require('../src/projects.cjs');
const { setup, yamlFor, write, COMMANDS } = require('./projects-fixtures.cjs');

test('valid file loads', () => {
  const { dzHome, dir } = setup();
  write(dir, 'ABC1.yaml', yamlFor('ABC1', dzHome));
  const { projects, errors } = loadProjects(dir, { dzHome });
  assert.deepEqual(errors, []);
  assert.deepEqual({ ...projects.get('ABC1') }, {
    key: 'ABC1',
    repo: 'apero/learn-app',
    base: 'main',
    checkout: path.join(fs.realpathSync(dzHome), 'workspaces', 'ABC1'),
    flavor: 'appDev',
    package: 'com.apero.learn',
    jiraStatus: { waiting: ['To Do', 'Open'], inProgress: 'In Progress', resolved: 'Done', reopened: 'Reopened', done: ['Closed', 'Done'] },
    people: { po: '123456789012345678', qa: '223456789012345678', devOnCall: '323456789012345678' },
    specUrl: 'https://example.com/spec',
    figmaUrl: 'https://figma.com/file/x',
    excludedDevices: ['emulator-5554'],
    enabled: true,
    live: false,
    discord: false,
    localFiles: ['local.properties'],
    commands: COMMANDS,
    harnessCommit: 'b4f5855',
    forbidden: ['**/billing/**'],
    schedulable: true,
  });
});

test('missing field reports the field and skips only that project', () => {
  const { dzHome, dir } = setup();
  write(dir, 'GOOD1.yaml', yamlFor('GOOD1', dzHome));
  write(dir, 'BAD1.yaml', yamlFor('BAD1', dzHome, { flavor: undefined }));
  const { projects, errors } = loadProjects(dir, { dzHome });
  assert.deepEqual([...projects.keys()], ['GOOD1']);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].file, 'BAD1.yaml');
  assert.match(errors[0].message, /flavor/);
});

test('one broken file does not stop the others', () => {
  const { dzHome, dir } = setup();
  write(dir, 'AAA1.yaml', yamlFor('AAA1', dzHome));
  write(dir, 'BBB1.yaml', 'key: [unclosed\n');
  write(dir, 'CCC1.yaml', yamlFor('CCC1', dzHome));
  const { projects, errors } = loadProjects(dir, { dzHome });
  assert.deepEqual([...projects.keys()].sort(), ['AAA1', 'CCC1']);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].file, 'BBB1.yaml');
});

test('checkout outside DZ_HOME/workspaces is rejected, including via .. and symlink', () => {
  const { root, dzHome, dir } = setup();
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(dzHome, 'workspaces', 'link'));
  const cases = {
    PLAIN1: path.join(root, 'elsewhere', 'PLAIN1'),
    DOTS1: path.join(dzHome, 'workspaces', '..', 'outside', 'DOTS1'),
    LINK1: path.join(dzHome, 'workspaces', 'link', 'LINK1'),
    SELF1: path.join(dzHome, 'workspaces'),
    REL1: 'workspaces/REL1',
  };
  for (const [key, checkout] of Object.entries(cases)) write(dir, `${key}.yaml`, yamlFor(key, dzHome, { checkout }));
  write(dir, 'OK1.yaml', yamlFor('OK1', dzHome));
  const { projects, errors } = loadProjects(dir, { dzHome });
  assert.deepEqual([...projects.keys()], ['OK1']);
  assert.equal(errors.length, 5);
  for (const e of errors) assert.match(e.message, /checkout/);
});

test('numeric YAML discord id is rejected', () => {
  const { dzHome, dir } = setup();
  write(dir, 'NUM1.yaml', yamlFor('NUM1', dzHome, { people: { po: '123456789012345678', qa: '"223456789012345678"', devOnCall: '"323456789012345678"' } }));
  write(dir, 'SHORT1.yaml', yamlFor('SHORT1', dzHome, { people: { po: '"123"', qa: '"223456789012345678"', devOnCall: '"323456789012345678"' } }));
  const { projects, errors } = loadProjects(dir, { dzHome });
  assert.equal(projects.size, 0);
  assert.equal(errors.length, 2);
  for (const e of errors) assert.match(e.message, /people\.po/);
});

test('.sample files are ignored', () => {
  const { dzHome, dir } = setup();
  write(dir, 'example.yaml.sample', 'not: valid');
  write(dir, 'ABC1.yml', yamlFor('ABC1', dzHome));
  write(dir, 'README.md', '# x');
  const { projects, errors } = loadProjects(dir, { dzHome });
  assert.equal(projects.size, 0);
  assert.deepEqual(errors, []);
});

test('enabled: false loads but is not schedulable', () => {
  const { dzHome, dir } = setup();
  write(dir, 'OFF1.yaml', yamlFor('OFF1', dzHome, { enabled: false }));
  const { projects, errors } = loadProjects(dir, { dzHome });
  assert.deepEqual(errors, []);
  assert.equal(projects.get('OFF1').enabled, false);
  assert.equal(projects.get('OFF1').schedulable, false);
});

test('key must match the file name and the key pattern', () => {
  const { dzHome, dir } = setup();
  write(dir, 'AAA1.yaml', yamlFor('BBB1', dzHome));
  write(dir, 'lower.yaml', yamlFor('lower', dzHome));
  const { projects, errors } = loadProjects(dir, { dzHome });
  assert.equal(projects.size, 0);
  assert.equal(errors.length, 2);
  for (const e of errors) assert.match(e.message, /key/);
});

test('unknown fields are errors', () => {
  const { dzHome, dir } = setup();
  write(dir, 'TOP1.yaml', yamlFor('TOP1', dzHome) + 'surprise: 1\n');
  write(dir, 'NEST1.yaml', yamlFor('NEST1', dzHome, { jiraStatus: { waiting: ['a'], inProgress: 'b', resolved: 'c', reopened: 'd', done: ['e'], extra: 'x' } }));
  const { projects, errors } = loadProjects(dir, { dzHome });
  assert.equal(projects.size, 0);
  assert.match(errors.find(e => e.file === 'TOP1.yaml').message, /surprise/);
  assert.match(errors.find(e => e.file === 'NEST1.yaml').message, /jiraStatus\.extra/);
});

test('missing enabled reports enabled and is never defaulted', () => {
  const { dzHome, dir } = setup();
  write(dir, 'NOEN1.yaml', yamlFor('NOEN1', dzHome, { enabled: undefined }));
  const { projects, errors } = loadProjects(dir, { dzHome });
  assert.equal(projects.size, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /enabled/);
});

test('optional fields default and poBackup is validated', () => {
  const { dzHome, dir } = setup();
  write(dir, 'DEF1.yaml', yamlFor('DEF1', dzHome, { excludedDevices: undefined }));
  const ok = '"123456789012345678"';
  const mk = poBackup => ({ po: ok, poBackup, qa: ok, devOnCall: ok });
  write(dir, 'BKP1.yaml', yamlFor('BKP1', dzHome, { people: mk('"423456789012345678"') }));
  write(dir, 'BKP2.yaml', yamlFor('BKP2', dzHome, { people: mk('"abc"') }));
  const { projects, errors } = loadProjects(dir, { dzHome });
  assert.deepEqual(projects.get('DEF1').excludedDevices, []);
  assert.equal(projects.get('BKP1').people.poBackup, '423456789012345678');
  assert.equal(projects.get('DEF1').people.poBackup, undefined);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /people\.poBackup/);
});

test('dangling symlink, symlink loop and non-directory ancestor in checkout are rejected', () => {
  const { root, dzHome, dir } = setup();
  const ws = path.join(dzHome, 'workspaces');
  fs.symlinkSync(path.join(root, 'not-yet'), path.join(ws, 'DANG1'));
  fs.symlinkSync(path.join(ws, 'LOOP2'), path.join(ws, 'LOOP1'));
  fs.symlinkSync(path.join(ws, 'LOOP1'), path.join(ws, 'LOOP2'));
  fs.writeFileSync(path.join(ws, 'FILE1'), '');
  const cases = { DANG1: path.join(ws, 'DANG1'), DANG2: path.join(ws, 'DANG1', 'sub'), LOOP1: path.join(ws, 'LOOP1', 'x'), FILE1: path.join(ws, 'FILE1', 'x') };
  for (const [key, checkout] of Object.entries(cases)) write(dir, `${key}.yaml`, yamlFor(key, dzHome, { checkout }));
  write(dir, 'OK1.yaml', yamlFor('OK1', dzHome));
  const { projects, errors } = loadProjects(dir, { dzHome });
  assert.deepEqual([...projects.keys()], ['OK1']);
  assert.equal(errors.length, 4);
  for (const e of errors) assert.match(e.message, /checkout/);
});

test('the sample file parses once renamed and filled', () => {
  const { dzHome, dir } = setup();
  const sample = fs.readFileSync(path.join(__dirname, '..', 'projects', 'example.yaml.sample'), 'utf8')
    .replaceAll('$DZ_HOME', dzHome);
  write(dir, 'EXAMPLE.yaml', sample);
  const { projects, errors } = loadProjects(dir, { dzHome });
  assert.deepEqual(errors, []);
  assert.ok(projects.has('EXAMPLE'));
});

function rejected(overrides) {
  const { dzHome, dir } = setup();
  write(dir, 'NEW1.yaml', yamlFor('NEW1', dzHome, overrides));
  const { projects, errors } = loadProjects(dir, { dzHome });
  return { projects, errors };
}

test('live is required and must be a boolean', () => {
  for (const live of [undefined, 'false', 0]) {
    const { projects, errors } = rejected({ live });
    assert.equal(projects.size, 0);
    assert.match(errors[0].message, /live/);
  }
});

test('localFiles and forbidden default to empty; localFiles must be relative without ..', () => {
  const ok = rejected({ localFiles: undefined, forbidden: undefined });
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.projects.get('NEW1').localFiles, []);
  assert.deepEqual(ok.projects.get('NEW1').forbidden, []);
  for (const localFiles of [['/etc/passwd'], ['../x'], ['a/../../x']]) {
    assert.match(rejected({ localFiles }).errors[0].message, /localFiles/);
  }
});

test('commands requires argv arrays for compile, unitTest, assemble and a string apkGlob', () => {
  for (const name of ['compile', 'unitTest', 'assemble', 'apkGlob']) {
    const { projects, errors } = rejected({ commands: { ...COMMANDS, [name]: undefined } });
    assert.equal(projects.size, 0);
    assert.match(errors[0].message, new RegExp(`commands\\.${name}`));
  }
  assert.match(rejected({ commands: { ...COMMANDS, compile: [] } }).errors[0].message, /commands\.compile/);
  assert.match(rejected({ commands: { ...COMMANDS, lint: 'x' } }).errors[0].message, /commands\.lint/);
  const ok = rejected({ commands: { ...COMMANDS, lint: ['a'], distribute: ['b'] } });
  assert.deepEqual(ok.projects.get('NEW1').commands.lint, ['a']);
});

test('harnessCommit must be 7-40 hex characters', () => {
  for (const harnessCommit of [undefined, 'xyz1234', 'abc12', 'a'.repeat(41)]) {
    assert.match(rejected({ harnessCommit }).errors[0].message, /harnessCommit/);
  }
  assert.deepEqual(rejected({ harnessCommit: 'a'.repeat(40) }).errors, []);
});

test('jiraStatus.done is required as a non-empty string list', () => {
  const base = { waiting: ['To Do'], inProgress: 'a', resolved: 'b', reopened: 'c' };
  assert.match(rejected({ jiraStatus: base }).errors[0].message, /jiraStatus\.done/);
  assert.match(rejected({ jiraStatus: { ...base, done: [] } }).errors[0].message, /jiraStatus\.done/);
});

test('channel and roles are optional Discord ids; people stay', () => {
  const ok = rejected({ channel: '423456789012345678', roles: { po: '523456789012345678', dev: '623456789012345678' } });
  assert.deepEqual(ok.errors, []);
  const loaded = ok.projects.get('NEW1');
  assert.equal(loaded.channel, '423456789012345678');
  assert.deepEqual(loaded.roles, { po: '523456789012345678', dev: '623456789012345678' });
  assert.equal(loaded.people.po, '123456789012345678');
  for (const channel of [423456789012345, '123', '', '423456789012345678/x']) assert.match(rejected({ channel }).errors[0].message, /channel/);
  for (const roles of [{ po: 'PO' }, { po: 5 }, { boss: '523456789012345678' }, [], 'x']) assert.match(rejected({ roles }).errors[0].message, /roles/);
});

test('an overlay file next to the project is not read as a project', () => {
  const { dzHome, dir } = setup();
  fs.writeFileSync(path.join(dir, 'ABC1.yaml'), yamlFor('ABC1', dzHome));
  fs.writeFileSync(path.join(dir, 'ABC1.overlay.yaml'), 'product: abc1\n');
  const { projects, errors } = loadProjects(dir, { dzHome });
  assert.deepEqual([[...projects.keys()], errors], [['ABC1'], []]);
});
