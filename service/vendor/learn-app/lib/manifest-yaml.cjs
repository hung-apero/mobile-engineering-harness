const PLAIN = /^[^\s'"[\]{},:#&*!|>%@`-][^:#,[\]{}]*$/;

function splitTop(text, sep) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '[' || c === '{') depth += 1;
    else if (c === ']' || c === '}') depth -= 1;
    else if (c === sep && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map(p => p.trim()).filter(p => p !== '');
}

function keyValue(text) {
  const match = text.match(/^("[^"]*"|'[^']*'|[^:]+?):(?:\s+(.*))?$/);
  return match ? [scalar(match[1]), match[2] === undefined ? '' : match[2].trim()] : null;
}

function scalar(text) {
  const value = text.trim();
  if (/^"(.*)"$/.test(value)) return value.slice(1, -1).replace(/\\"/g, '"');
  if (/^'(.*)'$/.test(value)) return value.slice(1, -1).replace(/''/g, "'");
  return value;
}

function inline(text) {
  const value = text.trim();
  if (value.startsWith('[') && value.endsWith(']')) return splitTop(value.slice(1, -1), ',').map(inline);
  if (value.startsWith('{') && value.endsWith('}')) {
    return Object.fromEntries(splitTop(value.slice(1, -1), ',').map(part => {
      const [key, rest] = keyValue(part);
      return [key, inline(rest)];
    }));
  }
  return scalar(value);
}

function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

function tokenize(text) {
  return text.replace(/\r/g, '').split('\n').map(stripComment).filter(l => l.trim())
    .map(l => ({ indent: l.length - l.trimStart().length, text: l.trim() }));
}

function parseBlock(lines, at, indent) {
  if (at >= lines.length || lines[at].indent < indent) return [null, at];
  if (lines[at].text.startsWith('- ') || lines[at].text === '-') {
    const list = [];
    while (at < lines.length && lines[at].indent === indent && (lines[at].text.startsWith('- ') || lines[at].text === '-')) {
      const rest = lines[at].text.slice(1).trim();
      const pair = rest && !/^[[{"']/.test(rest) ? keyValue(rest) : null;
      if (pair) {
        const inner = [{ indent: indent + 2, text: rest }, ...lines.slice(at + 1)];
        const [value, next] = parseBlock(inner, 0, indent + 2);
        list.push(value);
        at += next;
      } else {
        list.push(rest ? inline(rest) : null);
        at += 1;
      }
    }
    return [list, at];
  }
  const map = {};
  while (at < lines.length && lines[at].indent === indent) {
    const pair = keyValue(lines[at].text);
    if (!pair) throw new Error(`YAML không đọc được: ${lines[at].text}`);
    const [key, rest] = pair;
    at += 1;
    if (rest !== '') map[key] = inline(rest);
    else if (at < lines.length && lines[at].indent > indent) [map[key], at] = parseBlock(lines, at, lines[at].indent);
    else if (at < lines.length && lines[at].indent === indent && lines[at].text.startsWith('- ')) [map[key], at] = parseBlock(lines, at, indent);
    else map[key] = '';
  }
  return [map, at];
}

function parseYaml(text) {
  const lines = tokenize(text);
  if (!lines.length) return {};
  const [value, next] = parseBlock(lines, 0, lines[0].indent);
  if (next < lines.length) throw new Error(`YAML không đọc được từ dòng "${lines[next].text}" (khối nhiều dòng |, thụt lề lệch — viết lại theo app-manifest-schema.md)`);
  return value;
}

function quote(value) {
  const text = String(value);
  return PLAIN.test(text) && text.trim() === text ? text : `"${text.replace(/"/g, '\\"')}"`;
}

function flow(value) {
  if (Array.isArray(value)) return `[${value.map(flow).join(', ')}]`;
  if (value && typeof value === 'object') return `{ ${Object.entries(value).map(([k, v]) => `${quote(k)}: ${flow(v)}`).join(', ')} }`;
  return quote(value === null || value === undefined ? '' : value);
}

function block(value, indent) {
  const pad = ' '.repeat(indent);
  return Object.entries(value).map(([key, v]) => {
    if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length) return `${pad}${quote(key)}:\n${block(v, indent + 2)}`;
    if (Array.isArray(v) && v.some(item => item && typeof item === 'object')) return `${pad}${quote(key)}:\n${v.map(item => `${pad}  - ${flow(item)}`).join('\n')}`;
    return `${pad}${quote(key)}: ${flow(v)}`;
  }).join('\n');
}

function stringifyYaml(value) {
  return `${block(value, 0)}\n`;
}

module.exports = { parseYaml, stringifyYaml };
