const path = require('node:path');
const files = require('./repo-files.cjs');
const { loadSource, readGeneralInfo } = require('./intake.cjs');
const { hashText } = require('../text-hash.cjs');
const { figmaReadConfig } = require('./figma-config.cjs');
const { fresh } = require('./segment.cjs');
const { notesOf } = require('./refresh.cjs');
const { move, patch, park, needInput } = require('./kit.cjs');
const { firstLine } = require('../redact.cjs');

const MINUTE = 60 * 1000;
const BACKOFF_MINUTES = [3, 6, 12, 15];
const CONTENT_ERRORS = ['INVALID', 'NOT_FOUND', 'EMPTY', 'TOO_LARGE'];
const NO_FIGMA = 'none';
const FIGMA = /^https:\/\/(?:www\.)?figma\.com\/(?:design|file)\/[A-Za-z0-9]+/;

function start(run) {
  move(run, 'reading');
  return true;
}

function later(run, error) {
  const failures = (run.spec.data.readFailures ?? 0) + 1;
  if (failures > BACKOFF_MINUTES.length) {
    patch(run, { readFailures: 0, readAt: 0 });
    park(run, `không đọc được nguồn spec ${failures} lần: ${firstLine(error)}`);
    return true;
  }
  patch(run, { readFailures: failures, readAt: run.now + BACKOFF_MINUTES[failures - 1] * MINUTE });
  return false;
}

async function guarded(run, work) {
  try {
    return { value: await work() };
  } catch (error) {
    if (CONTENT_ERRORS.includes(error?.code)) needInput(run, { kind: 'source', role: 'po', reason: firstLine(error) });
    else if (error?.code === 'CHANGED') park(run, firstLine(error));
    else if (['OVERLAY', 'HARNESS'].includes(error?.code)) needInput(run, { kind: 'harness', role: 'dev', reason: firstLine(error) });
    else return { changed: later(run, error) };
    return { changed: true };
  }
}

function figmaOf(run, info) {
  const given = (run.spec.data.figma ?? run.spec.figma ?? info.figma)?.replace(/^http:/i, 'https:');
  if (given === NO_FIGMA) return { url: null };
  if (!given) return { reason: 'spec không có link Figma', role: 'po' };
  if (!FIGMA.test(given)) return { reason: 'link Figma không đúng dạng https://www.figma.com/design/…', role: 'po' };
  try {
    figmaReadConfig(run.ctx.dzHome);
  } catch (error) {
    return { reason: `chưa đọc được Figma: ${firstLine(error)}`, role: 'dev' };
  }
  return { url: given };
}

const cloneId = ({ id, data }) => ((data.run ?? 1) > 1 ? `${id}-r${data.run}` : String(id));

async function read(run) {
  const { spec, ctx } = run;
  if ((spec.data.readAt ?? 0) > run.now) return false;
  const loaded = await guarded(run, () => loadSource(spec.source, { confluence: spec.source.type === 'url' ? ctx.specs.confluence(run.project) : null }));
  if (!loaded.value) return loaded.changed;
  const { markdown, title, source } = loaded.value;
  const info = readGeneralInfo(markdown, title);
  const figma = figmaOf(run, info);
  if (figma.reason) {
    needInput(run, { kind: 'figma', role: figma.role, reason: figma.reason });
    return true;
  }
  const cloned = await guarded(run, () => ctx.specs.prepareClone({ dzHome: ctx.dzHome, project: run.project, specId: cloneId(spec), markdown, source, figma: figma.url }));
  if (!cloned.value) return cloned.changed;
  const { repo } = cloned.value;
  const previous = notesOf(spec);
  for (const [name, text] of Object.entries(previous.files)) files.write(repo, path.join('inputs', name), text);
  move(run, 'asking', {
    title: spec.title || info.title || title || '',
    data: { repo, app: info.app ?? run.project.key, figmaUrl: figma.url, rawSha: hashText(markdown), notes: previous.notes, readFailures: 0, readAt: 0, reviewFloor: 1, ...fresh(spec, 'ask') },
  });
  return true;
}

module.exports = { start, read, NO_FIGMA, FIGMA };
