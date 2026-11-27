const newapp = require('./newapp/index.cjs');
const { defaultDeps } = require('./newapp/default-deps.cjs');
const { ExpectedError } = require('./run.cjs');

const APP_FLAGS = {
  '--name': 'name',
  '--package': 'package',
  '--application-id': 'applicationId',
  '--repo': 'repo',
  '--firebase-project': 'firebaseProjectId',
  '--tester-group': 'testerGroup',
  '--jira-project': 'jiraProject',
  '--signing': 'signing',
};
const DISCORD_FLAGS = { '--discord-channel': 'channelId', '--po': 'po', '--qa': 'qa', '--dev': 'devOnCall' };
const OPTIONAL_FLAGS = { '--provided': 'provided', '--temporary': 'temporary' };
const SPEC_FLAGS = { '--spec-url': 'specUrl', '--figma-url': 'figmaUrl' };

function parseFlags(rest, allowed) {
  const values = {};
  for (let i = 0; i < rest.length; i += 2) {
    const [name, value] = [rest[i], rest[i + 1]];
    if (!allowed.includes(name) || value === undefined || Object.hasOwn(values, name)) throw new ExpectedError(`tham số không hợp lệ: ${name}`);
    values[name] = value;
  }
  return values;
}

function appFrom(key, rest) {
  const flags = parseFlags(rest, [...Object.keys(APP_FLAGS), ...Object.keys(DISCORD_FLAGS), ...Object.keys(OPTIONAL_FLAGS)]);
  const app = { key, discord: {}, optional: {} };
  for (const [flag, value] of Object.entries(flags)) {
    if (APP_FLAGS[flag]) app[APP_FLAGS[flag]] = value;
    else if (DISCORD_FLAGS[flag]) app.discord[DISCORD_FLAGS[flag]] = value;
    else for (const name of value.split(',').filter(Boolean)) app.optional[name] = OPTIONAL_FLAGS[flag];
  }
  return app;
}

function render(items) {
  return items.map(i => `[${i.state ?? (i.required ? 'cần' : 'tuỳ chọn')}] ${i.id}: ${i.detail ?? i.text}`);
}

async function run(ctx, args, now, deps = defaultDeps(ctx)) {
  const [sub, key, ...rest] = args;
  if (!key) throw new ExpectedError('thiếu mã app');
  try {
    if (sub === 'start') {
      const { items } = newapp.start(ctx, appFrom(key, rest), now);
      return ['Danh sách dev cần cung cấp:', ...items.map(i => `- [${i.required ? 'bắt buộc' : 'tuỳ chọn'}] ${i.id}: ${i.text}`)];
    }
    if (sub === 'status') {
      const view = newapp.status(ctx, key);
      return [`Kiểm lần cuối: ${view.checkedAt ?? 'chưa kiểm'}`, ...render(view.items)];
    }
    if (sub === 'check') {
      const app = newapp.status(ctx, key).app;
      const result = await newapp.verifyAll(ctx, app, now, deps);
      return [result.ok ? 'Đủ mục bắt buộc' : 'Còn thiếu mục bắt buộc', ...render(result.items)];
    }
    if (sub === 'create') {
      const spec = {};
      for (const [flag, value] of Object.entries(parseFlags(rest, Object.keys(SPEC_FLAGS)))) spec[SPEC_FLAGS[flag]] = value;
      const { file, temporary } = await newapp.create(ctx, key, spec, now, deps);
      const lines = [`Đã tạo ${file} (enabled: false, live: false); người cần bật enabled`];
      if (temporary.length) lines.push(`Thay trước khi lên store: ${temporary.join(', ')}`);
      return lines;
    }
  } catch (error) {
    if (error instanceof newapp.NewAppError) throw new ExpectedError(error.message);
    throw error;
  }
  throw new ExpectedError('dùng: newapp start|status|check|create <KEY>');
}

const KEY = /^[A-Z][A-Z0-9]+$/;
const validNewapp = ([sub, key, ...rest]) => ['start', 'status', 'check', 'create'].includes(sub) && KEY.test(key ?? '') && (rest.length === 0 || sub === 'start' || sub === 'create') && rest.length % 2 === 0;

module.exports = { newapp: run, appFrom, validNewapp };
