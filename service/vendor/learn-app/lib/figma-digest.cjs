const fs = require('fs');
const path = require('path');
const { DIR } = require('./learn-app-state.cjs');

const KINDS = ['screen', 'popup', 'sheet', 'dialog', 'state'];
const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const DOOR = /^(app|sdk)\b.*:\s*\S/;
const SPACING = /^(\?|(padding|gap|itemSpacing)(\s+\d+(\.\d+)?){1,4})$/;
const isStr = v => typeof v === 'string' && v.trim() !== '';
const CATALOG = path.join(__dirname, '..', 'skills/learn-sdk-integrate/catalog/learn');
const isStockDoor = door => typeof door === 'string' && /^sdk\b[^:]*:\s*[\w-]+\s+[—–-]\s*stock\b/i.test(door);
const NOT_STOCK = 'Figma còn chữ/asset riêng → không phải stock; chọn override nhỏ nhất (UI rules: Ưu tiên app)';

function stockErrors(d) {
  const errors = [];
  const ref = d.stockRef;
  if (!isStr(ref)) errors.push('stockRef (door stock): ảnh gốc SDK trong catalog, dạng "<feature>/images/NN.png"');
  else if (path.isAbsolute(ref) || ref.split(/[\\/]/).includes('..')) errors.push(`stockRef phải là đường dẫn tương đối dưới catalog/learn (${ref})`);
  else if (!/\.(png|jpe?g|webp)$/i.test(ref) || !fs.existsSync(path.join(CATALOG, ref)) || !fs.statSync(path.join(CATALOG, ref)).isFile()) errors.push(`stockRef: catalog/learn/${ref} không phải ảnh có thật — chọn ảnh trong <feature>/images/`);
  if (Array.isArray(d.copy) && d.copy.length) errors.push(`copy phải [] khi door stock — ${NOT_STOCK}`);
  if (Array.isArray(d.assets) && d.assets.length) errors.push(`assets phải [] khi door stock — ${NOT_STOCK}`);
  return errors;
}

function digestRel(slug) {
  return `figma/${slug}.json`;
}

function validateDigest(d, slug, { full = true } = {}) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return ['phải là JSON object'];
  const errors = [];
  if (d.slug !== slug) errors.push(`slug phải là "${slug}" (trùng tên file)`);
  if (!isStr(d.node)) errors.push('node: id node Figma bắt buộc');
  if (!isStr(d.name)) errors.push('name: tên node bắt buộc');
  const kind = d.kind || 'screen';
  if (!KINDS.includes(kind)) errors.push(`kind phải là ${KINDS.join('|')}`);
  if (kind !== 'screen' && !isStr(d.parent)) errors.push('parent: slug của màn chứa node này');
  if (d.door != null || full) {
    if (!isStr(d.door) || !DOOR.test(d.door)) errors.push(`door${full ? ' (planner chốt)' : ''}: "app: <file hoặc mới>" | "app (SDK data): <API>" | "sdk: <feature> — <override>"`);
  }
  if (full && isStockDoor(d.door)) errors.push(...stockErrors(d));
  if (d.builtFrom != null && !isStr(d.builtFrom)) errors.push('builtFrom: chuỗi hash node figma lúc sinh digest');
  else if (full && !isStr(d.builtFrom)) errors.push('builtFrom (planner chốt): hash node figma lúc đọc (= inputs/figma-fingerprint.json[node])');
  if (!Array.isArray(d.copy) || d.copy.some(c => !isStr(c))) errors.push('copy: mảng chuỗi app tự đưa ([] nếu không có)');
  if (!Array.isArray(d.assets)) errors.push('assets: mảng { figma, path } ([] nếu không có)');
  else d.assets.forEach((a, i) => {
    if (!a || !isStr(a.figma)) errors.push(`assets[${i}].figma: id node icon/ảnh bắt buộc`);
    if (a && a.path != null && (!isStr(a.path) || path.isAbsolute(a.path) || a.path.split(/[\\/]/).includes('..'))) errors.push(`assets[${i}].path phải là đường dẫn tương đối trong repo (${a.path})`);
    else if (full && (!a || !isStr(a.path))) errors.push(`assets[${i}].path (planner chốt): đường dẫn trong repo app bắt buộc`);
  });
  if (d.tokens != null && (typeof d.tokens !== 'object' || Array.isArray(d.tokens))) errors.push('tokens: object { "<phần tử>": "<token app>" }');
  if (d.spacing != null) {
    if (typeof d.spacing !== 'object' || Array.isArray(d.spacing)) errors.push('spacing: object { "<phần tử>": "padding|gap|itemSpacing <số dp>…" | "?" }');
    else for (const [k, v] of Object.entries(d.spacing)) {
      if (typeof v !== 'string' || !SPACING.test(v.trim())) errors.push(`spacing.${k}: "padding|gap|itemSpacing <số dp>…" hoặc "?" (${v})`);
    }
  }
  if (d.notes != null && typeof d.notes !== 'string') errors.push('notes: chuỗi');
  if (d.unclear != null && (!Array.isArray(d.unclear) || d.unclear.some(u => !isStr(u)))) errors.push('unclear: mảng chuỗi');
  else if (full && Array.isArray(d.unclear) && d.unclear.length) errors.push(`unclear còn ${d.unclear.length} mục — planner xử lý theo câu trả lời PO rồi xoá`);
  return errors;
}

function readDigest(root, slug, opts) {
  const file = path.join(root, DIR, digestRel(slug));
  if (!fs.existsSync(file)) return { error: `chưa có ${digestRel(slug)} (ui-node-writer viết ở scout)` };
  let digest;
  try {
    digest = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { error: `${digestRel(slug)} không phải JSON hợp lệ` };
  }
  const errors = validateDigest(digest, slug, opts);
  return errors.length ? { error: `${digestRel(slug)}: ${errors.join('; ')}` } : { digest };
}

function digestSlugs(root) {
  const dir = path.join(root, DIR, 'figma');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).sort();
}

function readDigests(root, opts) {
  return digestSlugs(root).map(slug => (SLUG.test(slug) ? { slug, ...readDigest(root, slug, opts) } :{ slug, error: `figma/${slug}.json: tên file chỉ gồm chữ thường, số và dấu gạch ngang` }));
}

function readFingerprint(root) {
  const fpFile = path.join(root, DIR, 'inputs', 'figma-fingerprint.json');
  if (!fs.existsSync(fpFile)) return {};
  try {
    const data = JSON.parse(fs.readFileSync(fpFile, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

function staleDigests(root) {
  const fp = readFingerprint(root);
  if (!Object.keys(fp).length) return [];
  return readDigests(root, { full: false })
    .filter(d => d.digest && d.digest.node && Object.prototype.hasOwnProperty.call(fp, d.digest.node) && fp[d.digest.node] !== d.digest.builtFrom)
    .map(d => d.slug);
}

function spacingValues(digest) {
  const values = new Set();
  for (const v of Object.values(digest.spacing || {})) {
    for (const m of String(v).matchAll(/\d+(?:\.\d+)?/g)) if (Number(m[0]) !== 0) values.add(Number(m[0]));
  }
  return [...values];
}

module.exports = { KINDS, digestRel, isStockDoor, spacingValues, validateDigest, readDigest, readDigests, readFingerprint, staleDigests };
