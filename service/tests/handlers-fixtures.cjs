const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SHA = '1'.repeat(40);
const LANE_SHA = '2'.repeat(40);
const JIRA = { READ_ONLY_MODE: 'true', ENABLED_TOOLS: 'jira_get_issue,jira_search,jira_get_transitions,jira_download_attachments', JIRA_API_TOKEN: 'bí-mật-jira' };
const jiraDoc = (env = {}, extra = {}) => ({ mcpServers: { jira: { type: 'stdio', command: 'uvx', args: ['mcp-atlassian'], env: { ...JIRA, ...env }, ...extra } } });

function writeJira(dzHome, doc, mode = 0o600) {
  const file = path.join(dzHome, 'secrets', 'jira-read.json');
  fs.rmSync(file, { force: true });
  fs.writeFileSync(file, typeof doc === 'string' ? doc : JSON.stringify(doc), { mode });
  fs.chmodSync(file, mode);
  return file;
}

function setup(t) {
  const dzHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dz-handlers-')));
  t.after(() => fs.rmSync(dzHome, { recursive: true, force: true }));
  const repo = path.join(dzHome, 'workspaces', 'AAP864', 'batches', '7', 'repo');
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(path.join(dzHome, 'secrets'));
  writeJira(dzHome, jiraDoc());
  const project = {
    key: 'AAP864',
    base: 'develop',
    live: false,
    localFiles: ['local.properties'],
    commands: { compile: ['./gradlew', 'compileX'], unitTest: ['./gradlew', 'testX'], assemble: ['./gradlew', 'assembleX'], apkGlob: 'app/build/outputs/apk/dev/*.apk' },
  };
  return { dzHome, repo, project };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

module.exports = { SHA, LANE_SHA, setup, writeJira, jiraDoc, same };
