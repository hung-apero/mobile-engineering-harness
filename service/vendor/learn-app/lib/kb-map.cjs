const fs = require('fs');
const path = require('path');

const KB_DIR = path.join(__dirname, '..', 'knowledge', 'coding');

function readKbMap(dir = KB_DIR) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'kb-map.json'), 'utf8'));
}

function kbCategories(dir = KB_DIR) {
  return Object.keys(readKbMap(dir).categories);
}

module.exports = { KB_DIR, readKbMap, kbCategories };
