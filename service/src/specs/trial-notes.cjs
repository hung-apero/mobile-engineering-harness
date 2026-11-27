const { openItems } = require('./provisional.cjs');

const GROUPS = [['ui', 'Lệch UI'], ['debts', 'Nợ của code'], ['review', 'Người kiểm code ghi nhận']];
const MAX_NOTES = 60;

function trialNotes(spec) {
  const notes = spec.data.build?.notes ?? {};
  const asked = openItems(spec).map(item => `Câu tạm chọn chưa xác nhận: ${item.title} → ${item.options.find(option => option.label === item.picked)?.text ?? 'chưa chọn'}`);
  const rest = GROUPS.flatMap(([name, title]) => (notes[name] ?? []).map(text => `${title}: ${text}`));
  return [...asked, ...rest].slice(0, MAX_NOTES);
}

module.exports = { trialNotes };
