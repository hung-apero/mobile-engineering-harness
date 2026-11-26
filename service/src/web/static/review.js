import { post, say } from './net.js';

const api = `/api${location.pathname}`;
const { sha } = document.getElementById('decide').dataset;
const approve = document.getElementById('approve');
const feedback = document.getElementById('feedback');
const note = document.getElementById('feedback-text');
const quote = document.getElementById('quote');
const buttons = document.querySelectorAll('#decide button');

const lock = value => buttons.forEach(button => { button.disabled = value; });

async function send(form, action, body) {
  const status = form.querySelector('.status');
  lock(true);
  say(status, 'Đang gửi…');
  const result = await post(`${api}/${action}`, body);
  if (result.ok) return location.reload();
  lock(false);
  say(status, result.error, 'bad');
  if (result.code === 'HEDGED') {
    if (!note.value.trim()) note.value = quote.value;
    note.focus();
  }
}

approve.addEventListener('submit', event => {
  event.preventDefault();
  send(approve, 'approve', { sha, quote: quote.value });
});

feedback.addEventListener('submit', event => {
  event.preventDefault();
  send(feedback, 'feedback', { sha, text: note.value });
});

addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
