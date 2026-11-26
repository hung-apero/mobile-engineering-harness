const fs = require('fs');
const path = require('path');
const { DIR, writeJsonAtomic } = require('./learn-app-state.cjs');
const { checkStep } = require('./looper-checks.cjs');

const FIXABLE = /^(chưa có )?figma\/[^:\s]+\.json/;
const MAX_REFUSALS = 3;

function readCounts(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function fixableBeforeBlock(root, state) {
  const items = checkStep(root, state, state.step).filter(item => FIXABLE.test(item));
  if (!items.length) return [];
  const file = path.join(root, DIR, 'headless-refusals.json');
  const counts = readCounts(file);
  const used = counts[state.step] || 0;
  if (used >= MAX_REFUSALS) return [];
  writeJsonAtomic(file, { ...counts, [state.step]: used + 1 });
  return items;
}

module.exports = { fixableBeforeBlock };
