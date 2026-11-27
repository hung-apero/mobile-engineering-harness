const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { firebaseLink } = require('../src/bugs/firebase-link.cjs');
const { listBuilds } = require('../src/e2e/builds.cjs');
const { buildDir } = require('../src/handlers/build.cjs');
const { setup, VERSION } = require('./bugs-machine-fixtures.cjs');

const TESTERS = 'https://appdistribution.firebase.google.com/testerapps/1:2:android:3/releases/4?utm_source=gradle';
const CONSOLE = 'https://console.firebase.google.com/project/p/appdistribution/app/android:com.a.b/releases/4?utm_source=gradle';
const LOG = [
  '> Task :app:appDistributionUploadAppDevDebug', 'Uploading the APK.', 'Added release notes successfully. 200',
  `View this release in the Firebase console: ${CONSOLE}`,
  `Share this release with testers who have access: ${TESTERS}`,
  'Download the release binary (link expires in 1 hour): https://firebaseappdistribution.googleapis.com/app-binary-downloads/x?token=abc',
  'BUILD SUCCESSFUL in 20s',
].join('\n');

test('the testers link wins, the console link is the fallback, and the expiring binary link is never used', () => {
  assert.equal(firebaseLink(LOG), TESTERS);
  assert.equal(firebaseLink(LOG.replace(/^Share.*$/m, '')), CONSOLE);
  assert.equal(firebaseLink(LOG.replace(/^(Share|View).*$/gm, '')), null);
});

test('only https Firebase hosts are accepted', () => {
  const line = url => `Share this release with testers who have access: ${url}`;
  for (const url of ['http://appdistribution.firebase.google.com/x', 'https://evil.com/x', 'https://appdistribution.firebase.google.com.evil.com/x', 'https://a@appdistribution.firebase.google.com/x', 'https://appdistribution.firebase.google.com:8443/x', 'https://appdistribution.firebase.google.com/[~x]', 'javascript:alert(1)']) assert.equal(firebaseLink(line(url)), null, url);
  for (const log of [null, undefined, '', 'không có gì']) assert.equal(firebaseLink(log), null);
});

test('a live delivery puts the link of its distribute log in the Jira comment and keeps the build for E2E', async t => {
  const s = setup(t);
  const id = await s.open();
  await s.until(id, s.kindsOf('distributing'));
  await s.advance(id);
  const job = s.rows("SELECT payload FROM jobs WHERE kind = 'build' ORDER BY id DESC").map(r => JSON.parse(r.payload))[0];
  const dir = buildDir(job, { dzHome: s.dzHome, project: s.project });
  fs.mkdirSync(dir, { recursive: true });
  const { logName } = require('../src/step-spec.cjs');
  fs.writeFileSync(path.join(dir, logName(1, 'distribute')), LOG);
  await s.until(id);
  assert.match(s.comments('AAP1-1').join('\n'), new RegExp(`Link cài: ${TESTERS.replace(/[?.]/g, '\\$&')}`));
  const [build] = listBuilds(s.db, 'AAP1', VERSION);
  assert.equal(build.sha, s.batch(id).data.sha);
  assert.equal(fs.existsSync(build.apk), true);
});

test('without a log the comment has no link', async t => {
  const s = setup(t);
  await s.until(await s.open());
  assert.doesNotMatch(s.comments('AAP1-1').join('\n'), /Link cài/);
});
