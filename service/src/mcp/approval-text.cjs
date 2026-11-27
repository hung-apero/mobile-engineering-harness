const CLEAR = [
  ['đã', 'duyệt'], ['duyệt'], ['duyet'], ['đồng', 'ý'], ['dong', 'y'], ['chốt'], ['chot'], ['thông', 'qua'], ['thong', 'qua'],
  ['nhất', 'trí'], ['nhat', 'tri'], ['approve'], ['approved'], ['lgtm'], ['i', 'approve'],
];
const SOFT = [['ok'], ['oke'], ['okay'], ['okie'], ['okela'], ['được'], ['duoc'], ['yes'], ['đạt']];
const FILLER = new Set([
  'mình', 'tôi', 'toi', 'nhé', 'nhe', 'nha', 'ạ', 'rồi', 'roi', 'luôn', 'luon',
  'bản', 'này', 'nay', 'spec', 'vâng', 'dạ', 'the', 'this', 'it', 'cảm', 'ơn', 'cam', 'on', 'thanks',
]);
const THANKS = ['thank', 'you'];
const HEDGES = /(?<![\p{L}\p{N}])(?:nhưng|nhung|ngoại\s+trừ|ngoai\s+tru|trừ|tru|except|but)(?![\p{L}\p{N}])/iu;
const FRIENDLY = /\u{1F44D}[\u{1F3FB}-\u{1F3FF}]?|[✅\u{1F64F}\u{1F389}]|❤️?/gu;
const MENTION = /<@!?\d{17,20}>/g;
const SOFT_PUNCTUATION = /[.,!]/g;
const WORD = /^[\p{L}\p{N}]+$/u;

function matches(words, phrases) {
  return phrases.find(phrase => phrase.every((word, index) => words[index] === word)) ?? null;
}

function consume(words, keys) {
  let approved = false;
  for (let rest = words; rest.length > 0;) {
    const yes = matches(rest, [...CLEAR, ...SOFT]);
    const thanks = yes ? null : matches(rest, [THANKS]);
    if (!yes && !thanks && !FILLER.has(rest[0]) && !keys.has(rest[0])) return null;
    approved ||= yes !== null;
    rest = rest.slice((yes ?? thanks ?? [rest[0]]).length);
  }
  return approved ? 'approved' : null;
}

function readApproval(text, projectKeys = []) {
  const plain = String(text).normalize('NFC').replace(FRIENDLY, ' ').replace(SOFT_PUNCTUATION, ' ');
  if (plain.replace(MENTION, ' ').trim() === '') return 'empty';
  const words = plain.toLowerCase().split(/\s+/).filter(Boolean);
  if (HEDGES.test(plain) || !words.every(word => WORD.test(word))) return 'feedback';
  return consume(words, new Set(projectKeys.map(key => key.toLowerCase()))) ?? 'feedback';
}

module.exports = { readApproval, hasHedge: text => HEDGES.test(String(text).normalize('NFC')) };
