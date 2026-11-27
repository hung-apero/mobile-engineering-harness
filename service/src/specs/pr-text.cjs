const files = require('./repo-files.cjs');
const { readResult } = require('./build-result.cjs');
const { trialNotes } = require('./trial-notes.cjs');
const { clip } = require('./build-kit.cjs');
const { redact } = require('../redact.cjs');

const MAX_BRIEF_LINES = 60;
const MAX_LINE = 300;

function briefLines(repo) {
  const text = files.read(repo, 'brief/requirements.md') ?? '';
  return text.replace(/\r\n?/g, '\n').split('\n').map(row => redact(row).slice(0, MAX_LINE).toWellFormed()).slice(0, MAX_BRIEF_LINES);
}

function prText(run) {
  const { repo } = run.spec.data;
  const result = readResult(repo);
  const notes = trialNotes(run.spec);
  const brief = briefLines(repo);
  const body = [
    ...(notes.length ? ['## Còn lệch hoặc chờ xác nhận', ...notes.map(note => `- ${note}`), ''] : []),
    '## Plan', ...(result?.plans.length ? result.plans.map(plan => `- ${plan}`) : ['- (không ghi)']), '',
    ...(brief.some(row => row.trim()) ? ['## Yêu cầu (brief)', ...brief, ''] : []),
    `dz-spec-${run.spec.id}`,
  ];
  return { title: `feat(${run.project.key}): ${clip(run.spec.title || 'tính năng', 100)}`, body: body.join('\n') };
}

module.exports = { prText };
