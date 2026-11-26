const fs = require('fs');
const path = require('path');
const { DIR, writeJsonAtomic } = require('./learn-app-state.cjs');
const { fail, print, option } = require('./cli-io.cjs');

// Every place the app draws what the Learn SDK does not let it change (tier 4/5, or a number the app computes from
// public data) is one line for the SDK devs: which slot/API would let the app hand that part back. Never a stop.
function requestsFile(root) {
  return path.join(root, DIR, 'sdk-requests.json');
}

function readRequests(root) {
  try {
    return JSON.parse(fs.readFileSync(requestsFile(root), 'utf8')).requests || [];
  } catch {
    return [];
  }
}

function render(requests) {
  const line = r => `- **${r.feature}** · cần: ${r.need} · app đang vẽ thay ở \`${r.where}\`${r.tier !== null ? ` · bậc ${r.tier}` : ''}`;
  return `# Cần dev SDK mở thêm\n\nChỗ app tự vẽ vì Learn SDK chưa cho đổi. SDK mở đúng chỗ ghi ở "cần" thì app đổi phần của mình sang đó.\n\n${requests.map(line).join('\n') || 'Không có.'}\n`;
}

function addRequest(root, { feature, need, where, tier = null }) {
  const key = r => [r.feature, r.where.replace(/\\/g, '/'), r.need.trim().toLowerCase()].join('|');
  const requests = readRequests(root).filter(r => key(r) !== key({ feature, where, need }));
  const request = { feature, need, where, tier, at: new Date().toISOString() };
  const all = [...requests, request];
  writeJsonAtomic(requestsFile(root), { requests: all });
  fs.writeFileSync(path.join(root, DIR, 'sdk-requests.md'), render(all));
  return request;
}

function sdkRequest(root) {
  const feature = option('feature');
  const need = option('need');
  const where = option('where');
  if (!feature || !need || !where) fail('Cần --feature <id>, --need "<đúng slot/API cần>" và --where <file app đang vẽ thay> (--tier 4|5 nếu có)');
  const raw = option('tier');
  const tier = raw === undefined ? null : Number(raw);
  if (tier !== null && ![4, 5].includes(tier)) fail('--tier phải là 4 hoặc 5');
  print(addRequest(root, { feature, need, where, tier }));
}

module.exports = { readRequests, addRequest, sdkRequest, render };
