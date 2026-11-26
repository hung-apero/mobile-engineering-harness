const fs = require('node:fs');
const path = require('node:path');

const PHASE = /^phase\d+$/;
const SHEET = /^https:\/\/docs\.google\.com\/spreadsheets\/d\/[A-Za-z0-9_-]+[^\s"'`<>\\]{0,200}$/;
const FIELDS = ['testCases', 'storeApk', 'phase', 'reinstall', 'dryRun'];
const MAX = 64 * 1024;

const harnessDir = dzHome => path.join(dzHome, 'android-test-harness');
const inputsFile = (dzHome, key) => path.join(dzHome, 'e2e', `${key}.json`);
const regular = file => fs.lstatSync(file, { throwIfNoEntry: false })?.isFile() === true;

function checkHarness(dzHome) {
  const dir = harnessDir(dzHome);
  const manifest = path.join(dir, '.claude-plugin', 'plugin.json');
  if (!fs.existsSync(manifest)) return { missing: 'plugin android-test-harness ở $DZ_HOME/android-test-harness' };
  const real = fs.realpathSync(dir);
  try {
    if (JSON.parse(fs.readFileSync(manifest, 'utf8')).name !== 'android-test-harness') throw new Error('sai tên');
  } catch {
    return { missing: 'plugin android-test-harness hợp lệ' };
  }
  return { dir: real };
}

function readDoc(dzHome, key) {
  const file = inputsFile(dzHome, key);
  if (!fs.existsSync(file)) return {};
  if (!regular(file) || fs.statSync(file).size > MAX) throw new Error(`e2e/${key}.json phải là file thường, nhỏ`);
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) throw new Error(`e2e/${key}.json phải là một object`);
  const strange = Object.keys(doc).find(name => !FIELDS.includes(name));
  if (strange) throw new Error(`e2e/${key}.json: trường lạ ${strange}`);
  return doc;
}

function mayRun(dzHome, project) {
  if (project.live === true) return true;
  try {
    return readDoc(dzHome, project.key).dryRun === true;
  } catch {
    return false;
  }
}

function localFile(dzHome, value, suffix) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || !value.endsWith(suffix) || !regular(value)) return null;
  const real = fs.realpathSync(value);
  return real.startsWith(path.join(fs.realpathSync(dzHome), 'e2e') + path.sep) ? real : null;
}

function testCasesOf(dzHome, value) {
  if (value?.kind === 'sheet' && SHEET.test(value.value ?? '')) return { kind: 'sheet', value: value.value };
  if (!['csv', 'spec'].includes(value?.kind)) return null;
  const file = localFile(dzHome, value.value, value.kind === 'csv' ? '.csv' : '.md');
  return file ? { kind: value.kind, value: file } : null;
}

function readInputs(ctx, project) {
  const { dzHome } = ctx;
  const harness = checkHarness(dzHome);
  if (harness.missing) return { missing: [harness.missing] };
  let doc;
  try {
    doc = readDoc(dzHome, project.key);
  } catch (error) {
    return { missing: [`e2e/${project.key}.json đọc được (${error.message.split('\n')[0]})`] };
  }
  const missing = [];
  if (!project.e2eDevices?.length) missing.push(`danh sách máy được phép (e2eDevices trong projects/${project.key}.yaml)`);
  const approved = doc.testCases === undefined ? ctx.e2e?.approvedSpec?.(project) : null;
  const testCases = approved ? { kind: 'spec', value: approved } : testCasesOf(dzHome, doc.testCases);
  if (!testCases) missing.push('test case (Sheet, CSV hoặc spec đã duyệt)');
  const storeApk = doc.storeApk === 'none' ? null : localFile(dzHome, doc.storeApk, '.apk');
  if (!storeApk && doc.storeApk !== 'none') missing.push('APK bản store để thử nâng cấp (storeApk, hoặc "none" nếu app chưa lên store)');
  const phase = doc.phase ?? 'phase1';
  if (!PHASE.test(phase)) missing.push('phase dạng phase1');
  return missing.length ? { missing } : { harness: harness.dir, testCases, storeApk, phase, reinstall: doc.reinstall === true };
}

module.exports = { readInputs, mayRun, harnessDir, inputsFile, checkHarness };
