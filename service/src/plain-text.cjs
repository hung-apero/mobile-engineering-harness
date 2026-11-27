const GAP = '\u200b';

function plainText(text) {
  return text.replace(/<(?=[@#])/g, `<${GAP}`).replace(/\](?=\()/g, `]${GAP}`);
}

module.exports = { plainText };
