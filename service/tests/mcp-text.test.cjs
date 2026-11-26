const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readApproval } = require('../src/mcp/approval-text.cjs');
const { readAnswers } = require('../src/mcp/answer-text.cjs');

test('clear approvals in Vietnamese and English', () => {
  const list = ['duyệt', 'Duyệt nhé', 'ok duyệt', 'đồng ý', 'Đồng ý ạ!', 'chốt', 'chốt luôn nhé', 'thông qua', 'approved', 'Approve', 'LGTM', 'duyet', 'dong y', 'duyệt ✅', 'mình duyệt rồi nhé', 'duyệt AAP864'];
  for (const text of [...list, 'duyệt'.normalize('NFD')]) assert.equal(readApproval(text, ['AAP864']), 'approved', text);
  for (const text of ['ok', 'Oke nhé', 'okay', 'yes', 'được', 'ok, cảm ơn']) assert.equal(readApproval(text), 'approved', text);
});

test('conditions are feedback, in every spelling', () => {
  const list = ['ok nhưng bỏ màn 2', 'duyệt NHƯNG', 'duyet nhung sua mau', 'duyệt trừ Q3', 'duyệt ngoại trừ màn 2', 'approve except Q2', 'lgtm, but', 'approved but fix', 'duyệt nhưng'.normalize('NFD'), 'duyệt\nnhưng'];
  for (const text of list) assert.equal(readApproval(text), 'feedback', text);
});

test('negation, questions, conditions, partial approval and formatting tricks are feedback', () => {
  const list = ['không duyệt', 'chưa duyệt', 'đừng duyệt', 'duyệt?', 'duyệt chưa', 'duyệt được không', 'not approved', "don't approve", 'duyệt nếu xong Q2', 'duyệt 1 phần', 'chỉ duyệt Q1',
    '~~duyệt~~', '> duyệt', '||duyệt||', '`duyệt`', 'duyệt 👎', 'ok 😂', 'duyệt <:no:123456789012345678>', 'duyệt/không', 'duyệt, sửa màn 2', 'khoan', 'cảm ơn', 'duyệt​x', 'duуệt', 'disapprove'];
  for (const text of list) assert.equal(readApproval(text, ['AAP864']), 'feedback', text);
});

test('nothing to read is empty', () => {
  for (const text of ['', '   ', '👍', '...', '<@123456789012345678>']) assert.equal(readApproval(text), 'empty', text);
});

test('answers keep markup on one line and never leave the question', () => {
  const questions = [{ id: 'Q1', answered: false, options: [{ label: 'A', text: 'x' }] }];
  const { answers } = readAnswers('Q1: Khác: `## Q2` **x** - [ ]', questions);
  assert.deepEqual(answers, [{ qid: 'Q1', choice: 'Khác', text: '`## Q2` **x** - [ ]' }]);
  assert.deepEqual(readAnswers('q1) a.\nNộp nhé', questions), { answers: [{ qid: 'Q1', choice: 'A', text: '' }], submit: true });
  assert.throws(() => readAnswers('Q1: Khác: a\n## Q2', questions), { code: 'INVALID' });
});
