const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../src/db.cjs');

function setup(t) {
  const dzHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dz-newapp-')));
  t.after(() => fs.rmSync(dzHome, { recursive: true, force: true }));
  for (const dir of ['workspaces', 'projects', 'secrets']) fs.mkdirSync(path.join(dzHome, dir));
  const ctx = { dzHome, projectsDir: path.join(dzHome, 'projects'), secretsDir: path.join(dzHome, 'secrets'), db: openDb(path.join(dzHome, 'dz.db')) };
  t.after(() => ctx.db.close());
  return ctx;
}

const APP = {
  key: 'AIP900',
  name: 'Demo Learn',
  package: 'demolearn',
  applicationId: 'com.apero.demolearn',
  repo: 'apero/demo-learn',
  firebaseProjectId: 'apero-demolearn',
  testerGroup: 'internal-testers',
  jiraProject: 'AIP900',
  signing: 'release',
  discord: { channelId: '423456789012345678', po: '123456789012345678', qa: '223456789012345678', devOnCall: '323456789012345678' },
  optional: { ads: 'temporary', license: 'temporary', api: 'temporary' },
};

const app = (patch = {}) => ({ ...APP, ...patch, discord: { ...APP.discord, ...patch.discord }, optional: { ...APP.optional, ...patch.optional } });

function secretFile(ctx, key, name, content, mode = 0o600) {
  const dir = path.join(ctx.secretsDir, 'newapp', key);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, name);
  fs.writeFileSync(file, content, { mode });
  fs.chmodSync(file, mode);
  return file;
}

const services = (applicationId = APP.applicationId, projectId = APP.firebaseProjectId) =>
  JSON.stringify({ project_info: { project_id: projectId }, client: [{ client_info: { android_client_info: { package_name: applicationId } } }] });

function fullSecrets(ctx, key = APP.key) {
  secretFile(ctx, key, 'google-services.json', services());
  secretFile(ctx, key, 'signing.properties', 'storeFile=release.keystore\nstorePassword=hunter2pass\nkeyAlias=release\nkeyPassword=hunter2pass\n');
  secretFile(ctx, key, 'release.keystore', 'fake');
}

function deps(patch = {}) {
  const calls = [];
  return {
    calls,
    repo: {
      async lsRemote(repo) {
        calls.push(['lsRemote', repo]);
        return 0;
      },
      async permissions(repo) {
        calls.push(['permissions', repo]);
        return { push: true };
      },
    },
    jira: {
      async search(jql) {
        calls.push(['search', jql]);
        return [];
      },
    },
    keytool({ password }) {
      calls.push(['keytool']);
      if (password !== 'hunter2pass') throw new Error('keystore password was incorrect');
    },
    harnessCommit: () => 'b4f5855',
    ...patch,
  };
}

const states = result => Object.fromEntries(result.items.map(i => [i.id, i.state]));

module.exports = { setup, app, deps, secretFile, fullSecrets, services, states, APP };
