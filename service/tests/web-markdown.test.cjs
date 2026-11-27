const test = require('node:test');
const assert = require('node:assert/strict');
const { renderMarkdown } = require('../src/web/markdown.cjs');
const { changedLines } = require('../src/web/diff-lines.cjs');

test('headings start one level below the page title', () => {
  assert.equal(renderMarkdown('# Một\n### Ba #\n###### Sáu'), '<h2>Một</h2>\n<h4>Ba</h4>\n<h6>Sáu</h6>');
});

test('paragraphs keep their line breaks', () => {
  assert.equal(renderMarkdown('a\nb\n\nc'), '<p>a<br>b</p>\n<p>c</p>');
});

test('everything is escaped first', () => {
  assert.equal(renderMarkdown('<img src=x onerror="a"> & \''), '<p>&lt;img src=x onerror=&quot;a&quot;&gt; &amp; &#39;</p>');
  assert.equal(renderMarkdown('`<b>`'), '<p><code>&lt;b&gt;</code></p>');
  assert.equal(renderMarkdown('```js\n<b> **x**\n```'), '<pre tabindex="0"><code>&lt;b&gt; **x**</code></pre>');
});

test('bold and code do not mix', () => {
  assert.equal(renderMarkdown('**a `b` c** `**d**`'), '<p><strong>a <code>b</code> c</strong> <code>**d**</code></p>');
});

test('only http and https links become links', () => {
  const link = renderMarkdown('[x](https://a.b/c?d=1&e=2)');
  assert.equal(link, '<p><a href="https://a.b/c?d=1&amp;e=2" target="_blank" rel="noopener noreferrer">x</a></p>');
  for (const bad of ['[x](javascript:alert(1))', '[x](data:text/html,a)', '[x](//evil)', '[x](vbscript:a)', '[x](JaVaScRiPt:a)']) {
    assert.doesNotMatch(renderMarkdown(bad), /<a /, bad);
  }
  assert.match(renderMarkdown('xem https://a.b/c.'), /<a href="https:\/\/a\.b\/c"[^>]*>https:\/\/a\.b\/c<\/a>\.<\/p>/);
  for (const bad of ['https://a.b/"onmouseover="x', '[x](https://a" onclick="b)', '[x](https://a"onclick="b)']) {
    assert.doesNotMatch(renderMarkdown(bad), /" ?on\w+=/, bad);
  }
});

test('lists nest by indent and keep continuation lines', () => {
  const html = renderMarkdown('- a\n  - b\n  - c\n    tiếp\n- d\n\n1. x\n2. y');
  assert.equal(html, '<ul><li>a<ul><li>b</li><li>c<br>tiếp</li></ul></li><li>d</li></ul>\n<ol><li>x</li><li>y</li></ol>');
});

test('an ordered list keeps its first number', () => {
  assert.equal(renderMarkdown('3. c\n4. d'), '<ol start="3"><li>c</li><li>d</li></ol>');
});

test('tables render with a head, escaped pipes and missing cells', () => {
  const html = renderMarkdown('| A | B |\n|---|:-:|\n| a \\| b | `c` |\n| d |');
  assert.match(html, /^<div class="table" tabindex="0" role="region" aria-label="Bảng"><table>/);
  assert.match(html, /<th scope="col">A<\/th><th scope="col">B<\/th>/);
  assert.match(html, /<td>a \| b<\/td><td><code>c<\/code><\/td>/);
  assert.match(html, /<td>d<\/td><td><\/td>/);
});

test('quotes, rules and line break tags render', () => {
  assert.equal(renderMarkdown('> a\n> b\n\n---\n\nx<br/>y'), '<blockquote><p>a<br>b</p></blockquote>\n<hr>\n<p>x<br>y</p>');
});

test('changed lines are marked on their own block only', () => {
  const md = 'giữ\n\nmới\n\n- a\n- b mới\n\n| A |\n|---|\n| c |\n| d mới |';
  const html = renderMarkdown(md, { changed: new Set([2, 5, 10]) });
  assert.match(html, /<p>giữ<\/p>/);
  assert.match(html, /<p class="changed"><ins>mới<\/ins><\/p>/);
  assert.match(html, /<li>a<\/li><li class="changed"><ins>b mới<\/ins><\/li>/);
  assert.match(html, /<tr><td>c<\/td><\/tr><tr class="changed"><td><ins>d mới<\/ins><\/td><\/tr>/);
});

test('unclosed and odd input never throws', () => {
  for (const text of ['```\nabc', '**', '[', '[x](', '|', '|-|', '- ', '#', '', null, undefined, '>'.repeat(5000), '  '.repeat(50) + '- x']) {
    assert.equal(typeof renderMarkdown(text), 'string');
  }
});

test('a large hostile document renders quickly', () => {
  const started = Date.now();
  for (const unit of ['[', '**', '`', '((Q1:', '[x](http://', '| ', 'http://', '> ']) renderMarkdown(unit.repeat(20000));
  renderMarkdown('- a\n'.repeat(20000));
  assert.ok(Date.now() - started < 3000, `${Date.now() - started} ms`);
});

test('changed lines follow the diff by position, not by equal text', () => {
  const diff = [{ type: 'same', text: 'x' }, { type: 'add', text: 'x' }, { type: 'del', text: 'y' }, { type: 'same', text: 'z\nt' }];
  assert.deepEqual([...changedLines('x\nx\nz\nt', diff)], [1]);
});

test('a diff that does not line up falls back to equal lines and an all-new text marks nothing', () => {
  assert.deepEqual([...changedLines('a\nb\n\nc', [{ type: 'same', text: 'a' }, { type: 'add', text: ' b ' }, { type: 'add', text: '' }])], [1]);
  assert.deepEqual([...changedLines('a\nb', [{ type: 'add', text: 'a\nb' }])], []);
  assert.deepEqual([...changedLines('a', undefined)], []);
});

test('very long lines stay linear (M2)', () => {
  const gap = ' '.repeat(200000);
  for (const md of [`# a${gap}b`, `# ${gap}#`, `| a |\n|${gap}x`, `| a |\n|-${gap}-|`, `- ${gap}x`, `> ${gap}#`, `| a |\n|---|\n|${gap}|`, `${'**a '.repeat(50000)}`, '#'.repeat(200000), '-'.repeat(200000), `${'|-'.repeat(100000)}x`]) {
    const start = process.hrtime.bigint();
    renderMarkdown(`${md}\n`.repeat(3));
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    assert.ok(ms < 1500, `${md.slice(0, 12)} ${ms}`);
  }
});

test('headings and table rules keep their rules, a very long line keeps all its text', () => {
  assert.match(renderMarkdown(`# ${'x'.repeat(6000)}<b>**`), /^<h2>x{6000}&lt;b&gt;\*\*<\/h2>$/);
  assert.equal(renderMarkdown('# Tiêu đề ##  '), '<h2>Tiêu đề</h2>');
  assert.equal(renderMarkdown('# C#'), '<h2>C#</h2>');
  assert.match(renderMarkdown('| A |\n| :-: |\n| c |'), /<th scope="col">A<\/th>/);
  for (const rule of ['| - - |', '| x |', '|', '| |', '---']) assert.doesNotMatch(renderMarkdown(`| A |\n${rule}`), /<table>/, rule);
});
