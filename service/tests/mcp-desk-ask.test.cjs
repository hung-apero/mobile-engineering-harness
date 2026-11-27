const { test } = require('node:test');
const assert = require('node:assert/strict');
const { NOW, OTHER, setup } = require('./mcp-fixtures.cjs');

const building = (id, asks) => ({ id, project: 'AAP864', state: 'building', asks });
const code = async promise => {
  const result = await promise;
  return result.ok ? 'ok' : result.error.code;
};

test('ask sends the questions of the only spec that has some, for anyone of the team', async t => {
  const s = setup(t, { specs: [building(3, { po: 1, dev: 1, qa: 0 }), building(5, null)] });
  const { ok, result } = await s.call('ask', s.discord.post('gom câu hỏi gửi PO giúp', { author: { id: OTHER } }));
  assert.equal(ok, true);
  assert.deepEqual([result.specId, s.facade.of('askNow')[0].args], [3, [3, NOW]]);
  assert.match(result.outcome, /spec #3/);
});

test('ask needs the spec number when several specs have questions and refuses a spec without any', async t => {
  const s = setup(t, { specs: [building(3, { po: 1, dev: 0, qa: 0 }), building(4, { po: 0, dev: 2, qa: 0 })] });
  assert.equal(await code(s.call('ask', s.discord.post('gửi câu hỏi đi'))), 'CHOOSE');
  assert.equal((await s.call('ask', s.discord.post('gửi câu hỏi spec 4'))).result.specId, 4);
  assert.equal(await code(s.call('ask', s.discord.post('gửi câu hỏi #9'))), 'STATE');
});

test('ask refuses people outside the team of the project', async t => {
  const s = setup(t, { specs: [building(3, { po: 1, dev: 0, qa: 0 })] });
  assert.equal(await code(s.call('ask', s.discord.post('gửi câu hỏi #3', { author: { id: '623456789012345678' } }))), 'REFUSED');
  assert.deepEqual(s.facade.of('askNow'), []);
});

test('status shows how many questions wait for each role', async t => {
  const s = setup(t, { specs: [building(3, { po: 2, dev: 1, qa: 0 })] });
  const { result } = await s.call('status', s.discord.post('tình hình sao rồi'));
  assert.deepEqual(result.projects[0].specs[0].asks, { po: 2, dev: 1, qa: 0 });
});
