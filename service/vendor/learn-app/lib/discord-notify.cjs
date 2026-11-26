const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DIR, writeJsonAtomic } = require('./learn-app-state.cjs');

// Tells the PO on Discord when the machine needs them, so nobody watches the terminal: a gate waiting for approval
// (always), the questions ready after scout (step clear, once per set of questions: answers that shrink the list send nothing), and from coding on: a stuck run and each
// finished step. Each alert goes once per step, however often the run stops on it.
// One-way webhook: LEARN_APP_DISCORD_WEBHOOK (never written to disk or printed), LEARN_APP_DISCORD_PO = the PO's
// Discord user id to mention. The PO answers in Claude Code. Sent in a background process; any failure is ignored.
const AFTER_PLANNING = new Set(['coding', 'smoke', 'handoff']);
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_CONTENT = 1900;
const sentFile = root => path.join(root, DIR, 'notified.json');

function wanted(state, why, kind, env = process.env) {
  if (!env.LEARN_APP_DISCORD_WEBHOOK) return false;
  if (/^chờ PO duyệt cổng/.test(why)) return true;
  if (kind === 'po-wait' && state.step === 'clear') return true;
  return ['po-wait', 'stuck', 'phase-done'].includes(kind) && AFTER_PLANNING.has(state.step);
}

function itemLine(item) {
  const options = (item.options || []).map(o => (typeof o === 'string' ? o : o.label)).join(' / ');
  return [
    `• ${item.question || item.target || item.key}`,
    options ? `  Lựa chọn: ${options}` : null,
  ].filter(Boolean).join('\n');
}

// { content, images, key } for this stop.
function message(root, state, why, env = process.env) {
  const items = /hỏi PO/.test(why) ? require('./questions.cjs').questionItems(root, state) : [];
  const asked = state.step === 'clear' ? require('./looper-parse.cjs').openQuestions(root).map(q => `• ${q.title}`) : [];
  const mention = env.LEARN_APP_DISCORD_PO ? `<@${env.LEARN_APP_DISCORD_PO}> ` : '';
  let content = [`${mention}**${state.app || 'learn-app'}** — ${why}`, ...asked.slice(0, 15), asked.length > 15 ? `… và ${asked.length - 15} câu nữa` : null, ...items.slice(0, 10).map(itemLine), items.length > 10 ? `… và ${items.length - 10} mục nữa` : null, '_Trả lời trong Claude Code (learn-app)._'].filter(Boolean).join('\n');
  if (content.length > MAX_CONTENT) content = `${content.slice(0, MAX_CONTENT - 1)}…`;
  const images = items.map(i => i.image).filter(Boolean).map(f => path.resolve(root, f))
    .filter(f => { try { return fs.statSync(f).size <= MAX_IMAGE_BYTES; } catch { return false; } }).slice(0, MAX_IMAGES);
  const { questionBlocks, read } = require('./looper-parse.cjs');
  const once = state.step === 'clear' && !/^chờ PO duyệt cổng/.test(why) ? `clear:${questionBlocks(read(root, 'questions.md') || '').map(b => b.id).join(',')}` : why;
  const key = crypto.createHash('sha1').update(`${once}|${items.map(i => `${i.feature || ''}/${i.decision || i.key || ''}`).sort().join(',')}`).digest('hex');
  return { content, images, key, mention: env.LEARN_APP_DISCORD_PO || null };
}

function alreadyAlerted(root, key, step) {
  return (readSent(root).alerts || []).some(a => a.key === key && a.step === step);
}

function recordAlert(root, key, step) {
  const data = readSent(root);
  const alerts = (data.alerts || []).filter(a => a.step === step && a.key !== key);
  writeJsonAtomic(sentFile(root), { ...data, alerts: [...alerts, { key, step, at: new Date().toISOString() }] });
}

function readSent(root) {
  try {
    return JSON.parse(fs.readFileSync(sentFile(root), 'utf8'));
  } catch {
    return { sent: [] };
  }
}

function markSent(root, key, messageId = null) {
  const data = readSent(root);
  const sent = (data.sent || []).filter(s => s.key !== key || !messageId);
  const entry = { ...((data.sent || []).find(s => s.key === key) || { key, at: new Date().toISOString() }), ...(messageId ? { messageId } : {}) };
  writeJsonAtomic(sentFile(root), { ...data, sent: [...sent.filter(s => s.key !== key), entry].slice(-50) });
}

// Called on every autopilot stop. Returns whether a message was queued. Never throws.
function notify(root, state, why, kind, { env = process.env, spawnSender = spawnSend } = {}) {
  try {
    if (!wanted(state, why, kind, env)) return false;
    const msg = message(root, state, why, env);
    if (alreadyAlerted(root, msg.key, state.step)) return false;
    recordAlert(root, msg.key, state.step);
    spawnSender({ ...msg, root });
    return true;
  } catch {
    return false;
  }
}

// The sender runs detached, so a hook never waits for the network; the webhook comes from its inherited env.
function spawnSend(msg) {
  const file = path.join(os.tmpdir(), `learnapp-discord-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(msg));
  spawn(process.execPath, [__filename, '--send', file], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

// Posts and returns the message id (?wait=true): replies to it are the PO's answers (discord-replies.cjs).
async function send(msg, { webhook = process.env.LEARN_APP_DISCORD_WEBHOOK, fetchImpl = fetch } = {}) {
  const form = new FormData();
  form.append('payload_json', JSON.stringify({ content: msg.content, allowed_mentions: { users: msg.mention ? [msg.mention] : [] } }));
  (msg.images || []).forEach((file, i) => form.append(`files[${i}]`, new Blob([fs.readFileSync(file)]), path.basename(file)));
  const url = new URL(webhook);
  url.searchParams.set('wait', 'true');
  const res = await fetchImpl(url.toString(), { method: 'POST', body: form });
  if (!res.ok) throw new Error(`Discord HTTP ${res.status}`);
  try {
    return (await res.json()).id || null;
  } catch {
    return null;
  }
}

// A line from the Looper to the PO (a confirmation, a question asked again), sent now; replies after it count.
async function say(root, text, { env = process.env, fetchImpl = fetch } = {}) {
  if (!env.LEARN_APP_DISCORD_WEBHOOK) throw new Error('chưa có LEARN_APP_DISCORD_WEBHOOK');
  const mention = env.LEARN_APP_DISCORD_PO || null;
  const id = await send({ content: `${mention ? `<@${mention}> ` : ''}${text}`.slice(0, MAX_CONTENT), images: [], mention }, { webhook: env.LEARN_APP_DISCORD_WEBHOOK, fetchImpl });
  if (id) markSent(root, `say-${id}`, id);
  return id;
}

if (require.main === module && process.argv[2] === '--send') {
  const file = process.argv[3];
  (async () => {
    try {
      const msg = JSON.parse(fs.readFileSync(file, 'utf8'));
      const id = await send(msg);
      if (id && msg.root) markSent(msg.root, msg.key, id);
    } catch {}
    fs.rmSync(file, { force: true });
  })();
}

module.exports = { notify, message, wanted, send, say, spawnSend, markSent };
