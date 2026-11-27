const { hedged } = require('./approve-text.cjs');
const { WebError, invalid, closed, stale } = require('./web-error.cjs');
const { firstLine } = require('../redact.cjs');

const BY = 'po';
const MAX_QUOTE = 500;
const MAX_FEEDBACK = 8000;

const isOpen = review => !review.approved && (Boolean(review.trial) || [undefined, 'review'].includes(review.spec?.state));

async function openReview({ facade, specId, body }) {
  if (typeof body.sha !== 'string' || !body.sha) throw invalid('Thiếu phiên bản của nội dung.');
  const review = await facade.review(specId);
  if (!isOpen(review)) throw closed();
  if (body.sha !== review.sha) throw stale();
}

function readText(value, max, name) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > max) throw invalid(`${name} cần có nội dung và dài tối đa ${max} ký tự.`);
  return text;
}

async function approve(input) {
  const quote = readText(input.body.quote, MAX_QUOTE, 'Lời duyệt');
  if (hedged(quote)) throw new WebError(400, 'HEDGED', 'Lời duyệt có điều kiện (“nhưng”, “trừ”). Hãy ghi phần cần đổi vào ô góp ý để được sửa trước khi duyệt.');
  await openReview(input);
  const result = await input.facade.approve(input.specId, { sha: input.body.sha, quote }, BY, input.now);
  if (!result?.ok) throw new WebError(409, 'STALE', result?.error ? firstLine(result.error) : undefined);
  return {};
}

async function feedback(input) {
  const text = readText(input.body.text, MAX_FEEDBACK, 'Góp ý');
  await openReview(input);
  const result = await input.facade.feedback(input.specId, { text }, BY, input.now);
  if (result?.ok === false) throw result.error ? new WebError(409, 'STATE', firstLine(result.error)) : closed();
  return {};
}

module.exports = { approve, feedback, isOpen, MAX_QUOTE, MAX_FEEDBACK };
