const crypto = require('node:crypto');
const path = require('node:path');
const { createClient, parse } = require('../bugs/jira-client.cjs');
const { recordWould } = require('../bugs/effects.cjs');
const { fixVersionNames } = require('../bugs/fix-versions.cjs');
const { quote, oneLine } = require('../bugs/comment-text.cjs');
const { KEY_RE } = require('../bugs/store.cjs');

const TOOLS = 'jira_search,jira_create_issue';
const MAX_TICKETS = 20;
const SAFE_NAME = /^[^"\\\r\n]+$/;

const labelOf = (project, version, id) => `dz-e2e-${crypto.createHash('sha256').update(`${project}\n${version}\n${id}`).digest('hex').slice(0, 16)}`;

function textOf(version, build, failure) {
  return [
    `[Claude] E2E bản ${version} lỗi ở test case ${oneLine(failure.id, 80)}.`,
    `Bản cài: ${oneLine(build.versionName ?? 'không rõ', 60)}, commit ${build.sha.slice(0, 12)}, sha256 ${build.sha256.slice(0, 12)}`,
    ...(failure.expect ? ['Mong đợi:', quote(failure.expect)] : []),
    ...(failure.reason ? ['Thực tế:', quote(failure.reason)] : []),
  ].join('\n');
}

function createTicketClient({ configFile, connect, timeoutMs }) {
  const client = createClient({ configFile, live: true, connect, timeoutMs, tools: TOOLS });
  const search = async jql => {
    const page = parse(await client.call('jira_search', { jql, fields: 'summary,status', limit: 1, start_at: 0 }));
    return page?.issues?.[0]?.key ?? null;
  };
  async function create({ project, summary, description, label, priority, fixVersions, openJql }) {
    const known = await search(openJql);
    if (known) return { key: known, created: false };
    const extra = { priority: { name: priority }, labels: ['dz-e2e', label], ...(fixVersions.length && { fixVersions: fixVersions.map(name => ({ name })) }) };
    try {
      const made = parse(await client.call('jira_create_issue', { project_key: project, summary, issue_type: 'Bug', description, additional_fields: JSON.stringify(extra) }, { write: true }));
      const key = made?.issue?.key ?? made?.key;
      if (!KEY_RE.test(key ?? '')) throw client.fail('Jira không trả về mã ticket vừa tạo', { uncertain: true });
      return { key, created: true };
    } catch (error) {
      const landed = error.uncertain ? await search(openJql) : null;
      if (!landed) throw error;
      return { key: landed, created: true };
    }
  }
  return { create, close: client.close };
}

async function fileTickets(ctx, project, version, build, failures, now) {
  const list = failures.slice(0, MAX_TICKETS);
  if (project.live !== true) {
    for (const failure of list) recordWould(ctx, project)('would', `jira create Bug ${version} ${failure.id}`);
    return [];
  }
  const closed = [...project.jiraStatus.done];
  if (!closed.every(name => SAFE_NAME.test(name))) throw new Error('tên trạng thái không hợp lệ');
  const jira = await ctx.bugs.jira(project);
  const names = await fixVersionNames(ctx, project, jira, version, now);
  const fixVersions = names.includes(version) ? [version] : names.slice(0, 1);
  const make = ctx.e2e?.ticketClient ?? (() => createTicketClient({ configFile: path.join(ctx.secretsDir, 'jira-mcp.json') }));
  const client = make(project);
  const keys = [];
  try {
    for (const failure of list) {
      const label = labelOf(project.key, version, failure.id);
      const openJql = `project = ${project.key} AND labels = "${label}" AND status not in (${closed.map(name => `"${name}"`).join(', ')})`;
      const summary = `E2E ${version}: ${oneLine(failure.id, 80)} ${oneLine(failure.reason ?? '', 120)}`.trim();
      const { key } = await client.create({ project: project.key, summary, description: textOf(version, build, failure), label, priority: 'High', fixVersions, openJql });
      keys.push(key);
    }
  } finally {
    await client.close();
  }
  return keys;
}

module.exports = { fileTickets, createTicketClient, labelOf, TOOLS };
