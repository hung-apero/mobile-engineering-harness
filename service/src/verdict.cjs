const { redact } = require('./redact.cjs');

const TEXT_MAX = 4000;
const RAW_MAX = 16000;
const COMMAND_MAX = 80;
const REASON_MAX = 2000;

const OFFLINE = /Can't reach the API server|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT/;
const offline = result => Boolean(result) && (result.api_error === 'connection_failed' || (result.is_error === true && OFFLINE.test(String(result.result ?? ''))));
const succeeded = result => Boolean(result && result.is_error === false && result.subtype === 'success');
const leftWork = ({ result, tasks, turnOpen }) => tasks?.length > 0 || result.subagent_stats?.killed?.system > 0 || turnOpen;

const safeText = text => redact(text.slice(0, RAW_MAX)).slice(0, TEXT_MAX);

function textOf(result) {
  if (typeof result?.result === 'string') return safeText(result.result);
  if (Array.isArray(result?.errors)) return safeText(result.errors.map(String).join('\n'));
  return '';
}

function resultOf({ result, denials }) {
  return { text: textOf(result), costUsd: result?.total_cost_usd ?? null, turns: result?.num_turns ?? null, denials: denials.map(safeDenial) };
}

function safeDenial(denial) {
  const safe = { tool_name: typeof denial?.tool_name === 'string' ? redact(denial.tool_name) : '?' };
  if (safe.tool_name !== 'Bash') return safe;
  const word = String(denial.tool_input?.command ?? '').trim().match(/^[\w./+-]+/);
  return word ? { ...safe, command: redact(word[0]).slice(0, COMMAND_MAX) } : safe;
}

function describeDenial({ tool_name, command }) {
  return command ? `${tool_name}(${command})` : tool_name;
}

function denialReason(denials) {
  const list = [...new Set(denials.map(describeDenial))].join('; ');
  return `X03: lệnh bị chặn: ${list}`.slice(0, REASON_MAX);
}

function errorOf(result, ok) {
  if (ok) return 'interrupted';
  if (!result) return 'no_result';
  return result.subtype && result.subtype !== 'success' ? result.subtype : 'error';
}

function judgeDead(summary, { command = false } = {}) {
  const { result, quota } = summary;
  const ok = succeeded(result);
  if (ok && !leftWork(summary)) return { type: 'done', code: null, result: resultOf(summary) };
  if (command && result && !ok) return { type: 'failed', code: null, result: { error: 'step_failed', ...resultOf(summary) } };
  if (quota?.status === 'rejected') return { type: 'quota', code: 'X01', quota };
  if (offline(result)) return { type: 'offline', code: 'X04' };
  const blocked = !ok && Array.isArray(result?.permission_denials) ? result.permission_denials.map(safeDenial) : [];
  if (blocked.length) return { type: 'park', code: 'X03', reason: denialReason(blocked), denials: blocked };
  const error = errorOf(result, ok);
  return { type: 'resume', code: 'X02', result: { error, ...resultOf(summary) } };
}

function canResume(summary, job) {
  return !summary.missingSession && (summary.answered || job.resume);
}

function silentSince(job, wakeAt = 0) {
  return Math.max(job.lastEventAt ?? job.startedAt, wakeAt);
}

function isSilent(job, rules, now, wakeAt) {
  return now - silentSince(job, wakeAt) >= rules.X02.silent_minutes * 60000;
}

function mergeSummary(a, b) {
  return {
    result: b.result ?? a.result,
    results: a.results + b.results,
    quota: b.quota ?? a.quota,
    denials: [...a.denials, ...b.denials],
    tasks: b.tasks ?? a.tasks,
    answered: a.answered || b.answered,
    turnOpen: b.results ? b.turnOpen : a.turnOpen || b.turnOpen,
    missingSession: a.missingSession || b.missingSession,
  };
}

function stricter(a, b) {
  const rejected = q => Number(q.status === 'rejected');
  return rejected(a) - rejected(b) || (a.utilization ?? -1) - (b.utilization ?? -1);
}

function newestQuota(seen) {
  const ranked = [...seen].sort((a, b) => b.at - a.at || stricter(b.quota, a.quota));
  return ranked.length ? ranked[0].quota : null;
}

module.exports = { judgeDead, canResume, silentSince, isSilent, mergeSummary, newestQuota };
