const KEY_BODY = String.raw`(?:[\w+/=:,.\s-]|\\[nrt])*`;
const KEY_HEADER = '-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----';
const KEY_FOOTER = '-----END [A-Z0-9 ]*PRIVATE KEY-----';

const SECRETS = [
  new RegExp(`${KEY_HEADER}(?:${KEY_BODY}?${KEY_FOOTER}|${KEY_BODY})`, 'g'),
  /https?:\/\/[^\s"'\\<>]{0,200}?\/api\/(?:v\d+\/)?webhooks\/[^\s"'\\<>]*/gi,
  /discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/[^\s"'\\<>]*/gi,
  /eyJ[\w-]{5,}\.[\w-]{5,}(?:\.[\w-]*)?/g,
  /(?<![A-Za-z0-9])sk-ant-[\w-]+/g,
  /(?<![A-Za-z0-9])sk-[\w-]{8,}/g,
  /(?<![A-Za-z0-9])gh[pousr]_\w+/g,
  /github_pat_\w+/g,
  /xox[a-z](?:\.xox[a-z])?-[\w-]+/gi,
  /ATATT[\w.+/=-]+/g,
  /AIza[\w-]{20,}/g,
  /(?<![A-Za-z0-9])Bearer\s+[\w.~+/=-]+/gi,
  /(?<![\w.+-])[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g,
];

function redact(text) {
  return SECRETS.reduce((out, pattern) => out.replace(pattern, '[ẩn]'), String(text));
}

function redactJson(value) {
  return JSON.stringify(value, (_, field) => (typeof field === 'string' ? redact(field) : field));
}

function firstLine(error) {
  return redact(String(error?.message ?? error).split('\n')[0]).slice(0, 300);
}

module.exports = { redact, redactJson, firstLine };
