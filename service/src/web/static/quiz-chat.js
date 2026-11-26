import { post, load, say } from './net.js';

const POLL_MS = 3000;

function line(kind, label, text, waiting = false) {
  const node = document.createElement('p');
  node.className = `say ${kind}${waiting ? ' waiting' : ''}`;
  const hidden = document.createElement('span');
  hidden.className = 'sr';
  hidden.textContent = label;
  node.append(hidden, text);
  return node;
}

function item(chat) {
  const node = document.createElement('li');
  const text = { done: chat.answer, failed: 'Chưa trả lời được. Bạn thử hỏi lại nhé.', open: 'Đang tìm câu trả lời…' }[chat.state];
  node.append(line('you', 'Bạn hỏi: ', chat.question), line('agent', 'Trả lời: ', text, chat.state === 'open'));
  return node;
}

export function startChat(api) {
  const boxes = [...document.querySelectorAll('.card')].map(card => ({
    qid: card.dataset.qid, log: card.querySelector('.log'), form: card.querySelector('.ask'), status: card.querySelector('.chat .status'), shown: '',
  }));
  let timer = 0;

  function draw(chats) {
    for (const box of boxes) {
      const mine = chats.filter(chat => chat.qid === box.qid);
      const key = JSON.stringify(mine);
      if (key === box.shown) continue;
      box.shown = key;
      box.log.replaceChildren(...mine.map(item));
      box.log.scrollTop = box.log.scrollHeight;
    }
    return chats.some(chat => chat.state === 'open');
  }

  async function poll() {
    clearTimeout(timer);
    if (document.hidden) return;
    const state = await load(`${api}/state`);
    if (state.ok && state.open && draw(state.chats)) timer = setTimeout(poll, POLL_MS);
    else if (!state.ok && (state.status === 0 || state.status >= 500)) timer = setTimeout(poll, POLL_MS);
  }

  for (const box of boxes) {
    const input = box.form.querySelector('textarea');
    const button = box.form.querySelector('button');
    box.form.addEventListener('submit', async event => {
      event.preventDefault();
      if (!input.value.trim()) return input.focus();
      button.disabled = true;
      say(box.status, '');
      const result = await post(`${api}/ask`, { qid: box.qid, text: input.value });
      button.disabled = false;
      if (!result.ok) return say(box.status, result.error, 'bad');
      input.value = '';
      poll();
    });
    input.addEventListener('keydown', event => {
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
      event.preventDefault();
      box.form.requestSubmit();
    });
  }

  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
  if (document.querySelector('.say.waiting')) timer = setTimeout(poll, POLL_MS);
}
