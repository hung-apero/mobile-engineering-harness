const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createJira } = require('../src/bugs/jira.cjs');

const server = path.join(__dirname, 'fixtures', 'fake-jira-server.cjs');
function config(mode, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dz-jcfg-'));
  const file = path.join(dir, 'jira-mcp.json');
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { jira: { command: process.execPath, args: [server], env } } }), { mode });
  fs.chmodSync(file, mode);
  return file;
}

test('default connect starts the stdio server from the config and overrides ENABLED_TOOLS and READ_ONLY_MODE', async () => {
  for (const live of [false, true]) {
    const jira = createJira({ configFile: config(0o600, { ENABLED_TOOLS: 'jira_delete_issue', READ_ONLY_MODE: 'false', EXTRA: 'kept' }), live, record() {} });
    const echoed = await jira.rawCall('jira_env', {});
    await jira.close();
    assert.ok(!echoed.ENABLED_TOOLS.includes('jira_delete_issue'));
    assert.equal(echoed.ENABLED_TOOLS, 'jira_get_issue,jira_search,jira_get_transitions,jira_transition_issue,jira_add_comment,jira_update_issue,jira_download_attachments');
    assert.equal(echoed.READ_ONLY_MODE, live ? 'false' : 'true');
    assert.equal(echoed.EXTRA, 'kept');
  }
});

test('config file must be mode 600 and not a symlink', async () => {
  const loose = createJira({ configFile: config(0o644), live: false, record() {} });
  await assert.rejects(() => loose.rawCall('jira_env', {}), /600/);
  const real = config(0o600);
  const link = path.join(path.dirname(real), 'link.json');
  fs.symlinkSync(real, link);
  await assert.rejects(() => createJira({ configFile: link, live: false, record() {} }).rawCall('jira_env', {}), /symlink/);
});
