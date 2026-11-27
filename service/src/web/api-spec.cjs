const { invalid } = require('./web-error.cjs');
const { list } = require('./quiz-model.cjs');

const MAX_TITLE = 200;
const FIGMA = /^https:\/\/(?:www\.)?figma\.com\/\S{1,500}$/i;
const LINK = /^https?:\/\/\S{1,2000}$/i;
const PAGE_ID = /^\d{1,15}$/;

const text = value => (typeof value === 'string' ? value.trim() : '');

function readSource(value) {
  const raw = text(value);
  if (!raw) throw invalid('Hãy dán link hoặc nội dung spec.');
  return PAGE_ID.test(raw) || LINK.test(raw) ? { type: 'url', ref: raw } : { type: 'pasted', text: raw };
}

async function create({ facade, body, now }) {
  const project = text(body.project);
  const projects = list((await facade.overview(now))?.projects);
  if (!projects.some(item => item.key === project)) throw invalid('Hãy chọn một dự án trong danh sách.');
  const source = readSource(body.source);
  const figma = text(body.figma);
  if (figma && !FIGMA.test(figma)) throw invalid('Link Figma phải bắt đầu bằng https://www.figma.com/.');
  const title = text(body.title);
  if (title.length > MAX_TITLE) throw invalid(`Tên spec dài tối đa ${MAX_TITLE} ký tự.`);
  const spec = await facade.newSpec({ project, source, figma: figma || null, title: title || null }, now);
  return { id: spec?.id ?? null };
}

module.exports = { create };
