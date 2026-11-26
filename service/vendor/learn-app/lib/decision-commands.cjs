const fs = require('fs');
const path = require('path');
const S = require('./learn-app-state.cjs');
const { firstLine, fail, print, option } = require('./cli-io.cjs');
const { waitingPlans, pickOption } = require('./questions.cjs');

const FEATURE_STATUSES = ['todo', 'in_progress', 'done', 'gap', 'decision'];

const { figmaSettles } = require('./figma-first.cjs');

function parseDecisions(raw, previous) {
  let decisions;
  try {
    decisions = JSON.parse(raw);
  } catch (error) {
    fail(`--decisions không phải JSON hợp lệ: ${firstLine(error)}`);
  }
  const valid = Array.isArray(decisions) && decisions.every(d => d && d.id && d.question && Array.isArray(d.options) && d.options.length && d.options.every(o => o && o.label && o.owner));
  if (!valid) fail('--decisions phải là mảng [{id, question, kind?, figma?, specConflict?, options:[{label, cost, owner, bom?}]}]');
  const badFigma = decisions.find(d => d.figma !== undefined && !d.options.some(o => o.label === d.figma));
  if (badFigma) fail(`${badFigma.id}: figma phải là đúng nhãn của lựa chọn giống Figma`);
  const badKind = decisions.find(d => d.kind !== undefined && !['ui', 'business'].includes(d.kind));
  if (badKind) fail(`${badKind.id}: kind phải là ui (cách app vẽ) hoặc business (luật nghiệp vụ)`);
  const badRecommended = decisions.find(d => d.recommended !== undefined && !d.options.some(o => o.label === d.recommended));
  if (badRecommended) fail(`${badRecommended.id}: recommended phải là đúng nhãn của một lựa chọn`);
  const kept = Object.fromEntries((previous || []).map(d => [d.id, { choice: d.choice, provisional: d.provisional, auto: d.auto, byFigma: d.byFigma, blocking: d.blocking, why: d.why }]));
  return decisions.map(({ why, ...d }) => {
    const was = kept[d.id] || {};
    // A choice the Looper made itself no longer holds once the spec asks for something else than Figma.
    const keep = was.choice && !(was.auto && d.specConflict);
    return { ...d, ...(why ? { recommendedWhy: why } : {}), ...(keep ? { choice: was.choice, provisional: Boolean(was.provisional), auto: Boolean(was.auto), ...(was.byFigma ? { byFigma: true } : {}), ...(was.why ? { why: was.why } : {}) } : {}), ...((was.blocking && !figmaSettles(d)) || (d.kind === 'business' && !figmaSettles(d)) ? { blocking: true } : {}) };
  });
}

function feature(root) {
  const id = option('id');
  const source = option('source');
  if (!id || !['store', 'app'].includes(source)) fail('Cần --id và --source store|app');
  const status = option('status');
  if (status && !FEATURE_STATUSES.includes(status)) fail(`--status phải là ${FEATURE_STATUSES.join('|')}`);
  const state = S.readState(root);
  const existing = state.features.find(f => f.id === id);
  const files = option('files') ? option('files').split(',') : existing ? existing.files : [];
  const gaps = option('gaps') ? option('gaps').split(';').map(g => g.trim()).filter(Boolean) : existing?.gaps || [];
  const decisions = option('decisions') ? parseDecisions(option('decisions'), existing?.decisions) : existing?.decisions || [];
  if (status === 'decision' && !decisions.some(d => !d.choice)) fail('--status decision cần ít nhất một quyết định chưa chọn trong --decisions');
  if (process.argv.includes('--blocking')) decisions.forEach(d => { if (!d.choice && d.kind !== 'ui' && !figmaSettles(d)) d.blocking = true; });
  const tier = option('tier') !== undefined ? (option('tier') === '' ? NaN : Number(option('tier'))) : existing?.uiTier;
  if (tier !== undefined && tier !== null && !(Number.isInteger(tier) && tier >= 0 && tier <= 5)) fail('--tier phải là số 0–5 (bậc tùy biến UI; 5 = màn app dựng trên SDK)');
  const rawDebt = option('doc-debt');
  const docDebt = rawDebt !== undefined ? (/^none$/i.test(rawDebt) ? 0 : rawDebt === '' ? NaN : Number(rawDebt)) : existing?.docDebt;
  if (docDebt !== undefined && docDebt !== null && !(Number.isInteger(docDebt) && docDebt >= 0)) fail('--doc-debt phải là số dòng Doc debt (≥ 0), hoặc none');
  const next = { id, source, owner: option('owner') || existing?.owner, status: status || existing?.status || 'todo', files, gaps, decisions, ...(tier !== undefined ? { uiTier: tier } : {}), ...(docDebt !== undefined ? { docDebt } : {}) };
  const moved = S.updateState(root, fresh => {
    fresh.features = fresh.features.some(f => f.id === id) ? fresh.features.map(f => (f.id === id ? next : f)) : [...fresh.features, next];
    return { parked: parkPlans(root, fresh), resumed: resumePlans(root, fresh) };
  });
  writeAutoDecisions(root);
  print({ ...next, decisions: next.decisions.map(d => (d.choice ? d : { ...d, pick: pickOption(d) })), ...(moved.parked.length ? { waiting: moved.parked } : {}), ...(moved.resumed.length ? { resumed: moved.resumed } : {}) });
}

function writeAutoDecisions(root) {
  require('./auto-decisions-log.cjs').writeAutoDecisions(root);
}

function appendApproval(root, line) {
  fs.appendFileSync(path.join(root, S.DIR, 'gates', 'approvals.md'), `\n- ${new Date().toISOString()} · ${line}\n`);
}

