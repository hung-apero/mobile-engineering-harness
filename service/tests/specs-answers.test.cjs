const { test } = require('node:test');
const assert = require('node:assert/strict');
const { writeAnswers } = require('../src/specs/answers.cjs');
const { parseQuestions } = require('../src/specs/questions.cjs');

const MD = `# Câu hỏi

## Q1 · Một [chặn]
Bối cảnh
- A. x
- B. y
- **Đề xuất: A** — vì

## Q2 · Hai
- A. x
- B. y

Ghi chú cuối
`;

const po = (id, over = {}) => ({ id, kind: 'po', label: 'A', text: 'ok', date: '2026-11-25', ...over });

test('writes the exact PO and agent lines under the right question and keeps the rest verbatim', () => {
  const out = writeAnswers(MD, [po('Q1'), { id: 'Q2', kind: 'agent', label: 'B', text: 'spec §3', date: '2026-11-25' }]);
  assert.match(out, /- \*\*PO trả lời \(2026-11-25\): A\*\* — nguyên văn: "ok"\n\n## Q2/);
  assert.match(out, /- \*\*Agent tự chốt \(2026-11-25\): B\*\* — nguồn: "spec §3"\n\nGhi chú cuối\n$/);
  assert.equal(out.replace(/^- \*\*(PO|Agent).*\n/gm, ''), MD);
  const [q1, q2] = parseQuestions(out);
  assert.deepEqual(q1.answer, { kind: 'po', label: 'A', text: 'ok' });
  assert.deepEqual(q2.answer, { kind: 'agent', label: 'B', text: 'spec §3' });
});

test('markdown, newlines, headings, quotes and backticks stay on one line and cannot add a question', () => {
  const nasty = 'dòng 1\n## Q9 · giả\n- A. lừa\n```js\nx\n```\r\n"trích" **đậm**\u0007';
  const out = writeAnswers(MD, [po('Q1', { text: nasty, label: 'Khác\n## Q8' })]);
  assert.equal(parseQuestions(out).length, 2);
  assert.equal(out.split('\n').length, MD.split('\n').length + 1);
  const answer = parseQuestions(out)[0].answer;
  assert.equal(answer.kind, 'po');
  assert.match(answer.text, /dòng 1 ## Q9 · giả - A\. lừa ```js x ``` ”trích” \*\*đậm\*\*/);
  assert.doesNotMatch(out, /\u0007/);
});

test('label Khác with text is allowed', () => {
  const out = writeAnswers(MD, [po('Q2', { label: 'Khác', text: 'làm theo cách thứ ba' })]);
  assert.deepEqual(parseQuestions(out)[1].answer, { kind: 'po', label: 'Khác', text: 'làm theo cách thứ ba' });
});

test('is idempotent and never overwrites an answered question', () => {
  const once = writeAnswers(MD, [po('Q1'), po('Q2')]);
  assert.equal(writeAnswers(once, [po('Q1'), po('Q2')]), once);
  assert.equal(writeAnswers(once, [po('Q1', { label: 'B', text: 'khác' })]), once);
  assert.equal(writeAnswers(once, [{ id: 'Q1', kind: 'agent', label: 'B', text: 'z', date: '2026-11-26' }]), once);
});

test('replace:true turns an agent answer into a PO answer only', () => {
  const agent = writeAnswers(MD, [{ id: 'Q1', kind: 'agent', label: 'B', text: 'nguồn', date: '2026-11-25' }]);
  assert.equal(writeAnswers(agent, [po('Q1')]), agent);
  const replaced = writeAnswers(agent, [po('Q1', { label: 'A', text: 'tôi chọn', replace: true })]);
  assert.doesNotMatch(replaced, /Agent tự chốt/);
  assert.deepEqual(parseQuestions(replaced)[0].answer, { kind: 'po', label: 'A', text: 'tôi chọn' });
  assert.equal(writeAnswers(replaced, [po('Q1', { text: 'lần nữa', replace: true })]), replaced);
});

test('unknown ids are ignored and empty input is stable', () => {
  assert.equal(writeAnswers(MD, [po('Q7')]), MD);
  assert.equal(writeAnswers(MD, []), MD);
  assert.equal(writeAnswers('', [po('Q1')]), '');
});
