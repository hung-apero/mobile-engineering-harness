const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readGeneralInfo, loadSource, figmaKeyOf, IntakeError } = require('../src/specs/intake.cjs');

const table = rows => `A. THÔNG TIN CHUNG\n------------------\n\n|  |  |\n| --- | --- |\n${rows.join('\n')}\n\nB. Chi tiết\n`;
const figma = 'https://www.figma.com/design/AbC123xyz/Demo-file?node-id=1-2';

test('readGeneralInfo takes app from the title and figma from the Link design row', () => {
  const md = table(['| PO | Someone |', '| Link design | [Figma](' + figma + ') |', '| Kịch bản ads | [Ads](https://docs.example/sheet) |']);
  assert.deepEqual(readGeneralInfo(md, 'AAP878 Phase 3: Apply lib [base line: 1.0.0]'), { app: 'AAP878', figma, title: 'AAP878 Phase 3: Apply lib [base line: 1.0.0]', missing: [] });
});

test('Link Figma is an accepted label variant, case and bold ignored', () => {
  assert.equal(readGeneralInfo(table(['| **link figma** | ' + figma + ' |']), 'AIP310 x').figma, figma);
});

test('an empty design cell and a title without code give missing figma and app', () => {
  const info = readGeneralInfo(table(['| Link design |  |']), 'Một tiêu đề thường');
  assert.deepEqual(info.missing, ['app', 'figma']);
  assert.equal(info.app, undefined);
  assert.equal(info.figma, undefined);
});

test('a non-figma link in the design row does not count, and only the design row is used', () => {
  const info = readGeneralInfo(table(['| Link design | https://docs.example/x |', '| Event tracking | ' + figma + ' |']), 'AAP1 a');
  assert.deepEqual(info.missing, ['figma']);
});

test('without a title argument the first heading of pasted text is used', () => {
  const info = readGeneralInfo(`# AAP864 Phase 2: demo\n\n${table(['| Link design | ' + figma + ' |'])}`);
  assert.equal(info.app, 'AAP864');
  assert.equal(info.title, 'AAP864 Phase 2: demo');
  assert.deepEqual(info.missing, []);
});

test('figmaKeyOf reads design, file and proto links only', () => {
  assert.equal(figmaKeyOf(figma), 'AbC123xyz');
  assert.equal(figmaKeyOf('https://figma.com/file/K9/x'), 'K9');
  assert.equal(figmaKeyOf('https://evil.example/design/K9/x'), null);
  assert.equal(figmaKeyOf(undefined), null);
});

test('loadSource url goes through confluence with the parsed page id', async () => {
  const seen = [];
  const confluence = { page: async id => (seen.push(id), { title: 'AAP1 t', markdown: 'body' }) };
  const out = await loadSource({ type: 'url', ref: 'https://wiki.example/pages/42/x' }, { confluence });
  assert.deepEqual(out, { title: 'AAP1 t', markdown: 'body', source: { type: 'url', ref: 'https://wiki.example/pages/42/x' } });
  assert.deepEqual(seen, ['42']);
  await assert.rejects(loadSource({ type: 'url', ref: 'nonsense' }, { confluence }), /không hợp lệ/);
});

test('loadSource path reads only absolute regular .md or .txt files within the size limit', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dz-intake-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const md = path.join(dir, 'spec.md');
  fs.writeFileSync(md, '# AAP5 tiêu đề\n\nnội dung');
  assert.deepEqual(await loadSource({ type: 'path', ref: md }), { title: 'AAP5 tiêu đề', markdown: '# AAP5 tiêu đề\n\nnội dung', source: { type: 'path', ref: md } });
  const link = path.join(dir, 'link.md');
  fs.symlinkSync(md, link);
  fs.writeFileSync(path.join(dir, 'big.md'), 'x'.repeat(1024 * 1024 + 1));
  fs.writeFileSync(path.join(dir, 'a.json'), '{}');
  for (const ref of ['spec.md', link, path.join(dir, 'missing.md'), path.join(dir, 'big.md'), path.join(dir, 'a.json'), dir]) {
    await assert.rejects(loadSource({ type: 'path', ref }), e => e instanceof IntakeError);
  }
});

test('loadSource pasted keeps the text with an empty ref and refuses blank or unknown types', async () => {
  assert.deepEqual(await loadSource({ type: 'pasted', text: 'dòng một\ndòng hai' }), { title: 'Spec dán tay', markdown: 'dòng một\ndòng hai', source: { type: 'pasted', ref: '' } });
  await assert.rejects(loadSource({ type: 'pasted', text: '  ' }), IntakeError);
  await assert.rejects(loadSource({ type: 'ftp' }), IntakeError);
  await assert.rejects(loadSource(undefined), IntakeError);
});

test('a bracketed app code at the start of the title is read', () => {
  assert.equal(readGeneralInfo(table([]), '[AAP123] Phase 1: demo').app, 'AAP123');
  assert.equal(readGeneralInfo(table([]), 'Phase 1 [AAP123]').app, undefined);
});
