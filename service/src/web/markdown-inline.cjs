const { esc } = require('./html.cjs');

const TOKEN = /(`{1,3})([^`\n]{1,2000})\1|\[([^[\]\n]{1,500})\]\((https?:\/\/[^\s()]{1,2000})\)|\*\*([^\n]{1,2000}?)\*\*(?!\*)|(https?:\/\/[^\s<>()[\]`*]{1,2000})|\((Q\d{1,6}): [^()\n]{1,200}\)|&lt;br ?\/?&gt;/gi;
const TAIL = /(?:&quot;|&#39;|&gt;|&lt;|[.,;:!?])$/;
const MAX_INLINE = 5000;

const anchor = (href, text) => `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;

function autolink(raw) {
  let href = raw.split(/&(?:quot|lt|gt|#39);/)[0];
  while (TAIL.test(href)) href = href.replace(TAIL, '');
  return anchor(href, href) + raw.slice(href.length);
}

function render(text, kindTag, depth) {
  return text.replace(TOKEN, (match, tick, code, label, href, bold, url, qid) => {
    if (tick) return `<code>${code}</code>`;
    if (href) return /&(?:quot|lt|gt|#39);/.test(href) ? match : anchor(href, label);
    if (bold) return depth > 2 ? match : `<strong>${render(bold, kindTag, depth + 1)}</strong>`;
    if (url) return autolink(url);
    if (qid) {
      const badge = kindTag(qid);
      return badge ? `${match} ${badge}` : match;
    }
    return '<br>';
  });
}

function inline(source, kindTag = () => '') {
  const text = esc(source);
  return text.length > MAX_INLINE ? text : render(text, kindTag, 0);
}

module.exports = { inline };
