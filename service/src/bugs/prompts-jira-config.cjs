const fs = require('node:fs');
const path = require('node:path');

const TOOLS = ['jira_get_issue', 'jira_search', 'jira_get_transitions', 'jira_download_attachments'];
const OVERRIDES = /^--(?:no-)?(?:enabled-tools|read-only|toolsets|env-file)(?:=|$)/;

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const only = (value, name) => isPlainObject(value) && Object.keys(value).length === 1 && isPlainObject(value[name]);

function parse(file, bad) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return bad('không đọc được JSON');
  }
}

function jiraReadConfig(dzHome) {
  const file = path.join(dzHome, 'secrets', 'jira-read.json');
  const bad = reason => {
    throw new Error(`secrets/jira-read.json: ${reason}`);
  };
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) bad('không có file');
  if (!stat.isFile()) bad('phải là file thường, không phải symlink');
  if ((stat.mode & 0o777) !== 0o600) bad('quyền phải là 600');
  const doc = parse(file, bad);
  if (!only(doc, 'mcpServers') || !only(doc.mcpServers, 'jira')) bad('chỉ được có đúng một server jira');
  const { env, args = [] } = doc.mcpServers.jira;
  if (!isPlainObject(env) || env.READ_ONLY_MODE !== 'true') bad('READ_ONLY_MODE phải là "true"');
  const tools = typeof env.ENABLED_TOOLS === 'string' ? env.ENABLED_TOOLS.split(',') : [];
  if (tools.length !== TOOLS.length || !TOOLS.every(name => tools.includes(name))) bad(`ENABLED_TOOLS phải đúng là ${TOOLS.join(',')}`);
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string' || OVERRIDES.test(arg))) bad('args không được đổi chế độ đọc hay danh sách tool');
  return file;
}

const JIRA_TOOLS = TOOLS.map(name => `mcp__jira__${name}`);

module.exports = { jiraReadConfig, JIRA_TOOLS };
