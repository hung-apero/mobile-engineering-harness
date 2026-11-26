const fs = require('node:fs');
const path = require('node:path');

const MAX = 4 * 1024 * 1024;
const journalFile = root => path.join(path.dirname(root), 'adb-journal.jsonl');

function clearJournal(root) {
  fs.rmSync(journalFile(root), { recursive: true, force: true });
}

function readJournal(root) {
  const file = journalFile(root);
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.size > MAX) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(line => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

function upgraded(journal, { storeApk, apk }) {
  let stage = 'none';
  for (const { verb, apk: file, ok, update } of journal) {
    if (ok !== true) continue;
    if (verb === 'uninstall' || verb === 'clear') stage = 'none';
    else if (verb === 'install' && file === storeApk) stage = 'store';
    else if (verb === 'install' && file === apk && stage === 'store' && update === true) return true;
  }
  return false;
}

const installedByUs = journal => journal.some(entry => entry.verb === 'install' && entry.ok === true);
const removedByUs = journal => journal.some(entry => entry.verb === 'uninstall' && entry.ok === true);

module.exports = { journalFile, clearJournal, readJournal, upgraded, installedByUs, removedByUs };
