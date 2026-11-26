const fs = require('node:fs');
const path = require('node:path');

const MAX_BYTES = 10 * 1024 * 1024;
const KINDS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.txt', '.log', '.json']);

function saveAttachments(result, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const root = path.resolve(dir);
  const saved = [];
  for (const item of result?.content ?? []) {
    const resource = item.type === 'resource' ? item.resource : null;
    if (!resource?.blob) continue;
    const base = decodeURIComponent(String(resource.uri).split('/').pop() ?? '');
    const name = path.basename(base.replace(/\\/g, '/')).replace(/[^\w.-]+/g, '_').replace(/^\.+/, '');
    if (!name || !KINDS.has(path.extname(name).toLowerCase())) continue;
    const data = Buffer.from(resource.blob, 'base64');
    if (data.length > MAX_BYTES) continue;
    const target = path.resolve(root, name);
    if (path.dirname(target) !== root) continue;
    fs.writeFileSync(target, data);
    saved.push(target);
  }
  return saved;
}

module.exports = { saveAttachments };
