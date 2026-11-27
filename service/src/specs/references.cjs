const path = require('node:path');
const files = require('./repo-files.cjs');
const { parseRef } = require('./confluence.cjs');
const { firstLine } = require('../redact.cjs');

const MAX_LINKED = 10;
const URLS = /https?:\/\/[^\s<>"')\]|]+/gi;

const hostOf = ref => {
  try {
    return new URL(ref).host;
  } catch {
    return null;
  }
};
const keyOf = ref => {
  const parsed = parseRef(ref);
  return parsed.id ?? `${parsed.space}/${parsed.title}`;
};

function linksIn(markdown, hosts, skip) {
  const seen = new Set(skip);
  const out = [];
  for (const raw of String(markdown).match(URLS) ?? []) {
    const url = raw.replace(/[.,;:!?]+$/, '');
    if (!hosts.has(hostOf(url))) continue;
    let key;
    try {
      key = keyOf(url);
    } catch {
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(url);
  }
  return out.slice(0, MAX_LINKED);
}

async function gatherReferences({ confluence, knowledge = [], sourceRef = null, markdown = '' }) {
  const hosts = new Set([sourceRef, ...knowledge].map(hostOf).filter(Boolean));
  const skip = [sourceRef, ...knowledge].filter(Boolean).flatMap(ref => {
    try {
      return [keyOf(ref)];
    } catch {
      return [];
    }
  });
  const wanted = [...knowledge.map(ref => ({ kind: 'kb', ref })), ...linksIn(markdown, hosts, skip).map(ref => ({ kind: 'linked', ref }))];
  const pages = [];
  const missing = [];
  for (const { kind, ref } of wanted) {
    try {
      const page = await confluence.page(ref);
      pages.push({ kind, ref, id: String(page.id), title: page.title, markdown: page.markdown });
    } catch (error) {
      missing.push({ kind, ref, reason: firstLine(error) });
    }
  }
  return { pages, missing };
}

function writeReferences(repo, { pages }) {
  return pages.map(({ kind, ref, id, title, markdown }) => {
    const file = path.posix.join('inputs', kind, `${id.replace(/[^\w-]/g, '_')}.md`);
    files.write(repo, file, `# ${title}\n\nNguồn: ${ref}\n\n${markdown}\n`);
    return { kind, file, title };
  });
}

module.exports = { gatherReferences, writeReferences };
