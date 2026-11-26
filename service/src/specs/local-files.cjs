const fs = require('node:fs');
const path = require('node:path');
const { runGit } = require('../bugs/git.cjs');

const lstat = target => fs.lstatSync(target, { throwIfNoEntry: false });

function realDirs(root, relative) {
  return relative.split('/').filter(part => part && part !== '.').reduce((parent, part) => {
    const dir = path.join(parent, part);
    if (!lstat(dir)) fs.mkdirSync(dir);
    else if (!lstat(dir).isDirectory()) throw new Error(`${dir} phải là thư mục thật`);
    return dir;
  }, root);
}

function exclude(repo, name) {
  const file = path.join(realDirs(repo, '.git/info'), 'exclude');
  const text = lstat(file) ? fs.readFileSync(file, 'utf8') : '';
  const line = `/${name}`;
  if (!text.split('\n').includes(line)) fs.writeFileSync(file, `${text}${text && !text.endsWith('\n') ? '\n' : ''}${line}\n`);
}

async function copyLocalFiles({ project, repo, git = runGit }) {
  if (!project.localFiles?.length) return;
  const source = fs.realpathSync(project.checkout);
  for (const name of project.localFiles) {
    const bad = reason => new Error(`localFiles ${name}: ${reason}`);
    if (/[\\\n*?[\]!#]/.test(name) || name.split('/').some(part => ['', '.', '..', '.git'].includes(part.toLowerCase()))) throw bad('đường dẫn không hợp lệ');
    if ((await git(['ls-files', '--', `:(literal)${name}`], { cwd: repo })).stdout) continue;
    const from = path.join(source, name);
    if (!lstat(from)?.isFile() || fs.realpathSync(from) !== from) throw bad('phải là file thường nằm trong checkout');
    const to = path.join(realDirs(repo, path.dirname(name)), path.basename(name));
    exclude(repo, name);
    if (!lstat(to)) fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
    else if (!lstat(to).isFile()) throw bad('đích không phải file thường');
  }
}

module.exports = { copyLocalFiles };
