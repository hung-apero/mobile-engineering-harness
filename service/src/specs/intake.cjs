const fs = require('node:fs');
const path = require('node:path');
const { parseRef } = require('./confluence.cjs');

const MAX_FILE = 1024 * 1024;
const FILE_TYPES = new Set(['.md', '.markdown', '.txt']);
const FIGMA_URL = /https?:\/\/(?:www\.)?figma\.com\/[^\s)\]|>"']+/i;
const FIGMA_KEY = /^https?:\/\/(?:www\.)?figma\.com\/(?:design|file|proto|board)\/([A-Za-z0-9]+)/i;
const APP_CODE = /^\s*\[?([A-Z][A-Z0-9]*\d+)\b/;

class IntakeError extends Error {
  constructor(message, code = 'INVALID') {
    super(message);
    this.name = 'IntakeError';
    this.code = code;
  }
}

const label = text => text.replace(/[*_`]/g, '').trim().toLowerCase();
const rowOf = line => line.match(/^\|\s*([^|]+?)\s*\|(.*?)\|?\s*$/);
const headingOf = markdown => markdown.match(/^#{1,3}\s+(.+)$/m)?.[1].trim();

function figmaKeyOf(url) {
  return String(url ?? '').match(FIGMA_KEY)?.[1] ?? null;
}

function readGeneralInfo(markdown, title) {
  const text = String(markdown ?? '');
  const figma = text.split('\n').map(rowOf).filter(Boolean)
    .filter(([, name]) => /^link (design|figma)\b/.test(label(name)))
    .map(([, , value]) => value.match(FIGMA_URL)?.[0])
    .find(Boolean);
  const name = String(title ?? '').trim() || headingOf(text);
  const app = name?.match(APP_CODE)?.[1];
  const missing = [];
  if (!app) missing.push('app');
  if (!figma) missing.push('figma');
  return { ...(app && { app }), ...(figma && { figma }), ...(name && { title: name }), missing };
}

function readFile(ref) {
  const file = String(ref ?? '');
  if (!path.isAbsolute(file) || !FILE_TYPES.has(path.extname(file).toLowerCase())) throw new IntakeError('File spec phải là đường dẫn tuyệt đối .md hoặc .txt');
  const info = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!info?.isFile()) throw new IntakeError('File spec không tồn tại hoặc không phải file thường', 'NOT_FOUND');
  if (info.size > MAX_FILE) throw new IntakeError('File spec quá lớn', 'TOO_LARGE');
  return fs.readFileSync(file, 'utf8');
}

async function loadSource(source, { confluence } = {}) {
  const type = source?.type;
  if (type === 'url') {
    const { id } = parseRef(source.ref);
    const page = await confluence.page(id);
    return { title: page.title, markdown: page.markdown, source: { type, ref: source.ref } };
  }
  if (type === 'path') {
    const markdown = readFile(source.ref);
    return { title: headingOf(markdown) ?? path.basename(source.ref), markdown, source: { type, ref: source.ref } };
  }
  if (type === 'pasted') {
    const markdown = String(source.text ?? '');
    if (!markdown.trim()) throw new IntakeError('Spec dán vào đang trống');
    if (markdown.length > MAX_FILE) throw new IntakeError('Spec dán quá lớn', 'TOO_LARGE');
    return { title: headingOf(markdown) ?? 'Spec dán tay', markdown, source: { type, ref: '' } };
  }
  throw new IntakeError('Nguồn spec phải là url, path hoặc pasted');
}

module.exports = { readGeneralInfo, loadSource, figmaKeyOf, IntakeError };
