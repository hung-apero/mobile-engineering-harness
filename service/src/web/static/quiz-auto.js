import { post, say } from './net.js';

const OTHER = 'Khác';

function showPicked(form, choice, text) {
  const item = form.closest('.decided');
  const tag = document.createElement('span');
  tag.className = 'tag po';
  tag.textContent = 'PO chọn';
  const picked = document.createElement('span');
  const label = form.querySelector('input:checked').closest('.option').querySelector('.option-text');
  picked.textContent = choice === OTHER ? text : label.textContent.trim();
  item.querySelector('.picked').replaceChildren(tag, ' ', picked);
  item.querySelectorAll('.source').forEach(node => node.remove());
}

export function startAuto(api, round) {
  for (const form of document.querySelectorAll('form[data-auto]')) {
    const text = form.querySelector('textarea');
    const status = form.querySelector('.status');
    const button = form.querySelector('button');
    text.addEventListener('input', () => { form.querySelector(`input[value="${OTHER}"]`).checked = true; });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const choice = form.querySelector('input:checked')?.value;
      if (!choice) return say(status, 'Hãy chọn một câu trả lời.', 'bad');
      button.disabled = true;
      say(status, 'Đang lưu…');
      const result = await post(`${api}/auto`, { qid: form.dataset.auto, choice, text: choice === OTHER ? text.value : '', round });
      button.disabled = false;
      if (!result.ok) return say(status, result.error, 'bad');
      showPicked(form, choice, text.value);
      say(status, 'Đã đổi theo lựa chọn của bạn.', 'good');
    });
  }
}
