const S = require('./learn-app-state.cjs');
const { fail, print, option } = require('./cli-io.cjs');
const { readPlans } = require('./looper-parse.cjs');
const { statusOf } = require('./plan-schedule.cjs');
const fs = require('fs');
const path = require('path');
const { JUDGED_STEPS, writeVerdict, readVerdict } = require('./verdicts.cjs');

const DEBT_AFTER = 3;

function verdictKey(state, root) {
  const step = option('step');
  if (step === 'review') {
    const plan = option('plan');
    if (!plan) fail('Cần --plan <id> khi --step review');
    const found = readPlans(root).find(p => p.id === plan);
    if (!found) fail(`Không có plan ${plan} trong .learn-app/plans/`);
    const status = statusOf(state, plan);
    const allowed = ['coded', 'reviewed'];
    if (state.step !== 'coding' || !allowed.includes(status)) fail(`Chỉ chấm code của plan ${plan} ở bước coding khi plan đang ${allowed.join(' hoặc ')}, đang ở ${state.step} · plan ${status}`);
    return `review:${plan}`;
  }
  if (!JUDGED_STEPS.includes(step)) fail(`--step phải là ${[...JUDGED_STEPS, 'review'].join('|')}`);
  if (state.step !== step) fail(`Chỉ chấm bước ${step} khi đang ở bước đó, đang ở ${state.step}`);
  return step;
}

function verdict(root) {
  const state = S.readState(root);
  const key = verdictKey(state, root);
  const passRaw = option('pass');
  if (!['true', 'false'].includes(passRaw)) fail('Cần --pass true|false');
  const reasons = (option('reasons') || '').split(';').map(r => r.trim()).filter(Boolean);
  const pass = passRaw === 'true';
  if (!pass && !reasons.length) fail('Chấm không đạt thì cần --reasons "lý do 1; lý do 2"');
  const previous = readVerdict(root, key);
  const saved = writeVerdict(root, key, state, { pass, reasons, by: option('by') || 'judge' });
  const sameContentFailedAgain = !pass && previous && previous.pass === false && JSON.stringify(previous.inputs) === JSON.stringify(saved.inputs);
  const count = S.updateState(root, fresh => {
    const fails = { ...(fresh.judgeFails || {}) };
    if (pass) delete fails[key];
    else if (!sameContentFailedAgain) fails[key] = (fails[key] || 0) + 1;
    fresh.judgeFails = fails;
    return fails[key] || 0;
  });
  if (!pass && count >= DEBT_AFTER && key.startsWith('review:')) {
    writeVerdict(root, key, state, { pass: true, reasons, by: 'auto', debt: true });
    S.updateState(root, fresh => {
      delete fresh.judgeFails[key];
    });
    print({ key, pass: false, reasons, fails: count, debt: true, inputs: Object.keys(saved.inputs) });
    return;
  }
  print({ key, pass, reasons, fails: count, inputs: Object.keys(saved.inputs) });
}

function approval(root, line) {
  fs.appendFileSync(path.join(root, S.DIR, 'gates', 'approvals.md'), `\n- ${new Date().toISOString()} · ${line}\n`);
}

function accept(root) {
  const quote = option('quote');
  if (!quote) fail('Cần --quote: lời PO chấp nhận, ghi nguyên văn');
  const state = S.readState(root);
  const key = verdictKey(state, root);
  const fails = (state.judgeFails || {})[key] || 0;
  const current = readVerdict(root, key);
  if (!current || current.pass !== false) fail(`Chưa có kết quả chấm không đạt cho ${key} — PO chỉ chấp nhận thứ đã bị chấm trượt`);
  const lastReasons = (current && current.reasons) || [];
  const reasons = lastReasons.map(reason => `PO chấp nhận dù: ${reason}`);
  writeVerdict(root, key, state, { pass: true, reasons, by: 'PO' });
  S.updateState(root, fresh => {
    fresh.judgeFails = { ...(fresh.judgeFails || {}) };
    delete fresh.judgeFails[key];
  });
  approval(root, `chấp nhận ${key} sau ${fails} lần chấm không đạt (${lastReasons.join('; ') || '—'}) · PO: "${quote}"`);
  print({ key, acceptedBy: 'PO', fails, reasons });
}

module.exports = { verdict, accept };
