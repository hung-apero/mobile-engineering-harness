import { post, say } from './net.js';

const form = document.getElementById('defer');
const status = document.getElementById('status');
const button = form.querySelector('button');

form.addEventListener('submit', async event => {
  event.preventDefault();
  const keys = [...form.querySelectorAll('input[name="key"]:checked:not(:disabled)')].map(box => box.value);
  const by = form.elements.by.value.trim();
  if (keys.length === 0) return say(status, 'Hãy chọn ít nhất một bug.', 'bad');
  if (!by) return say(status, 'Hãy nhập tên người hoãn.', 'bad');
  button.disabled = true;
  say(status, 'Đang ghi…');
  const result = await post(`/api/release/${form.dataset.project}/${form.dataset.version}/defer`, { keys, by });
  button.disabled = false;
  if (!result.ok) return say(status, result.error, 'bad');
  say(status, `Đã hoãn ${result.deferred.length} bug.`, 'good');
  setTimeout(() => location.replace('?fresh=1'), 800);
});
