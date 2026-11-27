const MAX_ROUNDS = 4;
const NOTE = /^(\S+)\s*\((\d+)\/100\):\s*(.*)$/s;

function parseLeft(left) {
  const scores = new Map();
  for (const item of Array.isArray(left) ? left : []) {
    const match = String(item).match(/^(.+):(\d+)$/);
    if (match) scores.set(match[1], Number(match[2]));
  }
  return scores;
}

function notesOf(build) {
  const notes = new Map();
  for (const line of Array.isArray(build?.notes?.ui) ? build.notes.ui : []) {
    const match = String(line).match(NOTE);
    if (match) notes.set(match[1], match[3].trim());
  }
  return notes;
}

function uiRounds(decisions, build) {
  const rounds = decisions.filter(d => d.action === 'spec-ui-round').map((d, i) => ({ round: i + 1, scores: parseLeft(d.evidence?.left) }));
  const names = [...new Set(rounds.flatMap(r => [...r.scores.keys()]))];
  const shown = rounds.slice(-MAX_ROUNDS);
  const notes = notesOf(build);
  const screens = names.map(name => {
    const first = rounds.findIndex(r => r.scores.has(name));
    const scores = shown.map(r => {
      if (r.scores.has(name)) return r.scores.get(name);
      return rounds.indexOf(r) > first ? 'ok' : null;
    });
    return { name, scores, last: notes.get(name) ?? '' };
  });
  return { rounds: shown.map(r => r.round), screens };
}

module.exports = { uiRounds };
