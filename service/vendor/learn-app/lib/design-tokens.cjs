const fs = require('fs');
const path = require('path');

const SKIP = new Set(['build', '.gradle', '.git', '.idea', '.kotlin', '.learn-app', 'node_modules']);
const DP = /(-?\d+(?:\.\d+)?)\.dp\b/g;

function walkKt(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkKt(full, out);
    else if (e.name.endsWith('.kt')) out.push(full);
  }
  return out;
}

function isTokenFile(rel) {
  const p = rel.replace(/\\/g, '/');
  return (/\/(theme|designsystem)\//.test(p) || /\/App(Spacing|Type|Typography|Shapes|Colors|Elevation|Dimens)\w*\.kt$/.test(p))
    && !/(Preview|Test)\w*\.kt$/.test(p) && !/\/(test|androidTest)\//.test(p);
}

function classBlocks(text) {
  return [...text.matchAll(/(?:data\s+)?class\s+(\w+)\s*\(([\s\S]*?)\n\)/g)].map(m => {
    const access = [...text.slice(Math.max(0, m.index - 400), m.index).matchAll(/Access via `([^`]+)`/g)].pop();
    return { name: m[1], body: m[2], access: access ? access[1] : m[1] };
  });
}

function readTokens(codeRoot) {
  const tokens = { spacing: [], shapes: [], elevation: [] };
  for (const file of walkKt(codeRoot)) {
    if (!isTokenFile(path.relative(codeRoot, file))) continue;
    const text = fs.readFileSync(file, 'utf8');
    const blocks = classBlocks(text);
    for (const c of blocks) {
      if (/Spacing|Dimens/.test(c.name)) {
        for (const p of c.body.matchAll(/val\s+(\w+)\s*:\s*Dp\s*=\s*(-?\d+(?:\.\d+)?)\.dp/g)) tokens.spacing.push({ name: `${c.access}.${p[1]}`, value: Number(p[2]) });
      } else if (/Elevation/.test(c.name)) {
        for (const p of c.body.matchAll(/val\s+(\w+)\s*:\s*Dp\s*=\s*(-?\d+(?:\.\d+)?)\.dp/g)) tokens.elevation.push({ name: `${c.access}.${p[1]}`, value: Number(p[2]) });
      }
    }
    const shapes = blocks.find(c => /Shapes/.test(c.name));
    for (const s of text.matchAll(/(\w+)\s*=\s*RoundedCornerShape\(([^\n]*?)\)\s*,?\s*$/gm)) {
      tokens.shapes.push({ name: `${shapes ? shapes.access : 'shapes'}.${s[1]}`, values: [...s[2].matchAll(DP)].map(d => Number(d[1])) });
    }
  }
  return tokens;
}

function tokenForLiteral(tokens, value, line) {
  if (/RoundedCornerShape|\bshape\b|\bclip\b/.test(line)) {
    const t = tokens.shapes.find(s => s.values.includes(value));
    if (t) return t.name;
  }
  if (/[Ee]levation/.test(line)) {
    const t = tokens.elevation.find(e => e.value === value);
    if (t) return t.name;
  }
  if (/padding|Padding|spacedBy|Spacer|Arrangement|\boffset\b/.test(line)) {
    const t = tokens.spacing.find(s => s.value === value);
    if (t) return t.name;
  }
  return null;
}

module.exports = { SKIP, DP, isTokenFile, readTokens, tokenForLiteral };
