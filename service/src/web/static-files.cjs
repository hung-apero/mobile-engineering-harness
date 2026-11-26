const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, 'static');
const TYPES = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

function loadStatic() {
  const files = new Map();
  for (const name of fs.readdirSync(DIR)) {
    const type = TYPES[path.extname(name)];
    if (type) files.set(`/static/${name}`, { type, body: fs.readFileSync(path.join(DIR, name)) });
  }
  return files;
}

module.exports = { loadStatic };
