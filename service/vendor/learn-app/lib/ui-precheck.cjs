const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { readDigest, spacingValues, isStockDoor } = require('./figma-digest.cjs');
const { SKIP, DP, isTokenFile, readTokens, tokenForLiteral } = require('./design-tokens.cjs');

const NON_VECTOR = new Set(['bitmap', 'selector', 'layer-list', 'level-list', 'inset', 'shape', 'ripple']);

function findDirs(dir, test, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || SKIP.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (test(e.name, full)) out.push(full);
    findDirs(full, test, out);
  }
  return out;
}

const resSubDirs = (code, re) => findDirs(code, (name, full) => re.test(name) && /[\\/]src[\\/][^\\/]+[\\/]res(-[\w-]+)?[\\/]/.test(`${full}/`));

function unescapeXml(s) {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '')
    .replace(/\\(['"@?])/g, '$1').replace(/\\n/g, ' ').replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}
const norm = s => s.replace(/\s+/g, ' ').trim();

function stringIndex(code) {
  const entries = [];
  const add = (key, raw) => entries.push({ key, value: norm(unescapeXml(raw)) });
  for (const dir of resSubDirs(code, /^values$/)) {
    for (const f of fs.readdirSync(dir).filter(n => /^strings.*\.xml$/.test(n))) {
      const xml = fs.readFileSync(path.join(dir, f), 'utf8');
      for (const m of xml.matchAll(/<string(?=[\s>])[^>]*\bname="([^"]+)"[^>]*>([\s\S]*?)<\/string>/g)) add(m[1], m[2]);
      for (const m of xml.matchAll(/<(string-array|plurals)\b[^>]*\bname="([^"]+)"[^>]*>([\s\S]*?)<\/\1>/g)) {
        for (const item of m[3].matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/g)) add(m[2], item[1]);
      }
    }
  }
  for (const e of entries) {
    if (/%(\d+\$)?[sdf]/.test(e.value) && e.value.replace(/%(\d+\$)?[sdf]|\s/g, '')) e.re = new RegExp(`^${e.value.split(/%(?:\d+\$)?[sdf]/).map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  }
  const keysFor = copy => {
    const c = norm(copy);
    return [...new Set(entries.filter(e => e.value === c || (e.re && e.re.test(c))).map(e => e.key))];
  };
  return { has: copy => keysFor(copy).length > 0, keysFor };
}

function planKt(code, files) {
  return files.filter(f => f.endsWith('.kt') && !/\/(test|androidTest)\//.test(f) && fs.existsSync(path.join(code, f)));
}

const planText = (code, files) => planKt(code, files).map(f => fs.readFileSync(path.join(code, f), 'utf8')).join('\n');

function spacingMatcher(code, files) {
  const text = planText(code, files);
  const spacing = readTokens(code).spacing;
  return value => new RegExp(`(^|[^\\d.])${String(value).replace('.', '\\.')}(\\.0)?\\.dp\\b`).test(text)
    || spacing.some(t => t.value === value && new RegExp(`\\.${t.name.split('.').pop()}\\b`).test(text));
}

const RES_FILE = /[\\/]res[\\/][^\\/]+[\\/][^\\/]+$/;

function resRef(assetPath) {
  const parts = assetPath.split(/[\\/]/);
  return { type: parts[parts.length - 2].split('-')[0], name: parts[parts.length - 1].split('.')[0] };
}

function unusedErrors(slug, digest, strings, code, kt) {
  const errors = [];
  const hint = 'Vẽ qua đúng override của door; component dùng chung thì thêm file đó vào files của plan.';
  const unused = digest.assets.filter(a => RES_FILE.test(a.path) && fs.existsSync(path.join(code, a.path))).map(a => resRef(a.path))
    .filter(r => !new RegExp(`\\b\\w*R\\.${r.type}\\.${r.name}\\b`).test(kt));
  if (unused.length) errors.push(`[Figma] ${slug}: asset export nhưng code plan không dùng — ${unused.slice(0, 4).map(r => `R.${r.type}.${r.name}`).join(', ')}. ${hint}`);
  const idle = digest.copy.map(c => ({ c, keys: strings.keysFor(c) }))
    .filter(({ keys }) => keys.length && !keys.some(k => new RegExp(`\\b\\w*R\\.(string|plurals|array)\\.${k}\\b`).test(kt)));
  if (idle.length) errors.push(`[Figma] ${slug}: ${idle.length}/${digest.copy.length} chữ có trong strings.xml nhưng code plan không dùng — ${idle.slice(0, 4).map(({ c, keys }) => `"${c.slice(0, 40)}" (${keys[0]})`).join(', ')}. ${hint}`);
  return errors;
}

function digestErrors(root, code, screens, files) {
  const errors = [];
  let strings = null;
  let spaced = null;
  let kt;
  for (const slug of screens) {
    const { digest, error } = readDigest(root, slug);
    if (error) { errors.push(`[Figma] ${error}`); continue; }
    strings = strings || stringIndex(code);
    const lost = digest.copy.filter(c => !strings.has(c));
    if (lost.length) errors.push(`[Figma] ${slug}: ${lost.length}/${digest.copy.length} chữ không có trong values/strings*.xml — ${lost.slice(0, 4).map(c => `"${c.slice(0, 40)}"`).join(', ')}. Thêm string resource đúng chữ Figma.`);
    const gone = digest.assets.filter(a => !fs.existsSync(path.join(code, a.path)));
    if (gone.length) errors.push(`[Figma] ${slug}: asset chưa có trong repo — ${gone.slice(0, 4).map(a => a.path).join(', ')}. Export từ Figma, không vẽ tay hay dùng icon thay tạm.`);
    if (kt === undefined) kt = planKt(code, files).length ? planText(code, files) : null;
    if (kt != null && !isStockDoor(digest.door)) errors.push(...unusedErrors(slug, digest, strings, code, kt));
    if (!/^app\b/.test(digest.door)) continue;
    spaced = spaced || spacingMatcher(code, files);
    const off = spacingValues(digest).filter(v => !spaced(v));
    if (off.length) errors.push(`[Figma] ${slug}: spacing Figma chưa có trong code của plan — ${off.slice(0, 6).map(v => `${v}dp`).join(', ')}. Padding/gap đúng số digest (token nếu trùng giá trị, không làm tròn).`);
  }
  return errors;
}

function addedLines(code, base, rel) {
  const all = () => fs.readFileSync(path.join(code, rel), 'utf8').split('\n').map((text, i) => ({ n: i + 1, text }));
  if (!base) return all();
  const run = args => execFileSync('git', ['-C', code, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  let diff;
  try {
    run(['cat-file', '-e', `${base}:${rel}`]);
  } catch {
    return all();
  }
  try {
    diff = run(['diff', '-U0', base, '--', rel]);
  } catch {
    return all();
  }
  const out = [];
  let n = 0;
  for (const line of diff.split('\n')) {
    const hunk = /^@@ -\S+ \+(\d+)/.exec(line);
    if (hunk) n = Number(hunk[1]);
    else if (line.startsWith('+') && !line.startsWith('+++')) out.push({ n: n++, text: line.slice(1) });
  }
  return out;
}

function drawableRoots(code) {
  const roots = new Map();
  for (const dir of resSubDirs(code, /^drawable/)) {
    for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.xml'))) {
      const m = /^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<\s*([\w-]+)/.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (m && !roots.has(f.slice(0, -4))) roots.set(f.slice(0, -4), m[1]);
    }
  }
  return roots;
}

function codeErrors(code, base, files) {
  const kt = planKt(code, files).filter(f => !isTokenFile(f));
  if (!kt.length) return [];
  const errors = [];
  let tokens = null;
  let drawables = null;
  for (const f of kt) {
    for (const { n, text } of addedLines(code, base, f)) {
      const where = `${f}:${n}`;
      if (/\bColor\(\s*0x/.test(text)) errors.push(`[token] ${where}: màu hardcode Color(0x…) — dùng token màu của app.`);
      if (/fontSize\s*=\s*\d+(\.\d+)?\.sp/.test(text)) errors.push(`[token] ${where}: fontSize hardcode — dùng kiểu chữ của app.`);
      for (const m of text.matchAll(DP)) {
        tokens = tokens || readTokens(code);
        const token = tokenForLiteral(tokens, Number(m[1]), text);
        if (token) errors.push(`[token] ${where}: ${m[1]}.dp trùng token ${token} — dùng token.`);
      }
      for (const m of text.matchAll(/painterResource\(\s*(?:id\s*=\s*)?R\.drawable\.(\w+)/g)) {
        drawables = drawables || drawableRoots(code);
        if (NON_VECTOR.has(drawables.get(m[1]))) errors.push(`[painterResource] ${where}: R.drawable.${m[1]} là <${drawables.get(m[1])}> — crash lúc chạy; dùng <vector> hoặc ảnh raster.`);
      }
    }
  }
  return errors;
}

function uiPrecheck({ root, code, base, screens, files }) {
  return [...digestErrors(root, code, screens || [], files || []), ...codeErrors(code, base, files || [])];
}

module.exports = { uiPrecheck, stringIndex, addedLines };
