const { MAX_CONTENT } = require('./discord.cjs');
const { redact } = require('./redact.cjs');
const { plainText } = require('./plain-text.cjs');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const OFFSET = 7 * HOUR;
const WORK_MINUTES_PER_DAY = 540;
const MAX_BULLETS = 15;
const MAX_SUBJECT = 200;
const MAX_LINK = 300;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;
const HTTP_LINK = /^https?:\/\/[^\s<>]+$/i;

function workedMinutes(from, to) {
  if (to <= from) return 0;
  const start = from + OFFSET;
  const end = to + OFFSET;
  let total = 0;
  for (let day = start - (((start % DAY) + DAY) % DAY); day < end; day += DAY) {
    const weekday = new Date(day).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    const from9 = Math.max(start, day + 9 * HOUR);
    const to18 = Math.min(end, day + 18 * HOUR);
    if (to18 > from9) total += to18 - from9;
  }
  return Math.floor(total / MINUTE);
}

function waitingText(openedAt, now) {
  const minutes = workedMinutes(openedAt, now);
  const days = Math.floor(minutes / WORK_MINUTES_PER_DAY);
  const hours = Math.floor((minutes % WORK_MINUTES_PER_DAY) / 60);
  const parts = [];
  if (days > 0) parts.push(`${days} ngày làm việc`);
  if (hours > 0) parts.push(`${hours} giờ`);
  return parts.length ? parts.join(' ') : 'dưới 1 giờ';
}

function cleanSubject(subject) {
  const flat = redact(subject).replace(CONTROL, ' ').replace(/ {2,}/g, ' ').trim();
  return Array.from(flat).slice(0, MAX_SUBJECT).join('');
}

function cleanLink(link) {
  return typeof link === 'string' && link.length <= MAX_LINK && HTTP_LINK.test(link) ? link : null;
}

function bullet(wait, now) {
  const link = cleanLink(wait.link);
  const subject = cleanSubject(wait.subject);
  return plainText(`• ${subject}${link ? ` ${link}` : ''} — chờ ${waitingText(wait.opened_at, now)}`);
}

function buildContent({ mentions, projectKey, waits, now }) {
  const tags = mentions.map(id => `<@${id}>`).join(' ');
  const header = `${tags} dự án ${projectKey}: ${waits.length} việc đang chờ bạn`;
  const bullets = waits.map(wait => bullet(wait, now));
  for (let shown = Math.min(MAX_BULLETS, bullets.length); shown >= 0; shown--) {
    const lines = [header, ...bullets.slice(0, shown)];
    if (bullets.length > shown) lines.push(`… và ${bullets.length - shown} việc nữa`);
    const text = lines.join('\n');
    if (text.length <= MAX_CONTENT) return text;
  }
  return header.slice(0, MAX_CONTENT);
}

module.exports = { buildContent, workedMinutes };
