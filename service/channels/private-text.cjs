const BOT_TOKEN = /(?<![\w-])[\w-]{23,30}\.[\w-]{5,8}\.[\w-]{25,}/g;
const LINKS = [/[?&]t=[\w%.~-]+/gi, /\/(?:quiz|review)\/[\w-]{16,}/gi];
const PATTERNS = [BOT_TOKEN, ...LINKS];

const scrub = text => PATTERNS.reduce((out, pattern) => out.replace(pattern, '[ẩn]'), String(text));

module.exports = { scrub };
