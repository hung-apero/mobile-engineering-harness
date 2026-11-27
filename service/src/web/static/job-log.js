import { load, post } from './net.js';

const EVERY_MS = 2000;
const MAX_ROWS = 400;

const clock = at => (Number.isFinite(at) ? new Date(at).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '');

function addRows(box, lines) {
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  box.querySelector('.empty')?.remove();
  for (const line of lines) {
    const row = document.createElement('p');
    row.className = `log-row ${line.kind}`;
    const time = document.createElement('span');
    time.className = 'log-time';
    time.textContent = clock(line.at);
    row.append(time, document.createTextNode(` ${line.text}`));
    box.append(row);
  }
  while (box.children.length > MAX_ROWS) box.firstElementChild.remove();
  if (atBottom) box.scrollTop = box.scrollHeight;
}

async function follow(box) {
  const status = box.parentElement.querySelector('.job-status');
  let offset = null;
  for (;;) {
    const res = await load(offset === null ? box.dataset.log : `${box.dataset.log}?offset=${offset}`);
    if (res.ok) {
      addRows(box, res.lines);
      offset = res.offset;
      if (!box.children.length) box.innerHTML = '<p class="empty">Chưa có dòng log nào.</p>';
      if (res.done) {
        if (status) status.textContent = 'Job đã dừng.';
        return;
      }
    } else if (status) status.textContent = res.error ?? 'Không đọc được log.';
    await new Promise(resolve => setTimeout(resolve, EVERY_MS));
  }
}

const ASK = { pause: 'Tạm dừng việc này? Bấm Chạy để chạy tiếp đúng chỗ.', stop: 'Dừng việc này? Bấm Chạy sẽ chạy lại đoạn này từ đầu.' };

function showResult(res) {
  const box = document.querySelector('.job-result') ?? document.createElement('div');
  box.className = 'notice job-result';
  box.setAttribute('role', 'status');
  box.textContent = res.ok ? res.message : res.error ?? 'Không làm được.';
  if (res.takeover) {
    const code = document.createElement('code');
    code.textContent = res.takeover;
    box.append(document.createElement('br'), 'Mở phiên này ở chế độ tương tác: ', code);
  }
  document.querySelector('main').prepend(box);
}

document.addEventListener('click', async event => {
  const button = event.target.closest('[data-job-action]');
  if (!button) return;
  const { jobAction: action, jobId: id } = button.dataset;
  if (ASK[action] && !window.confirm(ASK[action])) return;
  for (const other of document.querySelectorAll('[data-job-action]')) other.disabled = true;
  const res = await post(`/api/job/${id}/${action}`, {});
  showResult(res);
  if (res.ok && !res.takeover) setTimeout(() => window.location.reload(), 1500);
  else for (const other of document.querySelectorAll('[data-job-action]')) other.disabled = false;
});

for (const box of document.querySelectorAll('[data-log]')) follow(box);
