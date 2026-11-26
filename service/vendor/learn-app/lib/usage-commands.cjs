const fs = require('fs');
const path = require('path');
const S = require('./learn-app-state.cjs');
const { trackingDir, readJsonl } = require('./tracking.cjs');
const { fail, print, option } = require('./cli-io.cjs');

function usageFile(root) {
  return path.join(trackingDir(root), 'usage.jsonl');
}

function readUsage(root) {
  const file = usageFile(root);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function count(value, name) {
  const number = Number(value);
  if (value === undefined || !Number.isInteger(number) || number < 0) fail(`Cần --${name} <số nguyên ≥ 0>`);
  return number;
}

function record(root, agent) {
  const entry = {
    at: new Date().toISOString(),
    step: S.readState(root).step,
    plan: option('plan') || null,
    agent,
    model: option('model') || 'inherit',
    tokens: count(option('tokens'), 'tokens'),
    ms: count(option('ms') || '0', 'ms'),
  };
  fs.mkdirSync(trackingDir(root), { recursive: true });
  fs.appendFileSync(usageFile(root), `${JSON.stringify(entry)}\n`);
  print({ recorded: entry });
}

function add(totals, entry) {
  totals.runs += 1;
  totals.tokens += entry.tokens;
  totals.ms += entry.ms;
}

function summary(root) {
  const total = { runs: 0, tokens: 0, ms: 0 };
  const byAgent = {};
  const byStep = {};
  for (const entry of readUsage(root)) {
    add(total, entry);
    add(byAgent[`${entry.agent}\t${entry.model}`] ||= { agent: entry.agent, model: entry.model, runs: 0, tokens: 0, ms: 0 }, entry);
    add(byStep[entry.step] ||= { runs: 0, tokens: 0, ms: 0 }, entry);
  }
  print({ total, byAgent: Object.values(byAgent).sort((a, b) => b.tokens - a.tokens), byStep });
}

function usage(root) {
  const agent = option('agent');
  if (agent) record(root, agent);
  else summary(root);
}

// Each steps.jsonl event enters step `to` at its `at`; the step is occupied until the next event (or now).
function stepSpans(events) {
  const sorted = [...events].sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const spans = {};
  for (let i = 0; i < sorted.length; i += 1) {
    const step = sorted[i].to;
    if (!step) continue;
    const enter = Date.parse(sorted[i].at);
    const leave = i + 1 < sorted.length ? Date.parse(sorted[i + 1].at) : Date.now();
    if (!Number.isFinite(enter) || !Number.isFinite(leave) || leave < enter) continue;
    spans[step] = (spans[step] || 0) + (leave - enter);
  }
  return spans;
}

function emptyBucket() {
  return { llmMs: 0, buildMs: 0, queueWaitMs: 0, wallMs: 0, tokens: 0, runs: 0, builds: 0 };
}

function timeline(root) {
  const byStep = {};
  const ensure = step => (byStep[step || 'unknown'] ||= emptyBucket());
  for (const entry of readUsage(root)) {
    const bucket = ensure(entry.step);
    bucket.llmMs += entry.ms || 0;
    bucket.tokens += entry.tokens || 0;
    bucket.runs += 1;
  }
  for (const entry of readJsonl(root, 'build.jsonl')) {
    const bucket = ensure(entry.step);
    bucket.buildMs += entry.durationMs || 0;
    bucket.queueWaitMs += entry.queueWaitMs || 0;
    bucket.builds += 1;
  }
  for (const [step, ms] of Object.entries(stepSpans(readJsonl(root, 'steps.jsonl')))) ensure(step).wallMs += ms;
  const total = Object.values(byStep).reduce((sum, bucket) => {
    for (const key of Object.keys(sum)) sum[key] += bucket[key];
    return sum;
  }, emptyBucket());
  print({ byStep, total });
}

module.exports = { usage, timeline };
