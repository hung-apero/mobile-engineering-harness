const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseQuestions } = require('../src/specs/questions.cjs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SCRIPTS = path.join(__dirname, '..', '..', 'skills', 'feature', 'scripts');
const checkerParse = md => JSON.parse(execFileSync('python3', ['-I', '-c', 'import sys, json; sys.path.insert(0, sys.argv[1]); import headless_check as h; print(json.dumps(h.parse_questions(sys.stdin.read())))', SCRIPTS], { input: md, encoding: 'utf8' }));

const SAMPLE = `# Câu hỏi

## Q1 · Streak dùng thư viện? [chặn]
Spec nói streak 7 ngày, thư viện chưa có.
Dòng hai của bối cảnh.
- A. Dùng thư viện
- B. App tự đếm
- **Đề xuất: B** — thư viện chưa làm được

## Q2 · Màu nút
- A. Xanh
- B. Đỏ
**Đề xuất:** A

## Q3 · Đã hỏi
- A. x
- B. y
**PO chọn (2026-09-25):** A — nguyên văn: "a"

## Q4 · Đã trả lời mới [chặn]
- A. x
- B. y
- **Đề xuất: A** — vì
- **PO trả lời (2026-11-25): Khác** — nguyên văn: "làm khác đi"

## Q5 · Agent chốt
- A. x
- B. y
- **Agent tự chốt (2026-11-25): A** — nguồn: "spec §3"
`;

test('parseQuestions reads id, title, blocking, body, options, proposal and answer', () => {
  const [q1, q2, q3, q4, q5] = parseQuestions(SAMPLE);
  assert.deepEqual(q1, {
    id: 'Q1', title: 'Streak dùng thư viện?', body: 'Spec nói streak 7 ngày, thư viện chưa có.\nDòng hai của bối cảnh.',
    blocking: true, options: [{ label: 'A', text: 'Dùng thư viện' }, { label: 'B', text: 'App tự đếm' }],
    proposal: { label: 'B', reason: 'thư viện chưa làm được' }, answered: false, answer: null,
  });
  assert.equal(q2.blocking, false);
  assert.deepEqual(q2.proposal, { label: 'A', reason: '' });
  assert.equal(q3.answered, true);
  assert.deepEqual(q3.answer, { kind: 'po', label: 'A', text: 'a' });
  assert.deepEqual(q4.answer, { kind: 'po', label: 'Khác', text: 'làm khác đi' });
  assert.deepEqual(q5.answer, { kind: 'agent', label: 'A', text: 'spec §3' });
});

test('parseQuestions agrees with the harness checker on ids, blocking, options, proposal and answered', () => {
  const mine = parseQuestions(SAMPLE);
  const theirs = checkerParse(SAMPLE);
  assert.deepEqual(mine.map(q => q.id), theirs.map(q => q.id));
  assert.deepEqual(mine.map(q => q.blocking), theirs.map(q => q.blocking));
  assert.deepEqual(mine.map(q => q.options.map(o => o.label)), theirs.map(q => q.labels));
  assert.deepEqual(mine.map(q => q.proposal !== null), theirs.map(q => q.proposals === 1));
  assert.deepEqual(mine.map(q => q.answered), theirs.map(q => q.answered));
});

test('parseQuestions returns nothing for empty text or Không có câu hỏi', () => {
  assert.deepEqual(parseQuestions(''), []);
  assert.deepEqual(parseQuestions('Không có câu hỏi'), []);
  assert.deepEqual(parseQuestions(null), []);
});
