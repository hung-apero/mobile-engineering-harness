const fs = require('fs');
const path = require('path');
const { DIR } = require('./learn-app-state.cjs');
const { readDigests } = require('./figma-digest.cjs');

function slug(value) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function readFrames(root) {
  const file = path.join(root, DIR, 'inputs', 'figma.json');
  if (!fs.existsSync(file)) return { frames: [], problems: [] };
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { frames: [], problems: ['inputs/figma.json hỏng — cần dạng { "<frameId>": "<tên màn>" }'] };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { frames: [], problems: ['inputs/figma.json phải là { "<frameId>": "<tên màn>" }'] };
  const entries = Object.entries(data);
  const bad = entries.filter(([, name]) => typeof name !== 'string' || !name.trim()).map(([id]) => id);
  return { frames: entries.filter(([id]) => !bad.includes(id)), problems: bad.length ? [`inputs/figma.json có frame không có tên màn: ${bad.join(', ')}`] : [] };
}

function figmaNodes(root) {
  const digests = readDigests(root, { full: false }).filter(d => d.digest);
  if (digests.length) return digests.map(({ slug: key, digest }) => ({ slug: key, name: digest.name, nodeId: digest.node, kind: digest.kind || 'screen', parent: digest.parent || null, door: digest.door }));
  return readFrames(root).frames.map(([frameId, name]) => ({ slug: slug(name) || `frame-${slug(frameId)}`, name, nodeId: frameId, kind: 'screen', parent: null, door: null }));
}

function digestProblems(root, opts) {
  const { frames, problems } = readFrames(root);
  if (!frames.length) return problems;
  const all = readDigests(root, opts);
  const out = [...problems, ...all.filter(d => d.error).map(d => d.error)];
  const good = all.filter(d => d.digest);
  const slugs = new Set(good.map(d => d.slug));
  for (const [frameId, name] of frames) {
    if (!good.some(d => d.digest.node === frameId)) out.push(`frame ${frameId} ("${name}") chưa có digest trong figma/ (ui-node-writer: đọc node theo figma-source.json rồi viết figma/<slug>.json)`);
  }
  for (const { slug: key, digest } of good) {
    if ((digest.kind || 'screen') !== 'screen' && !slugs.has(digest.parent)) out.push(`figma/${key}.json: parent "${digest.parent}" không phải slug một digest có thật`);
  }
  return out;
}

function planScreensDigestFull(root, plan) {
  const screens = new Set(plan.screens || []);
  if (!screens.size) return [];
  return readDigests(root, { full: true }).filter(d => screens.has(d.slug) && d.error).map(d => d.error);
}

function screenAssignmentProblems(root, plans) {
  const screens = figmaNodes(root);
  const known = new Set(screens.map(s => s.slug));
  const problems = [];
  for (const plan of plans) {
    const unknown = plan.screens.filter(s => !known.has(s));
    if (unknown.length) problems.push(`${plan.id} có màn không có digest Figma: ${unknown.join(', ')} (dùng tên file trong figma/)`);
  }
  for (const screen of screens) {
    const owners = plans.filter(p => p.screens.includes(screen.slug)).map(p => p.id);
    if (owners.length !== 1) problems.push(`màn ${screen.slug} ${owners.length ? `thuộc nhiều plan: ${owners.join(', ')}` : 'chưa thuộc plan nào (screens: trong plan)'}`);
  }
  return problems;
}

module.exports = { slug, readFrames, figmaNodes, digestProblems, screenAssignmentProblems, planScreensDigestFull };
