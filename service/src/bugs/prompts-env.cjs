const fs = require('node:fs');
const path = require('node:path');

const GIT_LOCATION = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_EXTERNAL_DIFF'];
const CREDENTIALS = [
  'SSH_AUTH_SOCK', 'SSH_ASKPASS', 'GIT_ASKPASS', 'GIT_SSH',
  'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN',
  'JIRA_API_TOKEN', 'JIRA_PERSONAL_TOKEN', 'CONFLUENCE_API_TOKEN', 'CONFLUENCE_PERSONAL_TOKEN', 'ATLASSIAN_OAUTH_ACCESS_TOKEN',
];
const FIREBASE = ['FIREBASE_TOKEN', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_APPLICATION_CREDENTIALS_JSON'];
const nulls = names => Object.fromEntries(names.map(name => [name, null]));
const NO_FIREBASE = nulls(FIREBASE);
const NO_PUSH = [['remote.origin.pushurl', '/dev/null/dz-no-push']];

function emptyGhDir(dzHome) {
  const dir = path.join(dzHome, 'empty-gh');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(dir).isDirectory()) throw new Error(`${dir} phải là thư mục thật`);
  if (fs.existsSync(path.join(dir, 'hosts.yml'))) throw new Error(`${dir} có thông tin đăng nhập gh`);
  return dir;
}

function gitConfig(pairs) {
  const env = { GIT_CONFIG_COUNT: String(pairs.length) };
  pairs.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
}

function isolatedEnv(dzHome, { keepFirebase = false, config = [] } = {}) {
  return {
    ...nulls([...GIT_LOCATION, ...CREDENTIALS]),
    ...(keepFirebase ? {} : NO_FIREBASE),
    GH_CONFIG_DIR: emptyGhDir(dzHome),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_SSH_COMMAND: '/usr/bin/false',
    ...gitConfig([['credential.helper', ''], ...config]),
  };
}

const IDENTITY = {
  GIT_AUTHOR_NAME: 'dev-zone',
  GIT_AUTHOR_EMAIL: 'dev-zone@localhost',
  GIT_COMMITTER_NAME: 'dev-zone',
  GIT_COMMITTER_EMAIL: 'dev-zone@localhost',
};

module.exports = { isolatedEnv, IDENTITY, NO_FIREBASE, NO_PUSH };
