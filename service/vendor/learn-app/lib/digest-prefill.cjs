const fs = require('fs');
const path = require('path');
const { DIR, writeJsonAtomic } = require('./learn-app-state.cjs');
const { digestRel, readFingerprint } = require('./figma-digest.cjs');
const { readPlans } = require('./looper-checks.cjs');

function digestPrefill(root, planId) {
  if (!planId) return { error: 'cần --plan <id>' };
  const plan = readPlans(root).find(p => p.id === planId);
  if (!plan) return { error: `không có plan ${planId}` };
  const fp = readFingerprint(root);
  const filled = [];
  const needAgent = [];
  for (const slug of plan.screens || []) {
    const file = path.join(root, DIR, digestRel(slug));
    if (!fs.existsSync(file)) { needAgent.push(`${slug}: chưa có digest`); continue; }
    let digest;
    try { digest = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { needAgent.push(`${slug}: digest hỏng`); continue; }
    const node = digest.node;
    if (typeof node === 'string' && Object.prototype.hasOwnProperty.call(fp, node) && digest.builtFrom !== fp[node]) {
      digest.builtFrom = fp[node];
      writeJsonAtomic(file, digest);
      filled.push(`${slug}.builtFrom`);
    }
    const gaps = [];
    if (typeof digest.door !== 'string' || !digest.door.trim()) gaps.push('door');
    if (Array.isArray(digest.unclear) && digest.unclear.length) gaps.push('unclear');
    if (Array.isArray(digest.assets) && digest.assets.some(a => !a || typeof a.path !== 'string' || !a.path.trim())) gaps.push('asset.path');
    if (gaps.length) needAgent.push(`${slug}: ${gaps.join(', ')}`);
  }
  return { plan: planId, filled, needAgent };
}

module.exports = { digestPrefill };
