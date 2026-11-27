import { post, say } from './net.js';

const form = document.getElementById('spec');
const status = document.getElementById('status');
const button = form.querySelector('button');

form.addEventListener('submit', async event => {
  event.preventDefault();
  button.disabled = true;
  say(status, 'Đang gửi…');
  const result = await post('/api/spec/new', Object.fromEntries(new FormData(form)));
  button.disabled = false;
  if (!result.ok) return say(status, result.error, 'bad');
  form.reset();
  say(status, `Đã nhận spec${result.id ? ` số ${result.id}` : ''}. Xem tiến độ ở trang trạng thái.`, 'good');
});
