const L = '[\\p{L}\\p{N}_]';
const word = alt => new RegExp(`(?<!${L})(?:${alt})(?!${L})`, 'iu');

const CATEGORIES = [
  ['money', word('tiền|mua|thanh toán|giá|credit|purchase|payment|billing|price|iap|in-app purchase|tín dụng')],
  ['ads', word('quảng cáo|ads?|admob|interstitial|rewarded|banner ads?|ad unit')],
  ['premium', word('premium|sub|subscription|subscribe|vip|gói đăng ký|đăng ký gói|gia hạn|pro')],
  ['reward', word('phần thưởng|thưởng|energy|năng lượng|gem|kim cương|streak|chuỗi ngày|reward|coin|xu')],
  ['delete-data', word('xoá|xóa|delete|erase|wipe|xoá dữ liệu|xóa dữ liệu|reset dữ liệu')],
  ['drop-requirement', word('bỏ yêu cầu|bỏ tính năng|bỏ requirement|loại bỏ|bỏ qua yêu cầu|drop the requirement|drop requirement|không làm nữa|remove the requirement')],
  ['sample-data', word('dữ liệu mẫu|dữ liệu giả|mock|sample data|fake data')],
  ['library-gap', word('thư viện (?:không|chưa)[^\\n]{0,40}|library (?:cannot|can\'t|does not|doesn\'t)|terakit không|thư viện không làm được')],
  ['conflict', word('mâu thuẫn|không khớp|lệch nhau|conflict|contradict|inconsistent|khác nhau giữa')],
];

const GUARDED = new Set(CATEGORIES.map(([id]) => id));

function category(question) {
  const text = [question.title, question.body, ...(question.options || []).map(o => o.text)].join('\n');
  const hit = CATEGORIES.find(([, re]) => re.test(text));
  return hit ? hit[0] : null;
}

function str(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function decide(question, item) {
  if (!item || item.decision !== 'auto' || GUARDED.has(item.category)) return null;
  const label = str(item.label);
  if (!label || !question.options.some(o => o.label === label)) return null;
  const [source, reason] = [str(item.source), str(item.reason)];
  const easy = item.category === 'easy-change';
  if (easy && question.blocking) return null;
  if (!source && !(easy && reason)) return null;
  return { label, source, reason };
}

function mergeTriage(questions, triageJson) {
  const items = new Map();
  const list = triageJson && Array.isArray(triageJson.items) ? triageJson.items : [];
  for (const item of list) if (item && typeof item.id === 'string' && !items.has(item.id)) items.set(item.id, item);
  return questions.map(question => {
    const item = items.get(question.id);
    const auto = decide(question, item);
    const forced = category(question);
    if (auto && forced) return { ...question, mode: 'ask', auto: null, forced };
    if (auto) return { ...question, mode: 'auto', auto };
    return { ...question, mode: 'ask', auto: null, ...(forced && item && item.decision === 'auto' ? { forced } : {}) };
  });
}

module.exports = { mergeTriage, category };
