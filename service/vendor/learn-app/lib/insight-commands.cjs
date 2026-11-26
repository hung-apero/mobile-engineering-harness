const fs = require('fs');
const path = require('path');
const S = require('./learn-app-state.cjs');
const { print } = require('./cli-io.cjs');
const { readPlans } = require('./looper-parse.cjs');
const { waves } = require('./plan-overlap.cjs');
const { questionItems } = require('./questions.cjs');

function planTitle(root, plan) {
  const text = fs.readFileSync(path.join(root, S.DIR, 'plans', plan.file), 'utf8');
  const heading = text.replace(/\r/g, '').replace(/^---\n[\s\S]*?\n---\n/, '').match(/^# (.+)$/m);
  return heading ? heading[1].trim() : plan.id;
}

function planWaves(root) {
  const plans = readPlans(root).filter(p => p.id);
  const byId = Object.fromEntries(plans.map(p => [p.id, p]));
  const result = waves(plans).map((ids, index) => ({
    wave: index + 1,
    plans: ids.map(id => ({ id, kind: byId[id].kind, title: planTitle(root, byId[id]) })),
  }));
  print({ waves: result, widest: Math.max(0, ...result.map(w => w.plans.length)) });
}

function questions(root) {
  const items = questionItems(root, S.readState(root)).sort((a, b) => Number(Boolean(b.blocking)) - Number(Boolean(a.blocking)));
  print({ count: items.length, items });
}

module.exports = { planWaves, questions };
