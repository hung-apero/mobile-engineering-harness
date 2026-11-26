const { DeskError } = require('./desk-error.cjs');
const { parseRef } = require('../specs/confluence.cjs');

const URLS = /https?:\/\/[^\s<>"')\]|]+/gi;
const FIGMA = /^https:\/\/(?:www\.)?figma\.com\//i;
const FIGMA_FILE = /^https:\/\/(?:www\.)?figma\.com\/(?:design|file|proto|board)\/[A-Za-z0-9]+/i;

const invalid = message => new DeskError('INVALID', message);
const unique = list => [...new Set(list)];

function splitUrls(text) {
  const urls = unique((text.match(URLS) ?? []).map(url => url.replace(/[.,;:!?]+$/, '')));
  return { urls, words: text.replace(URLS, ' ') };
}

function readSpec(text) {
  const { urls } = splitUrls(text);
  const figma = urls.filter(url => FIGMA.test(url));
  const sources = urls.filter(url => !FIGMA.test(url));
  if (sources.length === 0) throw invalid('Tin chưa có link spec. Hãy gửi một tin có link Confluence của spec.');
  if (sources.length > 1) throw invalid('Tin có nhiều link spec. Hãy gửi mỗi spec một tin.');
  if (figma.length > 1) throw invalid('Tin có nhiều link Figma. Hãy để lại một link.');
  if (figma.length === 1 && !FIGMA_FILE.test(figma[0])) throw invalid('Link Figma không đúng dạng.');
  try {
    parseRef(sources[0]);
  } catch {
    throw invalid('Link spec không có mã trang Confluence. Hãy gửi link dạng .../pages/<số>/...');
  }
  return { source: { type: 'url', ref: sources[0] }, figma: figma[0] ?? null };
}

module.exports = { readSpec, splitUrls };
