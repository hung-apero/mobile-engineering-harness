const MAX_CELLS = 16 * 1000 * 1000;

const entry = type => text => ({ type, text });

function lcs(a, b) {
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] = a[i] === b[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const out = [];
  let [i, j] = [0, 0];
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push(entry('same')(a[i]));
      i++;
      j++;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) out.push(entry('del')(a[i++]));
    else out.push(entry('add')(b[j++]));
  }
  return [...out, ...a.slice(i).map(entry('del')), ...b.slice(j).map(entry('add'))];
}

function lineDiff(before, after) {
  const a = String(before ?? '').replace(/\r\n?/g, '\n').split('\n');
  const b = String(after ?? '').replace(/\r\n?/g, '\n').split('\n');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a.at(-1 - tail) === b.at(-1 - tail)) tail++;
  const [midA, midB] = [a.slice(head, a.length - tail), b.slice(head, b.length - tail)];
  const middle = midA.length * midB.length > MAX_CELLS ? [...midA.map(entry('del')), ...midB.map(entry('add'))] : lcs(midA, midB);
  return [...a.slice(0, head).map(entry('same')), ...middle, ...a.slice(a.length - tail).map(entry('same'))];
}

module.exports = { lineDiff };
