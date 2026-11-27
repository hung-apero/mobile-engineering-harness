const { parseResult, VERDICTS, STATUSES } = require('./result-tickets.cjs');
const { parseReview, REVIEW_SCHEMA } = require('./result-review.cjs');
const { lastResultText } = require('./result-log.cjs');

module.exports = { parseResult, parseReview, lastResultText, VERDICTS, STATUSES, REVIEW_SCHEMA };
