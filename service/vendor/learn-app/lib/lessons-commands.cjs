const fs = require('fs');
const path = require('path');
const { DIR } = require('./learn-app-state.cjs');
const { fail, print, option, firstLine } = require('./cli-io.cjs');
const L = require('./lessons-memory.cjs');

function appOption() {
  const app = option('app');
  if (!app || !/^[A-Za-z0-9_-]+$/.test(app)) fail('Cần --app <mã app>, ví dụ AAP864');
  return app;
}

function guarded(fn) {
  try {
    return fn();
  } catch (error) {
    return fail(`Kho bài học: ${firstLine(error)}`);
  }
}

function lessonsPrepare() {
  const app = appOption();
  print(guarded(() => L.prepare(app)));
}

function lessonsPublish() {
  const app = appOption();
  const out = option('out');
  if (!out || !fs.existsSync(out)) fail('Cần --out <thư mục lesson-miner đã ghi>');
  const result = guarded(() => L.publish(app, path.resolve(out)));
  if (!result.ok) fail(`File chưa đúng định dạng, chưa đẩy gì:\n- ${result.errors.join('\n- ')}`);
  print(result);
}

function ignoreLessons(root) {
  const file = path.join(root, DIR, '.gitignore');
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (!current.split('\n').includes('lessons/')) fs.writeFileSync(file, `${current}${current && !current.endsWith('\n') ? '\n' : ''}lessons/\n`);
}

function lessonsSync(root) {
  ignoreLessons(root);
  const skip = option('skip');
  print(skip ? L.skipLessons(root, skip) : guarded(() => L.syncLessons(root)));
}

module.exports = { lessonsPrepare, lessonsPublish, lessonsSync };
