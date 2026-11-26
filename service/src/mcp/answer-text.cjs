const { DeskError } = require('./desk-error.cjs');
const { hasHedge } = require('./approval-text.cjs');

const OTHER = 'Khác';
const LINE = /^(Q\d{1,3})\s*[:.)\-=]?\s+(\S.*)$|^(Q\d{1,3})[:.)\-=](\S.*)$/i;
const SUBMIT = /^(?:nộp|nop|submit|(?:gửi|gui)\s+quiz)(?:\s+(?:quiz|nhé|nhe|ạ|luôn|luon))*[.!]*$/i;
const OTHER_LINE = /^(?:khác|khac|other)\s*[:\-]\s*(\S.*)$/i;
const MAX_TEXT = 2000;

const invalid = message => new DeskError('INVALID', message);

function readChoice(qid, rest, question) {
  const other = rest.match(OTHER_LINE);
  if (other) return { qid, choice: OTHER, text: other[1].trim().slice(0, MAX_TEXT) };
  const wanted = rest.replace(/[.!)\s]+$/, '').toUpperCase();
  const option = question.options?.find(item => item.label.toUpperCase() === wanted);
  if (option) return { qid, choice: option.label, text: '' };
  if (hasHedge(rest)) throw invalid(`${qid}: câu trả lời có điều kiện. Hãy chọn một đáp án, hoặc viết "${qid}: Khác: <nội dung>".`);
  throw invalid(`${qid}: chỉ ghi đúng một đáp án, hoặc "${qid}: Khác: <nội dung>".`);
}

function readAnswers(text, questions) {
  const open = new Map(questions.filter(item => !item.answered).map(item => [item.id, item]));
  const lines = text.normalize('NFC').split('\n').map(line => line.trim()).filter(Boolean);
  const answers = [];
  let submit = false;
  for (const line of lines) {
    if (SUBMIT.test(line)) {
      submit = true;
      continue;
    }
    const found = line.match(LINE);
    if (!found) throw invalid('Có dòng không đọc được. Mỗi dòng cần dạng "Q1: A", hoặc một dòng "nộp".');
    const qid = (found[1] ?? found[3]).toUpperCase();
    if (!open.has(qid)) throw invalid(`${qid} không có trong các câu đang hỏi.`);
    if (answers.some(item => item.qid === qid)) throw invalid(`${qid} được trả lời hai lần trong một tin.`);
    answers.push(readChoice(qid, found[2] ?? found[4], open.get(qid)));
  }
  if (answers.length === 0 && !submit) throw invalid('Tin này không có câu trả lời nào.');
  return { answers, submit };
}

module.exports = { readAnswers, OTHER };
