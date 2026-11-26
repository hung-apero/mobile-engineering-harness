const { redact } = require('../redact.cjs');

const MAX_QUOTE = 1500;
const MAX_RAW = 6000;
const CONTROL = /(?:(?![\n\t])[\p{C}\p{Zl}\p{Zp}])+/gu;

function quote(text) {
  const clean = redact(String(text ?? '').slice(0, MAX_RAW)).replace(CONTROL, ' ')
    .replaceAll('@', '＠').replace(/\[(?=~)/g, '[ ').replace(/dz:(?=\d)/gi, 'dz ').trim();
  return Array.from(clean).slice(0, MAX_QUOTE).join('');
}

const oneLine = (text, max = 160) => Array.from(quote(text).replace(/\s+/g, ' ')).slice(0, max).join('');
const block = text => quote(text).split('\n').map(line => `> ${line}`).join('\n');
const part = (label, text) => (text ? [`${label}:`, block(text)] : []);

const HEADS = {
  B05: 'Cần PO xác nhận trước khi sửa, bug này tạm dừng.',
  B06: 'Chưa đủ thông tin để sửa, nhờ QA bổ sung.',
  B07: 'Không sửa theo ticket này, nhờ QA xem lại căn cứ.',
};
const VERDICTS = {
  'not-a-bug': 'không phải lỗi', duplicate: 'trùng ticket khác', 'already-fixed': 'đã được sửa', external: 'nguyên nhân nằm ngoài app',
};

function concludeText({ code, verdict, reason, question }) {
  const head = HEADS[code] ?? 'Bản sửa tự động dừng lại, chuyển dev trực.';
  const why = VERDICTS[verdict] ? [`Kết luận: ${VERDICTS[verdict]}.`] : [];
  return ['[Claude] ' + head, ...why, ...part(code === 'B06' ? 'Cần thêm' : 'Câu hỏi', question), ...part('Căn cứ', reason)].join('\n');
}

function resolvedText({ prUrl, commit, build, rootCause, specRef, link, distributed }) {
  const name = build?.versionName ? `${build.versionName} (${build.versionCode ?? '?'})` : 'không rõ';
  const sha = build?.sha256 ? `, sha256 ${String(build.sha256).slice(0, 12)}` : '';
  return [
    '[Claude] Đã sửa và gộp vào nhánh version.',
    `Bản cài: ${name}${sha}`,
    ...(link ? [`Link cài: ${link}`] : []),
    ...(distributed ? [] : ['Bản cài chưa gửi Firebase.']),
    `PR: ${prUrl ?? 'chưa có'}`,
    `Commit: ${String(commit).slice(0, 12)}`,
    ...part('Nguyên nhân', rootCause),
    ...part('Căn cứ spec', specRef),
    'Cần kiểm: làm lại các bước tái hiện trong ticket trên bản cài này.',
  ].join('\n');
}

module.exports = { quote, oneLine, concludeText, resolvedText, MAX_QUOTE };
