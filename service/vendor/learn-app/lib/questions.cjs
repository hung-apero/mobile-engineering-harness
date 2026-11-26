const { readPlans } = require('./looper-parse.cjs');
const { figmaSettles } = require('./figma-first.cjs');

// Everything the PO has to look at, asked in one batch once no plan can go on without them.
function questionItems(root, state) {
  const items = [];
  for (const f of state.features || []) {
    for (const d of f.decisions || []) {
      // Figma settles it: the Looper picks the Figma option (decide --auto), the PO is not asked.
      if (!d.choice && figmaSettles(d)) continue;
      if (!d.choice) items.push({ kind: 'decision', feature: f.id, decision: d.id, question: d.question, options: (d.options || []).map(o => ({ label: o.label, cost: o.cost || null })), blocking: Boolean(d.blocking), answer: `decide --feature ${f.id} --decision ${d.id} --choice "<nhãn>" --quote "<lời PO>"` });
    }
  }
  return items;
}

function pickOption(decision) {
  const options = decision.options || [];
  if (figmaSettles(decision)) return decision.figma;
  if (decision.recommended && options.some(o => o.label === decision.recommended)) return decision.recommended;
  return (options.find(o => o.owner === 'app-feature-dev' && !o.bom) || options.find(o => !o.bom) || options[0] || {}).label;
}

function autoPickable(decision, label) {
  const picked = (decision.options || []).find(o => o.label === label);
  if (!picked || picked.bom) return false;
  return figmaSettles(decision) ? label === decision.figma : decision.kind === 'ui' && picked.owner === 'app-feature-dev' && !decision.blocking;
}

function undecidedItems(state) {
  return (state.features || []).flatMap(f => (f.decisions || []).filter(d => !d.choice).map(d => {
    const pick = pickOption(d);
    return { feature: f.id, decision: d.id, pick, auto: autoPickable(d, pick) };
  }));
}

function waitingPlans(root, state) {
  const blocked = new Set((state.features || []).filter(f => (f.decisions || []).some(d => !d.choice && d.blocking)).map(f => f.id));
  return readPlans(root).filter(p => p.features.some(id => blocked.has(id))).map(p => p.id);
}

module.exports = { questionItems, waitingPlans, pickOption, undecidedItems };