function grantBom(root, state, from, to, by) {
  state.allowances = { ...(state.allowances || {}), bom: { from, to, used: false, at: new Date().toISOString() } };
  appendApproval(root, `nâng BOM ${from} → ${to} · ${by}`);
}

function decide(root) {
  const featureId = option('feature');
  const decisionId = option('decision');
  const choice = option('choice');
  const quote = option('quote');
  const auto = process.argv.includes('--auto');
  const provisional = process.argv.includes('--provisional') && !auto;
  const why = option('why');
  if (!featureId || !decisionId || !choice || (!quote && !provisional && !auto)) fail('Cần --feature, --decision, --choice và --quote (lời PO, nguyên văn); trợ lý tự chọn thì --provisional --why "<lý do>" thay cho --quote');
  if (provisional && !why) fail('--provisional cần --why "<lý do chọn>" — PO đọc lý do ở cổng 3');
  const state = S.readState(root);
  const target = state.features.find(f => f.id === featureId);
  const decision = target && (target.decisions || []).find(d => d.id === decisionId);
  if (!decision) fail(`Không có quyết định ${decisionId} của feature ${featureId}`);
  const picked = decision.options.find(o => o.label === choice);
  if (!picked) fail(`--choice phải đúng một nhãn: ${decision.options.map(o => o.label).join(' | ')}`);
  if (auto && picked.bom) fail('Nâng BOM không chọn bằng --auto — dùng --provisional --why "<lý do>"');
  const openBom = (state.allowances || {}).bom;
  if (provisional && picked.bom && openBom && !openBom.used && (openBom.from !== picked.bom.from || openBom.to !== picked.bom.to)) fail(`Đang có quyền nâng BOM ${openBom.from} → ${openBom.to} chưa dùng — làm xong plan đó trước rồi chọn lại`);
  if (provisional && figmaSettles(decision) && choice !== decision.figma) fail(`Figma đã trả lời: chọn "${decision.figma}" (--auto)`);
  const byFigma = auto && figmaSettles(decision) && choice === decision.figma;
  if (auto && !byFigma && (decision.kind !== 'ui' || picked.owner !== 'app-feature-dev' || picked.bom || decision.blocking)) fail('--auto chỉ cho quyết định kind ui mà lựa chọn là app tự vẽ (owner app-feature-dev), hoặc lựa chọn giống Figma (figma) khi spec không nói khác — còn lại trợ lý tự chọn bằng --provisional --why "<lý do>"');
  if ((auto || provisional) && decision.choice && !decision.provisional && !decision.auto) fail(`Quyết định ${decisionId} đã có lựa chọn của PO — không ghi đè`);
  const changed = Boolean(decision.provisional && decision.choice && decision.choice !== choice);
  if (!provisional && !auto) appendApproval(root, `${featureId}/${decisionId}: ${choice} · PO: "${quote}"`);
  const resumed = S.updateState(root, fresh => {
    const target = fresh.features.find(f => f.id === featureId).decisions.find(d => d.id === decisionId);
    target.choice = choice;
    target.provisional = provisional;
    target.auto = auto;
    target.byFigma = byFigma;
    if (why) target.why = why;
    else delete target.why;
    const before = decision.options.find(o => o.label === decision.choice);
    const granted = (fresh.allowances || {}).bom;
    if (before && before.bom && !picked.bom && granted && !granted.used && granted.to === before.bom.to) delete fresh.allowances.bom;
    if (picked.bom) grantBom(root, fresh, picked.bom.from, picked.bom.to, quote ? `PO: "${quote}"` : `trợ lý tự nâng (không phải lời PO) — ${why}`);
    return resumePlans(root, fresh);
  });
  writeAutoDecisions(root);
  print({ feature: featureId, decision: decisionId, choice, provisional, auto, byFigma, ...(why ? { why } : {}), changedFromProvisional: changed, owner: picked.owner, bom: picked.bom || null, resumed });
}

// Plans owning a feature with an open blocking decision wait; their worktree (if any) stays for the answer.
function parkPlans(root, state) {
  const waiting = new Set(waitingPlans(root, state));
  const parked = [];
  for (const id of waiting) {
    const plan = state.plans[id] || { status: 'todo', files: [] };
    // Only work not yet reviewed parks; a reviewed or conflicting plan keeps its merge progress.
    if (!['todo', 'coding', 'coded'].includes(plan.status)) continue;
    state.plans[id] = { ...plan, status: 'waiting-po', resumeTo: plan.worktree ? 'coding' : 'todo' };
    parked.push(id);
  }
  return parked;
}

function resumePlans(root, state) {
  const waiting = new Set(waitingPlans(root, state));
  const resumed = [];
  for (const [id, plan] of Object.entries(state.plans || {})) {
    if (plan.status !== 'waiting-po' || waiting.has(id)) continue;
    state.plans[id] = { ...plan, status: plan.resumeTo || 'todo' };
    delete state.plans[id].resumeTo;
    resumed.push(id);
  }
  return resumed;
}

function allow(root, what) {
  if (what !== 'bom') fail('Chỉ hỗ trợ: allow bom --from <version> --to <version> --quote "<lời PO>"');
  const from = option('from');
  const to = option('to');
  const quote = option('quote');
  if (!from || !to || !quote) fail('Cần --from, --to và --quote (lời PO, nguyên văn)');
  if (from === to) fail('--from và --to trùng nhau');
  const state = S.readState(root);
  grantBom(root, state, from, to, `PO: "${quote}"`);
  S.writeState(root, state);
  print({ bom: state.allowances.bom });
}

module.exports = { feature, decide, allow };
