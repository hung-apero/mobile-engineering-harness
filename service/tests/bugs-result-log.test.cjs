const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { lastResultText } = require('../src/bugs/result.cjs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dz-result-log-'));
let count = 0;
function log(text) {
  const file = path.join(dir, `${++count}.jsonl`);
  fs.writeFileSync(file, text);
  return file;
}
const lines = (...events) => events.map(e => `${JSON.stringify(e)}\n`).join('');
const result = (text, extra = {}) => ({ type: 'result', subtype: 'success', is_error: false, result: text, ...extra });

test('the whole text of the last result event is returned', () => {
  const long = 'x'.repeat(50000);
  const out = lastResultText(log(lines({ type: 'assistant' }, result('cũ'), { type: 'system' }, result(long), { type: 'system', subtype: 'end' })));
  assert.deepEqual(out, { text: long, structuredOutput: null, isError: false, subtype: 'success' });
});

test('structured output is returned when the event carries one', () => {
  const out = lastResultText(log(lines(result('ok', { structured_output: { lanes: [] } }))));
  assert.deepEqual(out.structuredOutput, { lanes: [] });
});

test('a failed result says so and keeps its errors as text', () => {
  const out = lastResultText(log(lines({ type: 'result', subtype: 'error_max_structured_output_retries', is_error: true, errors: ['a', 'b'] })));
  assert.deepEqual(out, { text: 'a\nb', structuredOutput: null, isError: true, subtype: 'error_max_structured_output_retries' });
});

test('broken lines, an unfinished last line and a result quoted inside another event are skipped', () => {
  const quoted = { type: 'user', message: { content: JSON.stringify(result('giả')) } };
  const out = lastResultText(log(`${lines(result('thật'), quoted)}không phải json "result"\n[{"type":"result"}]\n{"type":"result","result":"dở`));
  assert.equal(out.text, 'thật');
});

test('a complete last line without a newline is read', () => {
  assert.equal(lastResultText(log(JSON.stringify(result('cuối')))).text, 'cuối');
});

test('no result, an empty file and a missing file give null', () => {
  assert.equal(lastResultText(log(lines({ type: 'assistant' }))), null);
  assert.equal(lastResultText(log('')), null);
  assert.equal(lastResultText(path.join(dir, 'gone.jsonl')), null);
});

test('only the end of a file over the limit is read, and a cut first line is ignored', () => {
  const file = log(lines(result('đầu'), { type: 'assistant', pad: 'x'.repeat(500) }, result('cuối')));
  assert.equal(lastResultText(file, { maxBytes: 200 }).text, 'cuối');
  assert.equal(lastResultText(log(lines(result('đầu'), { type: 'assistant', pad: 'x'.repeat(500) })), { maxBytes: 200 }), null);
});

test('a result whose line starts exactly at the limit is read', () => {
  const last = lines(result('vừa'));
  assert.equal(lastResultText(log(lines({ type: 'assistant' }) + last), { maxBytes: Buffer.byteLength(last) }).text, 'vừa');
});

test('a symlink or a folder is refused', () => {
  const target = log(lines(result('x')));
  const link = path.join(dir, 'link.jsonl');
  fs.symlinkSync(target, link);
  assert.throws(() => lastResultText(link));
  assert.throws(() => lastResultText(dir));
});
