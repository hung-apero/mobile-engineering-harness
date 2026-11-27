const fs = require('node:fs');
const path = require('node:path');
const { openDb } = require('../src/db.cjs');
const { createDiscordBot } = require('../src/discord-bot.cjs');
const { createDesk } = require('../src/mcp/desk.cjs');

const NOW = Date.parse('2026-11-25T10:00:00+07:00');
const MIN = 60000;
const TOKEN = `${'A'.repeat(26)}.secret.${'z'.repeat(38)}`;
const GUILD = '900000000000000001';
const CHANNEL = '900000000000000002';
const THREAD = '900000000000000003';
const ELSEWHERE = '900000000000000004';
const PO = '123456789012345678';
const BACKUP = '123456789012345679';
const OTHER = '523456789012345678';
const ROLE = '700000000000000001';
const SHA = 'a'.repeat(64);
const SHA2 = 'b'.repeat(64);

let counter = 0n;
const idAt = time => {
  counter += 1n;
  return String(((BigInt(time) - 1420070400000n) << 22n) + counter);
};

function tempHome() {
  const dir = fs.mkdtempSync(path.join('/private/tmp', 'dzd-'));
  fs.mkdirSync(path.join(dir, 'secrets'), { mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'secrets', 'discord-bot-token'), `${TOKEN}\n`, { mode: 0o600 });
  return dir;
}

const project = (key, extra = {}) => ({
  key, enabled: true, live: false, channel: CHANNEL, people: { po: PO, poBackup: BACKUP, qa: OTHER, devOnCall: OTHER }, ...extra,
});

const tokenFileOf = home => path.join(home, 'secrets', 'discord-bot-token');
const json = (body, status = 200, headers = {}) => Response.json(body, { status, headers });

function fakeDiscord() {
  const calls = [];
  const messages = new Map();
  const channels = new Map([
    [CHANNEL, { id: CHANNEL, guild_id: GUILD, type: 0 }],
    [THREAD, { id: THREAD, guild_id: GUILD, type: 11, parent_id: CHANNEL }],
    [ELSEWHERE, { id: ELSEWHERE, guild_id: GUILD, type: 0 }],
  ]);
  const members = new Map([PO, BACKUP, OTHER].map(id => [id, { user: { id }, roles: [] }]));
  const state = { override: null };

  function route(method, pathname) {
    const [, what, id, sub, subId] = pathname.replace('/api/v10', '').split('/');
    if (method === 'POST') return json({ id: idAt(NOW) });
    if (what === 'guilds') return members.has(subId) ? json(members.get(subId)) : json({ code: 10007 }, 404);
    if (sub === 'messages' && subId) return messages.has(subId) && messages.get(subId).channel_id === id ? json(messages.get(subId)) : json({ code: 10008 }, 404);
    return channels.has(id) ? json(channels.get(id)) : json({ code: 10003 }, 404);
  }

  async function fetchImpl(url, init) {
    const target = new URL(url);
    calls.push({ method: init.method, path: target.pathname.replace('/api/v10', ''), url, init });
    return state.override?.(target, init) ?? route(init.method, target.pathname);
  }

  function post(content, extra = {}, time = NOW - MIN) {
    const id = extra.id ?? idAt(time);
    messages.set(id, { id, channel_id: CHANNEL, type: 0, author: { id: PO }, content, edited_timestamp: null, ...extra });
    return id;
  }

  const replyTo = (messageId, channelId = CHANNEL) => ({ type: 19, message_reference: { type: 0, message_id: messageId, channel_id: channelId, guild_id: GUILD } });
  return { calls, messages, channels, members, state, fetchImpl, post, replyTo, posts: () => calls.filter(call => call.method !== 'GET') };
}

function fakeFacade(specs = []) {
  const calls = [];
  const views = new Map(specs.map(spec => [spec.id, spec]));
  const record = (name, result) => async (...args) => {
    calls.push({ name, args });
    return typeof result === 'function' ? result(...args) : result;
  };
  const specOf = id => ({ id, project: views.get(id).project, title: views.get(id).title ?? `S${id}`, state: views.get(id).state, updatedAt: views.get(id).updatedAt ?? NOW - 60 * MIN, asks: views.get(id).asks ?? null });
  const question = (id, extra = {}) => ({ id, title: id, options: [{ label: 'A', text: 'Một' }, { label: 'B', text: 'Hai' }], answered: false, ...extra });
  return {
    calls,
    views,
    names: () => calls.map(call => call.name),
    of: name => calls.filter(call => call.name === name),
    overview: async () => ({ specs: [...views.keys()].map(specOf), waits: [], jobs: [] }),
    openSpecs: async (key, state) => [...views.keys()].map(specOf).filter(spec => spec.project === key && spec.state === state),
    newSpec: record('newSpec', { id: 41 }),
    quiz: async id => ({ spec: specOf(id), round: views.get(id).round ?? 1, submitted: false, ask: [question('Q1'), question('Q2'), question('Q3', { answered: true })], auto: [], chats: [] }),
    saveDraft: record('saveDraft', true),
    submit: record('submit', { ok: true, missing: [] }),
    review: async id => ({ spec: specOf(id), sha: views.get(id).sha ?? SHA, approved: false }),
    approve: record('approve', { ok: true }),
    feedback: record('feedback', { ok: true }),
    askNow: record('askNow', id => ({ ok: true, line: `Đã gửi 2 câu chờ chốt của spec #${id}: PO 1 · Dev 1` })),
  };
}

const review = (id, key = 'AAP864', extra = {}) => ({ id, project: key, state: 'review', sha: SHA, ...extra });
const quiz = (id, key = 'AAP864', extra = {}) => ({ id, project: key, state: 'quiz', round: 1, ...extra });

function setup(t, { projects = [project('AAP864')], specs = [], facade = fakeFacade(specs) } = {}) {
  const home = tempHome();
  const db = openDb(path.join(home, 'dz.db'));
  const discord = fakeDiscord();
  const clock = { now: NOW };
  const would = [];
  const logs = [];
  const sleeps = [];
  const bot = createDiscordBot({
    tokenFile: tokenFileOf(home), fetchImpl: discord.fetchImpl, now: () => clock.now, would: item => would.push(item),
    sleep: async ms => {
      sleeps.push(ms);
      clock.now += ms;
    },
  });
  const map = new Map(projects.map(item => [item.key, item]));
  const open = () => createDesk({ db, bot, facade, projects: () => map, log: (event, fields) => logs.push({ event, ...fields }), now: () => clock.now });
  const desk = open();
  const call = (name, messageId, channelId = CHANNEL) => desk.call(name, { message_id: messageId, channel_id: channelId });
  t.after(() => {
    db.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  return { home, db, discord, facade, desk, open, call, clock, would, logs, sleeps, bot };
}

module.exports = {
  NOW, MIN, TOKEN, GUILD, CHANNEL, THREAD, ELSEWHERE, PO, BACKUP, OTHER, ROLE, SHA, SHA2,
  idAt, tempHome, tokenFileOf, json, project, fakeFacade, fakeDiscord, review, quiz, setup,
};
