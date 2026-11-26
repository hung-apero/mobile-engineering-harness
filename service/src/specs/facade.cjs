const store = require('./store.cjs');
const quiz = require('./facade-quiz.cjs');
const { createReview } = require('./facade-review.cjs');
const { overview } = require('./overview.cjs');
const { parseRef } = require('./confluence.cjs');
const { NO_FIGMA, FIGMA } = require('./phase-read.cjs');
const { loadProjects } = require('../projects.cjs');
const { notFound, invalid } = require('./facade-error.cjs');
const { firstLine } = require('../redact.cjs');

const MAX_PASTED = 1024 * 1024;
const MAX_TITLE = 200;

function cleanSource(source) {
  if (source?.type === 'pasted') {
    const text = typeof source.text === 'string' ? source.text.trim() : '';
    if (!text || text.length > MAX_PASTED) throw invalid('Nội dung spec đang trống hoặc quá dài.');
    return { type: 'pasted', text };
  }
  const ref = String(source?.ref ?? '').trim();
  if (source?.type === 'path') return { type: 'path', ref };
  if (source?.type !== 'url') throw invalid('Nguồn spec phải là link, file hoặc nội dung dán.');
  try {
    parseRef(ref);
  } catch (error) {
    throw invalid(firstLine(error));
  }
  return { type: 'url', ref };
}

function cleanFigma(figma) {
  if (figma === null || figma === undefined || figma === '') return null;
  if (figma !== NO_FIGMA && (typeof figma !== 'string' || !FIGMA.test(figma))) throw invalid('Link Figma phải có dạng https://www.figma.com/design/…');
  return figma;
}

function createFacade(ctx) {
  const reviews = createReview(ctx);

  function specOf(id) {
    const spec = store.getSpec(ctx.db, id);
    if (!spec) throw notFound();
    return spec;
  }

  function projectOf(key) {
    const project = loadProjects(ctx.projectsDir, { dzHome: ctx.dzHome }).projects.get(key);
    if (!project) throw invalid('Không có dự án này hoặc cấu hình đang lỗi.');
    return project;
  }

  const withProject = (id, work) => {
    const spec = specOf(id);
    return work(projectOf(spec.project), spec);
  };

  return {
    overview: now => overview(ctx, now),
    openSpecs: (project, state) => store.listSpecs(ctx.db, { project, states: [state] }).map(({ id, title, updatedAt }) => ({ id, project, title, state, updatedAt })),
    newSpec({ project, source, figma, title }, now) {
      projectOf(project);
      const name = String(title ?? '').trim();
      if (name.length > MAX_TITLE) throw invalid(`Tên spec dài tối đa ${MAX_TITLE} ký tự.`);
      return store.createSpec(ctx.db, { project, title: name, source: cleanSource(source), figma: cleanFigma(figma) }, now);
    },
    quiz: id => quiz.quiz(ctx, specOf(id)),
    saveDraft: (id, input, by, now) => quiz.saveDraft(ctx, specOf(id), input, by, now),
    changeAuto: (id, qid, choice, by, now) => quiz.changeAuto(ctx, specOf(id), { ...choice, qid }, by, now),
    submit: (id, by, now) => withProject(id, (project, spec) => quiz.submit(ctx, project, spec, by, now)),
    ask: (id, qid, text, by, now) => quiz.ask(ctx, specOf(id), qid, text, by, now),
    review: id => reviews.review(specOf(id)),
    approve: async (id, input, by, now) => withProject(id, (project, spec) => reviews.approve(project, spec, input, by, now)),
    feedback: (id, input, by, now) => withProject(id, (project, spec) => reviews.feedback(project, spec, input, by, now)),
  };
}

module.exports = { createFacade, cleanFigma };
