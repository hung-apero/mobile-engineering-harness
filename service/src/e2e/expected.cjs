const fs = require('node:fs');
const path = require('node:path');

const CASE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const MAX = 8 * 1024 * 1024;

function readIndex(root) {
  const file = path.join(root, '.android-app', 'ts-index.json');
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return [];
  if (!stat.isFile() || stat.size > MAX) throw new Error('ts-index.json không phải file thường');
  const index = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(index)) throw new Error('ts-index.json không phải danh sách');
  return index.flatMap(group => (Array.isArray(group?.testCaseIds) ? group.testCaseIds : []));
}

function readFiles(root) {
  const dir = path.join(root, '.android-app', 'test-cases');
  if (!fs.lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) return [];
  return fs.readdirSync(dir).filter(name => name.endsWith('.md')).map(name => name.slice(0, -3));
}

function expectedCases(root) {
  const ids = [...new Set([...readIndex(root), ...readFiles(root)])];
  if (ids.length === 0) throw new Error('không có danh sách test case để đối chiếu');
  const bad = ids.find(id => typeof id !== 'string' || !CASE_ID.test(id));
  if (bad !== undefined) throw new Error('danh sách test case có mã không hợp lệ');
  return ids;
}

module.exports = { expectedCases, CASE_ID };
