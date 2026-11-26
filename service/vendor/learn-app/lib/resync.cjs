const L = require('./looper-steps.cjs');
const { specVersions, olderThanRawSpec, rawSpecVersion } = require('./looper-parse.cjs');
const { staleDigests } = require('./figma-digest.cjs');

function earliestStaleStep(root, state) {
  if (staleDigests(root).length || olderThanRawSpec(root, state, 'scout.md')) return 'scout';
  if (olderThanRawSpec(root, state, 'questions.md')) return 'ask';
  if (olderThanRawSpec(root, state, 'app-manifest.yaml')) return 'update-spec';
  return null;
}

function resync(root, state) {
  const from = state.step;
  const prevRaw = rawSpecVersion(state);
  const versions = specVersions(root);
  if (versions.length) state.rawSpecVersion = versions[versions.length - 1];
  const specBumped = rawSpecVersion(state) > prevRaw;

  const stale = earliestStaleStep(root, state);
  if (!stale || L.stepIndex(stale) >= L.stepIndex(from)) {
    return { ok: true, from, to: from, rewound: false, specBumped, rawSpecVersion: rawSpecVersion(state) };
  }

  state.gates = state.gates || {};
  for (const gate of L.gatesReopenedBy(stale).filter(g => g !== 'g1' || specBumped)) state.gates[gate] = { status: 'pending' };
  state.step = stale;
  state.done = false;
  const reason = specBumped ? `spec đổi (spec-v${rawSpecVersion(state)}) — làm lại từ bước ${stale}` : 'Figma đổi — đọc lại node rồi regen digest';
  state.history = [...(state.history || []), { at: new Date().toISOString(), action: 'resync', from, to: stale, reason }];
  return { ok: true, from, to: stale, rewound: true, specBumped, reason, rawSpecVersion: rawSpecVersion(state) };
}

module.exports = { resync, earliestStaleStep };
