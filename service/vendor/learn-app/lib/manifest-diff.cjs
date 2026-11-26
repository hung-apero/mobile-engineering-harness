const fs = require('fs');
const path = require('path');
const { DIR } = require('./learn-app-state.cjs');
const { parseYaml, stringifyYaml } = require('./manifest-yaml.cjs');

const featureFile = root => path.join(root, DIR, 'app-manifest.yaml');
const templateFile = root => path.join(root, DIR, 'template-manifest.yaml');
const outFile = root => path.join(root, DIR, 'build-delta.yaml');
const fromTemplateFile = root => path.join(root, DIR, 'inputs', 'from-template.json');

function features(manifest) {
  const f = manifest && manifest.features;
  return f && !Array.isArray(f) ? f : {};
}

function appOnly(feature) {
  return feature.source === 'app' || feature.does !== undefined || feature.component !== undefined;
}

function canon(feature) {
  const delta = Array.isArray(feature.delta)
    ? [...feature.delta].map(d => JSON.stringify(d)).sort()
    : [];
  return {
    catalog: feature.catalog === undefined ? null : String(feature.catalog),
    source: feature.source || null,
    module: feature.module || null,
    options: feature.options || {},
    delta,
  };
}

function reasons(a, b) {
  const out = [];
  if (a.catalog !== b.catalog) out.push(`catalog ${a.catalog || '—'}→${b.catalog || '—'}`);
  if (JSON.stringify(a.delta) !== JSON.stringify(b.delta)) out.push('logic-delta đổi');
  if (JSON.stringify(a.options) !== JSON.stringify(b.options)) out.push('options đổi');
  if (a.source !== b.source || a.module !== b.module) out.push('loại feature đổi (catalog↔app)');
  return out;
}

function what(feature) {
  return appOnly(feature) ? 'app' : String(feature.catalog || '—');
}

function diffManifest(root) {
  if (!fs.existsSync(templateFile(root))) {
    return { skipped: 'không có template-manifest.yaml (app không ở mode from-template)' };
  }
  if (!fs.existsSync(featureFile(root))) {
    return { skipped: 'chưa có app-manifest.yaml (manifest-đích) — chạy spec-clear/manifest-resolve trước' };
  }
  const target = parseYaml(fs.readFileSync(featureFile(root), 'utf8'));
  const template = parseYaml(fs.readFileSync(templateFile(root), 'utf8'));
  const tf = features(target);
  const bf = features(template);
  const warnings = [];
  const keep = [];
  const modify = [];
  const add = [];
  const remove = [];

  for (const [id, feature] of Object.entries(tf)) {
    if (!(id in bf)) {
      add.push({ id, what: what(feature) });
      continue;
    }
    const a = canon(bf[id]);
    const b = canon(feature);
    const diff = reasons(a, b);
    if (!diff.length) keep.push({ id, catalog: b.catalog || what(feature) });
    else modify.push({ id, reason: diff.join('; ') });
  }
  for (const id of Object.keys(bf)) {
    if (!(id in tf)) remove.push({ id, what: what(bf[id]) });
  }
  for (const [id, feature] of Object.entries(tf)) {
    if (id in bf && canon(feature).catalog === null && !appOnly(feature)) {
      warnings.push(`features.${id} không ghi catalog ở manifest-đích — không chắc KEEP/MODIFY, cân nhắc xếp MODIFY`);
    }
  }

  let ref = null;
  if (fs.existsSync(fromTemplateFile(root))) {
    try { ref = (JSON.parse(fs.readFileSync(fromTemplateFile(root), 'utf8')) || {}).ref || null; } catch { ref = null; }
  }

  const delta = {
    schema: '1.0.0',
    template: { manifest: 'template-manifest.yaml', ref: ref || '' },
    keep,
    modify,
    add,
    remove,
    warnings,
  };
  fs.writeFileSync(outFile(root), stringifyYaml(delta));
  return { keep: keep.length, modify: modify.length, add: add.length, remove: remove.length, warnings };
}

module.exports = { diffManifest };
