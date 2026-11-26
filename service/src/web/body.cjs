const { WebError } = require('./web-error.cjs');

const MAX_BODY = 64 * 1024;
const MAX_DRAIN = 1024 * 1024;

function collect(req, res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let refused = false;
    const refuse = () => {
      if (refused) return;
      refused = true;
      res.setHeader('connection', 'close');
      reject(new WebError(413, 'TOO_LARGE'));
    };
    if (Number(req.headers['content-length']) > MAX_BODY) refuse();
    req.on('data', chunk => {
      size += chunk.length;
      if (size <= MAX_BODY) {
        chunks.push(chunk);
        return;
      }
      chunks.length = 0;
      refuse();
      if (size > MAX_DRAIN) req.destroy();
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
    req.on('close', () => reject(new WebError(400, 'TYPE')));
  });
}

async function readJson(req, res) {
  const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw new WebError(415, 'TYPE');
  const text = await collect(req, res);
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new WebError(400, 'TYPE');
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new WebError(400, 'TYPE');
  return data;
}

module.exports = { readJson, MAX_BODY };
