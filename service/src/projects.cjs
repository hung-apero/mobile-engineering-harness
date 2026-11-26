const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { fail, isPlainObject, isString, requireString, requireStrings, optionalPaths, buildLocalFiles, buildCommands, buildHarnessCommit, requireDiscordId, buildChannel, buildE2eDevices, buildRoles, COMMAND_FIELDS } = require('./project-fields.cjs');

const KEY = /^[A-Z][A-Z0-9]+$/;
const REPO = /^[\w.-]+\/[\w.-]+$/;

const TOP_FIELDS = ['key', 'repo', 'base', 'checkout', 'flavor', 'package', 'jiraStatus', 'people', 'specUrl', 'figmaUrl', 'excludedDevices', 'enabled', 'live', 'localFiles', 'commands', 'harnessCommit', 'forbidden', 'channel', 'roles', 'e2eDevices'];
const JIRA_FIELDS = ['waiting', 'inProgress', 'resolved', 'reopened', 'done'];
const PEOPLE_REQUIRED = ['po', 'qa', 'devOnCall'];
const PEOPLE_FIELDS = [...PEOPLE_REQUIRED, 'poBackup'];

function checkKnown(source, allowed, prefix) {
  for (const name of Object.keys(source)) {
    if (!allowed.includes(name)) fail(prefix + name, 'trường không được hỗ trợ');
  }
}

function requireTable(source, field, allowed) {
  if (!Object.hasOwn(source, field)) fail(field, 'thiếu trường');
  const table = source[field];
  if (!isPlainObject(table)) fail(field, 'phải là một bảng');
  checkKnown(table, allowed, `${field}.`);
  return table;
}

function deepestRealpath(target) {
  const tail = [];
  let current = target;
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...tail.reverse());
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try {
        fs.lstatSync(current);
        throw new Error(`${current} là symlink treo`);
      } catch (statError) {
        if (statError.code !== 'ENOENT') throw statError;
      }
      const parent = path.dirname(current);
      if (parent === current) throw error;
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

function realpathOrFail(target) {
  try {
    return deepestRealpath(target);
  } catch (error) {
    return fail('checkout', `không phân giải được đường dẫn (${error.code || error.message})`);
  }
}

function resolveCheckout(value, dzHome) {
  if (!isString(value)) fail('checkout', value === undefined ? 'thiếu trường' : 'phải là chuỗi không rỗng');
  if (!path.isAbsolute(value)) fail('checkout', 'phải là đường dẫn tuyệt đối');
  if (value.split(path.sep).includes('..')) fail('checkout', 'không được chứa ..');
  const root = realpathOrFail(path.join(dzHome, 'workspaces'));
  const resolved = realpathOrFail(path.normalize(value));
  if (!resolved.startsWith(root + path.sep)) fail('checkout', `phải nằm trong ${path.join(dzHome, 'workspaces')}`);
  return resolved;
}

function buildPeople(source) {
  const people = {};
  for (const name of PEOPLE_FIELDS) {
    const value = source[name];
    if (value === undefined) {
      if (PEOPLE_REQUIRED.includes(name)) fail(`people.${name}`, 'thiếu trường');
      continue;
    }
    people[name] = requireDiscordId(value, `people.${name}`);
  }
  return people;
}

function buildJiraStatus(source) {
  return {
    waiting: requireStrings(source, 'waiting', 'jiraStatus.'),
    done: requireStrings(source, 'done', 'jiraStatus.'),
    inProgress: requireString(source, 'inProgress', 'jiraStatus.'),
    resolved: requireString(source, 'resolved', 'jiraStatus.'),
    reopened: requireString(source, 'reopened', 'jiraStatus.'),
  };
}

function buildProject(doc, expectedKey, dzHome) {
  if (!isPlainObject(doc)) fail('file', 'phải là một bảng YAML');
  checkKnown(doc, TOP_FIELDS, '');
  const key = requireString(doc, 'key');
  if (!KEY.test(key)) fail('key', 'sai định dạng [A-Z][A-Z0-9]+');
  if (key !== expectedKey) fail('key', `phải trùng tên file (${expectedKey})`);
  const repo = requireString(doc, 'repo');
  if (!REPO.test(repo)) fail('repo', 'phải có dạng owner/name');
  const excludedDevices = doc.excludedDevices ?? [];
  if (!Array.isArray(excludedDevices) || !excludedDevices.every(isString)) {
    fail('excludedDevices', 'phải là danh sách chuỗi');
  }
  if (!Object.hasOwn(doc, 'enabled')) fail('enabled', 'thiếu trường');
  const { enabled } = doc;
  if (typeof enabled !== 'boolean') fail('enabled', 'phải là true hoặc false');
  if (typeof doc.live !== 'boolean') fail('live', Object.hasOwn(doc, 'live') ? 'phải là true hoặc false' : 'thiếu trường');
  const project = {
    key,
    repo,
    base: requireString(doc, 'base'),
    checkout: resolveCheckout(doc.checkout, dzHome),
    flavor: requireString(doc, 'flavor'),
    package: requireString(doc, 'package'),
    jiraStatus: buildJiraStatus(requireTable(doc, 'jiraStatus', JIRA_FIELDS)),
    people: buildPeople(requireTable(doc, 'people', PEOPLE_FIELDS)),
    specUrl: requireString(doc, 'specUrl'),
    figmaUrl: requireString(doc, 'figmaUrl'),
    excludedDevices: [...excludedDevices],
    enabled,
    live: doc.live,
    localFiles: buildLocalFiles(doc),
    commands: buildCommands(requireTable(doc, 'commands', COMMAND_FIELDS)),
    harnessCommit: buildHarnessCommit(doc),
    forbidden: optionalPaths(doc, 'forbidden'),
    ...buildChannel(doc),
    ...buildRoles(doc),
    ...buildE2eDevices(doc),
  };
  Object.defineProperty(project, 'schedulable', { value: enabled, enumerable: true });
  return project;
}

function loadProjects(dir, { dzHome }) {
  if (!isString(dzHome)) throw new TypeError('dzHome là bắt buộc');
  const home = deepestRealpath(path.resolve(dzHome));
  const projects = new Map();
  const errors = [];
  const files = fs.readdirSync(dir).filter(name => path.extname(name) === '.yaml').sort();
  for (const file of files) {
    try {
      const doc = YAML.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      const project = buildProject(doc, path.basename(file, '.yaml'), home);
      projects.set(project.key, project);
    } catch (error) {
      errors.push({ file, message: error.message });
    }
  }
  return { projects, errors };
}

module.exports = { loadProjects };
