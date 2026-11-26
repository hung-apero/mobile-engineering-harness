const fs = require('fs');
const path = require('path');

function parseBuildErrors(log, root) {
  const errors = [];
  for (const match of log.matchAll(/^e: (?:file:\/\/)?(.+?):(\d+):\d+ (.+)$/gm)) {
    errors.push({ file: path.relative(root, match[1]).split(path.sep).join('/'), line: Number(match[2]), message: match[3].trim() });
  }
  const wrong = log.match(/\* What went wrong:\n([\s\S]*?)\n\s*\n\* Try:/);
  if (wrong) errors.push({ file: null, line: null, message: wrong[1].split('\n').map(l => l.trim()).filter(Boolean).slice(0, 3).join(' ') });
  return errors;
}

function metadataDirs(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return metadataDirs(full);
    return entry.name === 'output-metadata.json' ? [dir] : [];
  });
}

function variantApkDir(root, variant) {
  const apkRoot = path.join(root, 'app/build/outputs/apk');
  for (const dir of metadataDirs(apkRoot)) {
    try {
      if (JSON.parse(fs.readFileSync(path.join(dir, 'output-metadata.json'), 'utf8')).variantName === variant) return dir;
    } catch {}
  }
  const split = variant.match(/^(.*[a-z0-9])([A-Z][a-z0-9]*)$/);
  return split ? path.join(apkRoot, split[1], split[2].toLowerCase()) : path.join(apkRoot, variant.toLowerCase());
}

function fingerprint(stage, error) {
  return `${stage}:${error.file || '-'}:${error.message.replace(/\d+/g, '#').slice(0, 120)}`;
}

module.exports = { parseBuildErrors, variantApkDir, fingerprint };
