const crypto = require('node:crypto');

const normalize = text => String(text).replace(/\r\n/g, '\n').trim();

const hashText = text => crypto.createHash('sha256').update(normalize(text)).digest('hex');

module.exports = { hashText };
