const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readSpec } = require('../src/mcp/spec-text.cjs');

test('the desk takes a /display/ Confluence link as a spec', () => {
  const link = 'https://confluence.apero.vn/display/PROJ/%5BAAP864%5D+Phase+15%3A+SDK+custom+learning+path';
  assert.deepEqual(readSpec(`Request spec: ${link}`), { source: { type: 'url', ref: link }, figma: null });
});

test('the desk still refuses a link that names no page', () => {
  assert.throws(() => readSpec('spec: https://confluence.apero.vn/'), { code: 'INVALID' });
});
