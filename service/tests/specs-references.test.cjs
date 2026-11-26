const { test } = require('node:test');
const assert = require('node:assert/strict');
const { gatherReferences } = require('../src/specs/references.cjs');

const SPEC = 'https://confluence.apero.vn/pages/viewpage.action?pageId=332470208';
const KB = 'https://confluence.apero.vn/pages/viewpage.action?pageId=323388917';

function wiki(pages, fail = []) {
  const asked = [];
  return {
    asked,
    page: async ref => {
      asked.push(ref);
      const id = String(ref).match(/pageId=(\d+)|pages\/(\d+)/)?.slice(1).find(Boolean) ?? ref;
      if (fail.includes(id)) throw new Error(`403 trang ${id}`);
      return { id, title: `Trang ${id}`, markdown: pages[id] ?? `# ${id}` };
    },
  };
}

test('kb pages come first, then confluence links of the spec on the same host, each once, never the spec itself', async () => {
  const markdown = [
    `SDK: [v1.0.0](https://confluence.apero.vn/pages/viewpage.action?pageId=330631792) và [tính năng](https://confluence.apero.vn/pages/viewpage.action?pageId=330631788)`,
    `lại lần nữa https://confluence.apero.vn/pages/viewpage.action?pageId=330631792 và chính nó ${SPEC}`,
    'Figma https://www.figma.com/design/16Lt/AAP864 sheet https://docs.google.com/spreadsheets/d/1U/edit',
    'trang khác https://wiki.other.com/pages/viewpage.action?pageId=999',
  ].join('\n');
  const c = wiki({});
  const out = await gatherReferences({ confluence: c, knowledge: [KB], sourceRef: SPEC, markdown });
  assert.deepEqual(out.pages.map(p => [p.kind, p.id]), [['kb', '323388917'], ['linked', '330631792'], ['linked', '330631788']]);
  assert.deepEqual(out.missing, []);
});

test('an unreadable page is reported, the rest still load', async () => {
  const markdown = 'x https://confluence.apero.vn/pages/viewpage.action?pageId=1 y https://confluence.apero.vn/pages/viewpage.action?pageId=2';
  const out = await gatherReferences({ confluence: wiki({}, ['1']), knowledge: [], sourceRef: SPEC, markdown });
  assert.deepEqual(out.pages.map(p => p.id), ['2']);
  assert.equal(out.missing.length, 1);
  assert.match(out.missing[0].reason, /403/);
});

test('at most ten linked pages are read', async () => {
  const markdown = Array.from({ length: 14 }, (_, i) => `https://confluence.apero.vn/pages/viewpage.action?pageId=${100 + i}`).join(' ');
  const out = await gatherReferences({ confluence: wiki({}), knowledge: [], sourceRef: SPEC, markdown });
  assert.equal(out.pages.length, 10);
});

test('a pasted spec with no knowledge never calls confluence', async () => {
  const c = wiki({});
  const out = await gatherReferences({ confluence: null, knowledge: [], sourceRef: null, markdown: 'không link' });
  assert.deepEqual([out.pages, out.missing, c.asked], [[], [], []]);
});
