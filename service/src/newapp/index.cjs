const fs = require('node:fs');
const path = require('node:path');
const kv = require('../kv.cjs');
const { checklist } = require('./items.cjs');
const { KEY } = require('./formats.cjs');
const { ensureSecretDir } = require('./secret-files.cjs');
const local = require('./checks-local.cjs');
const remote = require('./checks-remote.cjs');
const { writeProject } = require('./create.cjs');

const CHECKS = { ...local, ...remote };
const draftKey = key => `newapp:${key}`;
const resultKey = key => `newapp:${key}:check`;

class NewAppError extends Error {}

function loadDraft(ctx, key) {
  const draft = kv.get(ctx.db, draftKey(key));
  if (!draft) throw new NewAppError(`chưa có danh sách app mới ${key}, chạy newapp start trước`);
  return draft;
}

function start(ctx, app, now) {
  if (!KEY.test(app?.key ?? '')) throw new NewAppError('app.key: sai định dạng [A-Z][A-Z0-9]+');
  if (fs.existsSync(path.join(ctx.projectsDir, `${app.key}.yaml`))) throw new NewAppError(`project ${app.key} đã tồn tại, không ghi đè`);
  ensureSecretDir(ctx.secretsDir, app.key);
  kv.set(ctx.db, draftKey(app.key), app, now);
  kv.del(ctx.db, resultKey(app.key));
  return { items: checklist(app) };
}

async function verifyAll(ctx, app, now, deps) {
  const dir = path.join(ctx.secretsDir, 'newapp', String(app.key));
  const items = [];
  for (const item of checklist(app)) {
    let outcome;
    try {
      outcome = await CHECKS[item.id]({ app, dir, deps });
    } catch (error) {
      outcome = { state: 'wrong', detail: `lỗi khi kiểm: ${String(error.message).split('\n')[0].slice(0, 200)}` };
    }
    items.push({ id: item.id, required: item.required, state: outcome.state, detail: outcome.detail });
  }
  const ok = items.every(i => !i.required || i.state === 'ok');
  const result = { ok, at: now, items: items.map(({ id, state, detail }) => ({ id, state, detail })) };
  if (KEY.test(app.key ?? '')) kv.set(ctx.db, resultKey(app.key), { ...result, required: Object.fromEntries(items.map(i => [i.id, i.required])) }, now);
  return result;
}

function status(ctx, key) {
  const draft = loadDraft(ctx, key);
  const last = kv.get(ctx.db, resultKey(key));
  const states = new Map((last?.items ?? []).map(i => [i.id, i]));
  return {
    app: draft,
    checkedAt: last?.at ?? null,
    ok: last?.ok ?? false,
    items: checklist(draft).map(item => ({ ...item, state: states.get(item.id)?.state ?? 'unchecked', detail: states.get(item.id)?.detail ?? 'chưa kiểm' })),
  };
}

function prerequisites(ctx, key) {
  const last = kv.get(ctx.db, resultKey(key));
  const state = id => last?.items.find(i => i.id === id)?.state === 'ok';
  const all = ids => ids.every(state);
  return {
    code: all(['repo-empty', 'repo-writable', 'app-key', 'app-package', 'app-application-id', 'app-name']),
    distribute: all(['google-services', 'firebase-tester-group']),
  };
}

function missingRequired(result) {
  const checklistItems = new Map(checklist({}).map(i => [i.id, i]));
  return result.items.filter(i => checklistItems.get(i.id).required && i.state !== 'ok');
}

async function create(ctx, key, spec, now, deps) {
  const app = loadDraft(ctx, key);
  const result = await verifyAll(ctx, app, now, deps);
  if (!result.ok) {
    const lines = missingRequired(result).map(i => `${i.id} (${i.state}): ${i.detail}`);
    throw new NewAppError(`chưa đủ mục, không tạo project: ${lines.join('; ')}`);
  }
  const temporary = result.items.filter(i => i.id.startsWith('optional-') && app.optional?.[i.id.slice(9)] === 'temporary').map(i => i.id);
  const file = writeProject(ctx, app, spec, deps.harnessCommit());
  return { file, temporary };
}

module.exports = { start, status, verifyAll, create, prerequisites, NewAppError };
