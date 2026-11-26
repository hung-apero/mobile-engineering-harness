const fs = require('fs');
const path = require('path');
const S = require('./learn-app-state.cjs');
const { readPlans } = require('./looper-parse.cjs');

const FILE = 'auto-decisions.md';
const LEVELS = [
  ['business', 'Luật nghiệp vụ'],
  ['bom', 'Nâng thư viện Learn (BOM)'],
  ['spec', 'Đổi spec'],
  ['gap', 'Phần chưa làm được'],
  ['ui', 'Cách app vẽ'],
];

function planOf(plans, featureId) {
  const plan = plans.find(p => (p.features || []).includes(featureId));
  return plan ? plan.id : null;
}

function decisionLevel(decision) {
  const picked = (decision.options || []).find(o => o.label === decision.choice);
  if (picked && picked.bom) return 'bom';
  if (decision.kind === 'business' || decision.blocking) return 'business';
  return 'ui';
}

function decisionEntry(feature, decision, plan) {
  const reason = decision.why || (decision.byFigma ? 'theo Figma' : 'app tự vẽ, không đổi luật');
  const reopen = plan ? ` rồi \`back --to coding --plan ${plan} --reason "PO đổi lựa chọn"\`` : '';
  return [
    `- **${decision.question}** (\`${feature.id}\`${plan ? ` · plan \`${plan}\`` : ''})`,
    `  - Lựa chọn: ${(decision.options || []).map(o => o.label).join(' / ')}`,
    `  - Đã chọn: ${decision.choice}${decision.byFigma ? ' (theo Figma)' : ''}`,
    `  - Lý do: ${reason}`,
    `  - Đổi: \`decide --feature ${feature.id} --decision ${decision.id} --choice "<nhãn>" --quote "<lời PO>"\`${reopen}`,
  ];
}

function autoDecisionEntries(root, state) {
  let plans = [];
  try { plans = readPlans(root); } catch {}
  const groups = Object.fromEntries(LEVELS.map(([key]) => [key, []]));
  for (const f of state.features || []) {
    for (const d of f.decisions || []) {
      if (d.choice && (d.provisional || d.auto)) groups[decisionLevel(d)].push(decisionEntry(f, d, planOf(plans, f.id)));
    }
    if (f.status === 'gap' && (f.gaps || []).length) {
      groups.gap.push([`- \`${f.id}\`: ${f.gaps.join('; ')}`, '  - Đổi: bỏ yêu cầu này, hoặc nhờ dev bổ sung trong kho tính năng']);
    }
  }
  for (const c of state.selfSpecChanges || []) {
    groups.spec.push([`- ${c.from} → ${c.to}: ${c.why}`, '  - Đổi: nói lại điều muốn — `back --to clear --reason "<lời PO>"`, spec-clear `Mode: update` với `PO notes:`']);
  }
  return groups;
}

function autoDecisionLines(root, state) {
  const groups = autoDecisionEntries(root, state);
  const lines = LEVELS.filter(([key]) => groups[key].length).flatMap(([key, title]) => ['', `### ${title}`, ...groups[key].flat()]);
  return lines.length ? lines.slice(1) : ['- (không có)'];
}

function renderAutoDecisions(root, state) {
  return [
    '# Trợ lý tự quyết sau cổng 1',
    '',
    'Sau cổng 1 trợ lý không hỏi mà tự chọn, có lý do. PO xem ở cổng 3: giữ hết, hay đổi mục nào.',
    '',
    ...autoDecisionLines(root, state),
    '',
  ].join('\n');
}

function writeAutoDecisions(root) {
  const file = path.join(root, S.DIR, FILE);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, renderAutoDecisions(root, S.readState(root)));
  fs.renameSync(temp, file);
  return file;
}

module.exports = { FILE, autoDecisionEntries, autoDecisionLines, renderAutoDecisions, writeAutoDecisions };
