import { post, load, say } from './net.js';
import { startChat } from './quiz-chat.js';
import { startAuto } from './quiz-auto.js';

const OTHER = 'Khác';
const api = `/api${location.pathname}`;
const round = Number(document.getElementById('main').dataset.round);
const parts = [...document.querySelectorAll('[data-part]')].map(node => ({
  node, role: node.dataset.part || null, submit: node.querySelector('.submit'), help: node.querySelector('.send-help'), status: node.querySelector('.send-status'), sending: false,
}));
const cards = [...document.querySelectorAll('.card')].map(node => ({
  node, qid: node.dataset.qid, blocking: 'blocking' in node.dataset, text: node.querySelector('.other textarea'),
  saved: node.querySelector('.saved'), dirty: false, saving: null, timer: 0, part: parts.find(part => part.node.contains(node)),
}));
const sending = () => parts.some(part => part.sending);
let leaving = false;

const choiceOf = card => card.node.querySelector('fieldset input:checked')?.value ?? null;
const valueOf = card => ({ choice: choiceOf(card), text: choiceOf(card) === OTHER ? card.text.value : '' });
const answered = card => choiceOf(card) !== null && (choiceOf(card) !== OTHER || card.text.value.trim() !== '');
const busy = () => !leaving && cards.some(card => card.dirty || card.saving);

function reload() {
  leaving = true;
  location.reload();
}

function refresh() {
  const done = cards.filter(answered).length;
  document.getElementById('progress').value = done;
  document.getElementById('progress-text').textContent = `Đã trả lời ${done} / ${cards.length} câu`;
  for (const card of cards) {
    document.querySelector(`[data-nav="${CSS.escape(card.qid)}"]`)?.classList.toggle('answered', answered(card));
    if (answered(card)) card.node.classList.remove('missing');
  }
  for (const part of parts) {
    const mine = cards.filter(card => card.part === part);
    const missing = mine.filter(card => card.blocking && !answered(card));
    const skipped = mine.length - mine.filter(answered).length - missing.length;
    const ready = skipped ? `Đã đủ để gửi. Còn ${skipped} câu có thể bỏ qua chưa trả lời.` : 'Đã đủ để gửi.';
    if (part.help) part.help.textContent = missing.length ? `Còn ${missing.length} câu cần trả lời trước khi gửi.` : ready;
    if (part.submit) part.submit.disabled = part.sending || missing.length > 0;
  }
}

async function saveLoop(card) {
  while (card.dirty) {
    card.dirty = false;
    say(card.saved, 'Đang lưu…');
    const result = await post(`${api}/draft`, { qid: card.qid, round, ...valueOf(card) }, true);
    if (result.ok) {
      say(card.saved, 'Đã lưu');
      continue;
    }
    say(card.saved, result.error, 'bad');
    card.dirty = true;
    if (result.status === 409) sync();
    else if (result.status === 0 || result.status >= 500) card.timer = setTimeout(() => save(card), 5000);
    return false;
  }
  return true;
}

function save(card) {
  clearTimeout(card.timer);
  card.saving ??= saveLoop(card).finally(() => { card.saving = null; });
  return card.saving;
}

function changed(card, wait) {
  card.dirty = true;
  refresh();
  clearTimeout(card.timer);
  if (wait) card.timer = setTimeout(() => save(card), wait);
  else save(card);
}

for (const card of cards) {
  card.node.querySelector('fieldset').addEventListener('change', event => {
    if (event.target.type !== 'radio') return;
    changed(card, 0);
    if (event.target.value === OTHER) card.text.focus();
  });
  card.text.addEventListener('input', () => {
    card.node.querySelector(`input[value="${OTHER}"]`).checked = true;
    changed(card, 600);
  });
}

async function flush() {
  const results = await Promise.all(cards.filter(card => card.dirty || card.saving).map(save));
  return results.every(Boolean) && !busy();
}

async function send(part) {
  part.sending = true;
  refresh();
  say(part.status, 'Đang gửi…');
  const body = part.role ? { round, role: part.role } : { round };
  const result = await flush() ? await post(`${api}/submit`, body) : { ok: false, error: 'Có câu chưa lưu được. Hãy kiểm tra mạng rồi gửi lại.' };
  if (result.ok) {
    scrollTo(0, 0);
    return reload();
  }
  part.sending = false;
  refresh();
  say(part.status, result.error, 'bad');
  const missing = cards.filter(card => result.missing?.includes(card.qid));
  missing.forEach(card => card.node.classList.add('missing'));
  missing[0]?.node.scrollIntoView({ block: 'start' });
}

parts.filter(part => part.submit).forEach(part => part.submit.addEventListener('click', () => send(part)));

function applyDraft(card, draft) {
  if (!draft || card.dirty || card.saving) return;
  const input = [...card.node.querySelectorAll('fieldset input')].find(node => node.value === draft.choice);
  if (input) input.checked = true;
  if (draft.choice === OTHER && document.activeElement !== card.text) card.text.value = draft.text;
}

async function sync() {
  const state = await load(`${api}/state`);
  if (!state.ok) return;
  if (!state.open || state.round !== round) return reload();
  cards.forEach(card => applyDraft(card, state.drafts[card.qid]));
  refresh();
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) flush();
  else if (!sending()) sync();
});
addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
addEventListener('beforeunload', event => { if (busy()) event.preventDefault(); });

startChat(api);
startAuto(api, round);
refresh();
