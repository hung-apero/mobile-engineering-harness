const fs = require('node:fs');
const path = require('node:path');
const { runGit, check, pathsFor, checkBase, BATCH_ID } = require('../bugs/git.cjs');
const { ensureMirror, linkHarness, linkOverlay, excludeLines, FEATURE_AGENTS } = require('../bugs/workspace.cjs');
const { hashText } = require('../text-hash.cjs');
const { figmaKeyOf } = require('./intake.cjs');

const { DIR } = require('./repo-files.cjs');
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

async function cloneMirror({ mirror, project, dir, repo, git }) {
  const partial = path.join(dir, 'repo.partial');
  await fs.promises.rm(partial, { recursive: true, force: true });
  await git(['clone', '--quiet', '--no-tags', '--template=', '--branch', checkBase(project.base), '--', mirror, partial], { cwd: dir });
  for (const [name, value] of [['user.name', 'dev-zone'], ['user.email', 'dev-zone@localhost']]) await git(['config', '--local', name, value], { cwd: partial });
  fs.rmSync(path.join(partial, DIR), { recursive: true, force: true });
  fs.renameSync(partial, repo);
}

function writeInputs({ repo, markdown, figma }) {
  if (figma && !figmaKeyOf(figma)) throw Object.assign(new Error('Link Figma không hợp lệ'), { code: 'INVALID' });
  const inputs = path.join(repo, DIR, 'inputs');
  const first = path.join(inputs, 'spec-v1.md');
  const changed = fs.existsSync(first) && hashText(fs.readFileSync(first, 'utf8')) !== hashText(markdown);
  if (changed && fs.existsSync(path.join(repo, DIR, 'clarified'))) throw Object.assign(new Error('Spec nguồn đã đổi so với bản đang làm'), { code: 'CHANGED' });
  if (changed || !fs.existsSync(first)) write(first, `${String(markdown).replace(/\r\n/g, '\n').trim()}\n`);
}

async function prepareSpecClone({ dzHome, project, specId, markdown, source, figma, git = runGit, githubUrl }) {
  const id = check(BATCH_ID, specId, 'specId');
  const { root } = pathsFor({ dzHome, project });
  const { mirror } = await ensureMirror({ dzHome, project, githubUrl, git });
  const dir = path.join(root, 'specs', id);
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(repo, { throwIfNoEntry: false })) await cloneMirror({ mirror, project, dir, repo, git });
  const origin = await git(['config', '--local', '--get', 'remote.origin.url'], { cwd: repo, okCodes: [0, 1] });
  if (origin.stdout.trim() !== mirror) throw Object.assign(new Error('origin của bản clone spec không phải mirror'), { code: 'ORIGIN' });
  excludeLines(repo, [`${DIR}/`]);
  writeInputs({ repo, markdown, figma });
  await linkHarness({ dzHome, project, repo, git, agents: FEATURE_AGENTS });
  linkOverlay({ dzHome, project, repo });
  return { repo, harnessRoot: repo };
}

module.exports = { prepareSpecClone };
