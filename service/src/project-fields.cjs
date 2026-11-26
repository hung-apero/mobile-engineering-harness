const path = require('node:path');

const COMMAND_REQUIRED = ['compile', 'unitTest', 'assemble'];
const COMMAND_OPTIONAL = ['lint', 'distribute'];
const COMMAND_FIELDS = [...COMMAND_REQUIRED, ...COMMAND_OPTIONAL, 'apkGlob'];
const COMMIT = /^[0-9a-f]{7,40}$/;
const SERIAL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const DISCORD_ID = /^\d{17,20}$/;
const ROLE_FIELDS = ['po', 'qa', 'dev'];

class ProjectError extends Error {}

const fail = (field, reason) => {
  throw new ProjectError(`${field}: ${reason}`);
};

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isString = value => typeof value === 'string' && value.trim() !== '';

function requireString(source, field, prefix = '') {
  if (!Object.hasOwn(source, field)) fail(prefix + field, 'thiếu trường');
  if (!isString(source[field])) fail(prefix + field, 'phải là chuỗi không rỗng');
  return source[field];
}

function requireStrings(source, field, prefix) {
  if (!Object.hasOwn(source, field)) fail(prefix + field, 'thiếu trường');
  const list = source[field];
  if (!Array.isArray(list) || list.length === 0 || !list.every(isString)) {
    fail(prefix + field, 'phải là danh sách chuỗi không rỗng');
  }
  return [...list];
}

function optionalPaths(source, field) {
  const list = source[field] ?? [];
  if (!Array.isArray(list) || !list.every(isString)) fail(field, 'phải là danh sách chuỗi');
  return [...list];
}

function buildLocalFiles(source) {
  const files = optionalPaths(source, 'localFiles');
  for (const file of files) {
    if (path.isAbsolute(file) || file.split(/[\\/]/).includes('..')) fail('localFiles', `${file}: phải là đường dẫn tương đối, không chứa ..`);
  }
  return files;
}

function buildCommands(source) {
  const commands = {};
  for (const name of COMMAND_REQUIRED) commands[name] = requireStrings(source, name, 'commands.');
  for (const name of COMMAND_OPTIONAL) if (source[name] !== undefined) commands[name] = requireStrings(source, name, 'commands.');
  commands.apkGlob = requireString(source, 'apkGlob', 'commands.');
  return commands;
}

function buildHarnessCommit(doc) {
  const value = requireString(doc, 'harnessCommit');
  if (!COMMIT.test(value)) fail('harnessCommit', 'phải là 7-40 chữ số hex');
  return value;
}

function requireDiscordId(value, field) {
  if (typeof value !== 'string' || !DISCORD_ID.test(value)) fail(field, 'phải là chuỗi 17-20 chữ số, đặt trong nháy');
  return value;
}

function buildChannel(doc) {
  return doc.channel === undefined ? {} : { channel: requireDiscordId(doc.channel, 'channel') };
}

function buildE2eDevices(doc) {
  if (doc.e2eDevices === undefined) return {};
  const list = doc.e2eDevices;
  if (!Array.isArray(list) || !list.every(serial => typeof serial === 'string' && SERIAL.test(serial))) fail('e2eDevices', 'phải là danh sách serial thiết bị');
  return { e2eDevices: [...list] };
}

function buildRoles(doc) {
  if (doc.roles === undefined) return {};
  if (!isPlainObject(doc.roles)) fail('roles', 'phải là một bảng');
  const roles = {};
  for (const [name, value] of Object.entries(doc.roles)) {
    if (!ROLE_FIELDS.includes(name)) fail(`roles.${name}`, 'trường không được hỗ trợ');
    roles[name] = requireDiscordId(value, `roles.${name}`);
  }
  return { roles };
}

module.exports = { fail, isPlainObject, isString, requireString, requireStrings, optionalPaths, buildLocalFiles, buildCommands, buildHarnessCommit, requireDiscordId, buildChannel, buildE2eDevices, buildRoles, COMMAND_FIELDS };
