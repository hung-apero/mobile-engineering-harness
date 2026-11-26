const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mergeTriage } = require('../src/specs/triage.cjs');

const q = (id, over = {}) => ({
  id, title: 'Màu nút', body: '', blocking: false,
  options: [{ label: 'A', text: 'Xanh' }, { label: 'B', text: 'Đỏ' }], proposal: null, answered: false, answer: null, ...over,
});
const auto = (id, over = {}) => ({ id, decision: 'auto', label: 'A', source: 'spec §2', reason: 'rõ', ...over });

test('auto with a valid label and a source becomes auto; everything else asks', () => {
  const out = mergeTriage([q('Q1'), q('Q2'), q('Q3')], { items: [auto('Q1'), { id: 'Q2', decision: 'ask' }] });
  assert.deepEqual(out.map(x => x.mode), ['auto', 'ask', 'ask']);
  assert.deepEqual(out[0].auto, { label: 'A', source: 'spec §2', reason: 'rõ' });
  assert.equal(out[1].auto, null);
});

test('invalid triage json, unknown ids and unknown labels fall back to ask', () => {
  for (const bad of [null, undefined, {}, { items: 'x' }, { items: [null, 5, { id: 'Q9', decision: 'auto', label: 'A' }] }]) {
    assert.equal(mergeTriage([q('Q1')], bad)[0].mode, 'ask');
  }
  assert.equal(mergeTriage([q('Q1')], { items: [auto('Q1', { label: 'Z' })] })[0].mode, 'ask');
  assert.equal(mergeTriage([q('Q1')], { items: [auto('Q1', { label: undefined })] })[0].mode, 'ask');
});

test('a blocking question is auto only with a source', () => {
  const blocking = q('Q1', { blocking: true });
  assert.equal(mergeTriage([blocking], { items: [auto('Q1', { source: '' })] })[0].mode, 'ask');
  assert.equal(mergeTriage([blocking], { items: [auto('Q1', { source: undefined })] })[0].mode, 'ask');
  assert.equal(mergeTriage([blocking], { items: [auto('Q1')] })[0].mode, 'auto');
});

test('the category guard forces ask in Vietnamese and English over title, body and options', () => {
  const cases = [
    q('Q1', { title: 'Giá gói tuần' }),
    q('Q2', { body: 'Hiện quảng cáo xen kẽ sau mỗi bài' }),
    q('Q3', { options: [{ label: 'A', text: 'Chỉ Premium được dùng' }, { label: 'B', text: 'Mọi người' }] }),
    q('Q4', { title: 'Streak reset khi nào' }),
    q('Q5', { title: 'Delete account data' }),
    q('Q6', { body: 'Dùng dữ liệu mẫu tạm' }),
    q('Q7', { title: 'Spec và Figma mâu thuẫn về nút' }),
    q('Q8', { title: 'Rewarded ad cho energy' }),
    q('Q9', { title: 'Bỏ yêu cầu đăng nhập' }),
    q('Q10', { title: 'Thư viện không làm được xoay màn hình' }),
  ];
  const out = mergeTriage(cases, { items: cases.map(c => auto(c.id)) });
  for (const item of out) {
    assert.equal(item.mode, 'ask', item.id);
    assert.ok(item.forced, item.id);
    assert.equal(item.auto, null);
  }
});

test('words that merely contain a keyword do not trip the guard', () => {
  const out = mergeTriage([q('Q1', { title: 'Subtitle size', body: 'Promote the tabs' })], { items: [auto('Q1')] });
  assert.equal(out[0].mode, 'auto');
});

test('auto without a source needs easy-change, a reason and a question that does not block', () => {
  const mode = (item, over) => mergeTriage([q('Q1', over)], { items: [auto('Q1', { source: '', ...item })] })[0].mode;
  assert.equal(mode({ category: 'easy-change' }), 'auto');
  assert.equal(mode({ category: 'evidence' }), 'ask');
  assert.equal(mode({}), 'ask');
  assert.equal(mode({ category: 'easy-change', reason: ' ' }), 'ask');
  assert.equal(mode({ category: 'easy-change' }, { blocking: true }), 'ask');
  assert.equal(mode({ category: 'easy-change', source: 'spec §2' }, { blocking: true }), 'ask');
  assert.equal(mode({ category: 'money', source: 'spec §2' }), 'ask');
});
