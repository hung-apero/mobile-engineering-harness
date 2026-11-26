const OFFLINE = 'Không kết nối được. Hãy kiểm tra mạng rồi thử lại.';

async function call(url, options) {
  try {
    const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...options });
    const data = await response.json();
    return { status: response.status, ...data };
  } catch {
    return { status: 0, ok: false, error: OFFLINE };
  }
}

export const post = (url, body, keepalive = false) => call(url, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), keepalive,
});

export const load = url => call(url, {});

export function say(node, text, kind = '') {
  node.textContent = text;
  node.classList.toggle('bad', kind === 'bad');
  node.classList.toggle('good', kind === 'good');
}
