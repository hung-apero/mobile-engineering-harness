// Figma already answers a decision: one option is what the Figma frame shows and the clarified spec says nothing
// against it. The Looper picks that option itself (a business rule too), unless it needs a BOM change; such a
// decision never blocks and is never asked.
function figmaSettles(decision) {
  const option = decision && decision.figma !== undefined && (decision.options || []).find(o => o.label === decision.figma);
  return Boolean(option && !decision.specConflict && !option.bom);
}

module.exports = { figmaSettles };
