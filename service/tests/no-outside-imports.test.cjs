const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const VENDOR = path.join(ROOT, 'vendor', 'learn-app');
const SCANNED = ['src', 'bin', 'tests', 'channels'];
const SKIPPED = path.join(ROOT, 'tests', 'legacy-build');
const REQUIRE = /require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;

const VENDOR_USERS = new Set([
  'src/specs/build-kit.cjs',
  'src/specs/phase-build.cjs',
]);

function sources(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' || full === SKIPPED ? [] : sources(full);
    return /\.c?js$/.test(entry.name) ? [full] : [];
  });
}

const files = SCANNED.flatMap(dir => sources(path.join(ROOT, dir)));

test('relative requires stay inside service/', () => {
  const outside = files.flatMap(file => [...fs.readFileSync(file, 'utf8').matchAll(REQUIRE)]
    .map(match => [path.relative(ROOT, file), match[1], path.resolve(path.dirname(file), match[1])])
    .filter(([, , target]) => !target.startsWith(`${ROOT}${path.sep}`))
    .map(([file, spec]) => `${file}: ${spec}`));
  assert.deepEqual(outside, []);
});

test('only the listed transitional files require vendor/learn-app', () => {
  const users = files.filter(file => [...fs.readFileSync(file, 'utf8').matchAll(REQUIRE)]
    .some(match => path.resolve(path.dirname(file), match[1]).startsWith(`${VENDOR}${path.sep}`)))
    .map(file => path.relative(ROOT, file));
  assert.deepEqual(users.filter(file => !VENDOR_USERS.has(file)), []);
});
