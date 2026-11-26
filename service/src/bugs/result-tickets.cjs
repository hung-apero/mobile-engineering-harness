const { LANE, SHA } = require('./git.cjs');
const { fail, requireObject, requireList, oneOf, textOf, optional, matching, lastJsonBlock, attempt } = require('./result-fields.cjs');

const VERDICTS = ['confirmed', 'needs-confirm', 'spec-gap', 'conflict', 'needs-info', 'not-a-bug', 'duplicate', 'already-fixed', 'external', 'out-of-scope'];
const STATUSES = ['approved', 'failed', 'blocked', 'skipped', 'needs-device'];
const TEXTS = ['rootCause', 'specRef', 'question', 'needs'];
const FIELDS = ['key', 'verdict', 'status', 'branch', 'commit', ...TEXTS];

function readTicket(value, { allowedKeys, suffix }) {
  requireObject(value, FIELDS, 'ticket');
  const key = oneOf(value.key, allowedKeys, 'key');
  const ticket = {
    key,
    verdict: oneOf(value.verdict, VERDICTS, `${key}: verdict`),
    status: oneOf(value.status, STATUSES, `${key}: status`),
    branch: optional(value.branch, v => matching(v, LANE, `${key}: branch`)),
    commit: optional(value.commit, v => matching(v, SHA, `${key}: commit`)),
  };
  for (const name of TEXTS) ticket[name] = optional(value[name], v => textOf(v, `${key}: ${name}`));
  if (ticket.status === 'approved') checkApproved(ticket, suffix);
  return ticket;
}

function checkApproved({ key, verdict, branch, commit }, suffix) {
  if (verdict !== 'confirmed') fail(`${key}: approved phải có verdict confirmed`);
  if (!branch || !commit) fail(`${key}: approved phải có branch và commit`);
  if (suffix && !branch.endsWith(suffix)) fail(`${key}: branch phải kết thúc bằng mã đợt ${suffix}`);
}

function checkTogether(tickets) {
  const seen = new Set();
  const commits = new Map();
  for (const { key, status, branch, commit } of tickets) {
    if (seen.has(key)) fail(`${key}: trùng ticket`);
    seen.add(key);
    if (status !== 'approved') continue;
    if ((commits.get(branch) ?? commit) !== commit) fail(`${key}: branch ${branch} có hai commit khác nhau`);
    commits.set(branch, commit);
  }
  return seen;
}

function parseResult(text, { allowedKeys, batchId } = {}) {
  if (!Array.isArray(allowedKeys) || allowedKeys.length === 0) throw new TypeError('allowedKeys phải là danh sách không rỗng');
  const suffix = batchId === undefined || batchId === null ? null : `-${String(batchId).toLowerCase()}`;
  return attempt(() => {
    const doc = lastJsonBlock(text) ?? fail('không có khối JSON');
    requireObject(doc, ['tickets'], 'JSON');
    const tickets = requireList(doc.tickets, 'tickets').map(value => readTicket(value, { allowedKeys, suffix }));
    const seen = checkTogether(tickets);
    return { tickets, missing: allowedKeys.filter(key => !seen.has(key)) };
  });
}

module.exports = { parseResult, VERDICTS, STATUSES };
