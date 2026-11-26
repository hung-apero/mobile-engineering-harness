const { redact } = require('../redact.cjs');

const TEXT_MAX = 2000;
const ERROR_MAX = 300;

class ResultError extends Error {}

const fail = message => {
  throw new ResultError(message);
};

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function requireObject(value, fields, where) {
  if (!isPlainObject(value)) fail(`${where} phải là một object`);
  for (const name of Object.keys(value)) {
    if (!fields.includes(name)) fail(`${where}: trường lạ ${name}`);
  }
  return value;
}

function requireList(value, where) {
  if (!Array.isArray(value)) fail(`${where} phải là danh sách`);
  return value;
}

function oneOf(value, list, where) {
  if (typeof value !== 'string' || !list.includes(value)) fail(`${where} không hợp lệ: ${value}`);
  return value;
}

function textOf(value, where) {
  if (typeof value !== 'string' || value.trim() === '') fail(`${where} phải là chuỗi không rỗng`);
  if (value.length > TEXT_MAX) fail(`${where} dài quá ${TEXT_MAX} ký tự`);
  return redact(value);
}

const optional = (value, read) => (value === undefined || value === null || value === '' ? null : read(value));

function matching(value, pattern, where) {
  if (typeof value !== 'string' || !pattern.test(value)) fail(`${where} không hợp lệ: ${value}`);
  return value;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return fail('JSON không đọc được');
  }
}

function lastJsonBlock(text) {
  if (typeof text !== 'string') fail('không có khối JSON');
  const starts = [...text.matchAll(/^[ \t]*```json[ \t]*\r?\n/gm)];
  if (starts.length === 0) return null;
  const last = starts[starts.length - 1];
  const body = text.slice(last.index + last[0].length);
  const end = body.search(/^[ \t]*```[ \t]*\r?$/m);
  if (end === -1) fail('khối JSON cuối chưa đóng');
  return parseJson(body.slice(0, end));
}

function attempt(read) {
  try {
    return { ok: true, ...read() };
  } catch (error) {
    if (!(error instanceof ResultError)) throw error;
    return { ok: false, error: redact(error.message).slice(0, ERROR_MAX) };
  }
}

module.exports = { TEXT_MAX, fail, requireObject, requireList, oneOf, textOf, optional, matching, parseJson, lastJsonBlock, attempt };
