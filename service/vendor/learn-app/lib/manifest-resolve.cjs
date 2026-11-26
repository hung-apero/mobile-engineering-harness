const fs = require('fs');
const path = require('path');
const { DIR } = require('./learn-app-state.cjs');
const { parseYaml, stringifyYaml } = require('./manifest-yaml.cjs');
const { fillAppIdentity } = require('./manifest-app-identity.cjs');

const SUFFIX = /-(player|builder|remote-builder|local-builder)$/;

function sourcesFor(root, bom) {
  const file = path.join(root, DIR, 'sdk-src', String(bom), '.complete');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

function declaredOf(feature) {
  return [feature.artifact, feature.declared !== 'none' ? feature.declared : null, ...Object.keys(feature.artifacts || {})].filter(Boolean);
}

function prefixesOf(id, feature) {
  return [...new Set([...declaredOf(feature).map(a => a.replace(SUFFIX, '')), `learn-feature-${id}`, `learn-feature-exercise-${id}`])];
}

const under = (name, prefix) => name === prefix || name.startsWith(`${prefix}-`);

function resolveManifest(root) {
  const file = path.join(root, DIR, 'app-manifest.yaml');
  const manifest = parseYaml(fs.readFileSync(file, 'utf8'));
  if (!manifest.features || Array.isArray(manifest.features)) return { skipped: 'app-manifest.yaml còn dạng cũ (features là danh sách) — viết lại bằng spec-clear theo app-manifest-schema.md rồi chạy lại' };
  const identity = fillAppIdentity(root, manifest);
  const skip = skipped => {
    if (identity.length) fs.writeFileSync(file, stringifyYaml(manifest));
    return { skipped, identity };
  };
  const pinned = (manifest.catalog || {})['bom-pinned'];
  if (!pinned) return skip('app-manifest.yaml chưa ghi catalog.bom-pinned (bản learn-bom trong gradle của app) — spec-clear ghi từ code rồi chạy lại');
  const sources = sourcesFor(root, pinned);
  if (!sources) return skip(`chưa phân giải được thư viện Learn bản ${pinned} (chưa có .learn-app/sdk-src/${pinned}) — chạy lại bin/sdk-sources.cjs rồi manifest-resolve`);
  const versions = Object.fromEntries((sources.modules || []).map(m => [m.name, m.version]));
  const features = Object.entries(manifest.features && !Array.isArray(manifest.features) ? manifest.features : {}).filter(([, f]) => f && f.source !== 'app');
  const declared = new Set(features.flatMap(([, f]) => declaredOf(f)));
  const missing = [];
  const owner = {};
  for (const name of Object.keys(versions)) {
    let best = null;
    for (const [id, feature] of features) {
      for (const prefix of prefixesOf(id, feature)) if (under(name, prefix) && (!best || prefix.length > best.length)) best = { id, length: prefix.length };
    }
    if (best) owner[name] = best.id;
  }
  for (const [id, feature] of features) {
    const own = feature.artifact || (feature.declared !== 'none' ? feature.declared : null);
    if (own) {
      if (versions[own]) feature.resolved = versions[own];
      else if (own.startsWith('learn-')) missing.push(own);
    }
    for (const name of Object.keys(feature.artifacts || {})) {
      if (versions[name]) feature.artifacts[name] = versions[name];
      else missing.push(name);
    }
    const transitive = Object.keys(versions).filter(name => !declared.has(name) && owner[name] === id).sort();
    delete feature.transitive;
    if (transitive.length) feature.transitive = Object.fromEntries(transitive.map(name => [name, versions[name]]));
  }
  fs.writeFileSync(file, stringifyYaml(manifest));
  return { bom: pinned, missing, identity };
}

module.exports = { resolveManifest };
