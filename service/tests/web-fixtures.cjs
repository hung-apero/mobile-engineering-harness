const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { createWeb } = require('../src/web/server.cjs');

const NOW = Date.parse('2026-11-25T10:00:00+07:00');
const QUIZ = 'q'.repeat(43);
const REVIEW = 'r'.repeat(43);
const SHA = 'a'.repeat(64);

const fail = code => Object.assign(new Error(`facade ${code}`), { code });

function question(id, extra = {}) {
  return {
    id, title: `Câu hỏi ${id}`, body: 'Bối cảnh', blocking: false, options: [{ label: 'A', text: 'Một' }, { label: 'B', text: 'Hai' }],
    proposal: { label: 'B', reason: 'đúng spec' }, answered: false, answer: null, mode: 'ask', auto: null, draft: null, ...extra,
  };
}

function quizState(extra = {}) {
  return {
    spec: { id: 7, project: 'AAP864', title: 'Phase 15', state: 'quiz' }, round: 1, submitted: false,
    ask: [question('Q1', { blocking: true }), question('Q2')],
    auto: [question('Q3', { mode: 'auto', auto: { label: 'A', source: 'Figma 12:3', reason: 'rõ' } })],
    chats: [], ...extra,
  };
}

function reviewState(extra = {}) {
  return {
    spec: { id: 7, project: 'AAP864', title: 'Phase 15', state: 'review' }, markdown: '# Phase 15\n\nGiữ nguyên\n\nCâu mới (Q1: B)\n',
    sha: SHA, approved: false,
    diff: [{ type: 'same', text: '# Phase 15' }, { type: 'same', text: '' }, { type: 'same', text: 'Giữ nguyên' }, { type: 'same', text: '' }, { type: 'del', text: 'Câu cũ' }, { type: 'add', text: 'Câu mới (Q1: B)' }],
    poChoices: [{ id: 'Q1', title: 'Câu hỏi Q1', label: 'B', text: 'Hai' }],
    agentChoices: [{ id: 'Q3', title: 'Câu hỏi Q3', label: 'A', text: 'Một', source: 'Figma 12:3' }], ...extra,
  };
}

function createFake(overrides = {}) {
  const calls = [];
  const record = (name, result) => (...args) => {
    calls.push({ name, args });
    return result;
  };
  return {
    calls,
    of: name => calls.filter(call => call.name === name),
    overview: () => ({ projects: [{ key: 'AAP864', note: 'bật' }] }),
    newSpec: record('newSpec', { id: 9 }),
    quiz: () => quizState(),
    saveDraft: record('saveDraft', true),
    submit: record('submit', { ok: true, missing: [] }),
    ask: record('ask', 5),
    changeAuto: record('changeAuto', true),
    review: () => reviewState(),
    approve: record('approve', { ok: true }),
    feedback: record('feedback', { ok: true }),
    ...overrides,
  };
}

function send(port, { method = 'GET', url = '/', headers = {}, body, host = `127.0.0.1:${port}` }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: { host, ...headers }, agent: false }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function startWeb(t, { facade = createFake(), ...options } = {}) {
  const dzHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dz-web-'));
  const logs = [];
  const clock = { now: NOW };
  const tokens = { quiz: { [QUIZ]: 7 }, review: { [REVIEW]: 7 } };
  const ctx = { dzHome, secretsDir: path.join(dzHome, 'secrets'), env: {}, db: null, log: (event, fields) => logs.push({ event, ...fields }) };
  const resolveToken = (_db, token, purpose) => tokens[purpose][token] ?? null;
  const web = createWeb(ctx, { facade, port: 0, now: () => clock.now, resolveToken, ...options });
  const { url } = await web.start();
  const port = Number(new URL(url).port);
  t.after(async () => {
    await web.stop();
    fs.rmSync(dzHome, { recursive: true, force: true });
  });
  const tokenFile = path.join(ctx.secretsDir, 'web-operator-token');
  const get = (target, extra = {}) => send(port, { url: target, ...extra });
  const post = (target, data, extra = {}) => send(port, {
    method: 'POST', url: target, body: typeof data === 'string' ? data : JSON.stringify(data), ...extra,
    headers: { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', ...extra.headers },
  });
  const login = async () => {
    const res = await get(`/?k=${fs.readFileSync(tokenFile, 'utf8').trim()}`);
    return { cookie: res.headers['set-cookie'][0].split(';')[0] };
  };
  return { web, ctx, url, port, get, post, login, logs, clock, tokens, tokenFile, facade };
}

module.exports = { NOW, QUIZ, REVIEW, SHA, fail, question, quizState, reviewState, createFake, startWeb, send };
