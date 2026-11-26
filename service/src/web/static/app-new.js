import { post, say } from './net.js';

const form = document.getElementById('app');
const status = document.getElementById('status');
const check = document.getElementById('check');

form.addEventListener('submit', async event => {
  event.preventDefault();
  say(status, 'Đang lưu…');
  const result = await post('/api/app/new', Object.fromEntries(new FormData(form)));
  if (!result.ok) return say(status, result.error, 'bad');
  location.assign(`/app/new?key=${encodeURIComponent(result.key)}`);
});

if (check) {
  check.addEventListener('click', async () => {
    check.disabled = true;
    const result = await post('/api/app/new/check', { key: check.dataset.key });
    if (!result.ok) {
      check.disabled = false;
      return say(status, result.error, 'bad');
    }
    location.reload();
  });
}
