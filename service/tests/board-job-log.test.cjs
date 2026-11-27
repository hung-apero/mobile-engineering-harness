const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const specs = require('../src/specs/store.cjs');
const jobs = require('../src/jobs.cjs');
const tokens = require('../src/board/tokens.cjs');
const { readJobLog } = require('../src/board/job-log.cjs');
const { createWeb } = require('../src/web/server.cjs');
const { makeHome, NOW } = require('./service-fixtures.cjs');
const { send } = require('./web-fixtures.cjs');

const say = text => JSON.stringify({ type: 'assistant', timestamp: '2026-11-25T13:00:00.000Z', message: { content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text }] } });
const tool = (name, input) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
const toolError = text => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: [{ type: 'text', text }] }] } });
const toolOk = () => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } });
const done = () => JSON.stringify({ type: 'result', subtype: 'success', total_cost_usd: 1.234, num_turns: 12 });

function world(t) {
  const h = makeHome(t, ['ABC1', 'XYZ2']);
  const ctx = h.context();
  const logs = path.join(ctx.dzHome, 'logs');
  fs.mkdirSync(logs, { recursive: true });
  const job = (lines, { state = 'running', project = 'ABC1', file = path.join(logs, `${Math.random()}.jsonl`) } = {}) => {
    fs.writeFileSync(file, lines.join(''));
    const { id: specId } = specs.createSpec(ctx.db, { project, title: 'P', source: {} }, NOW);
    const { id } = jobs.enqueue(ctx.db, { project, kind: 'spec', key: `${specId}#build-1`, priority: 1, slots: 1, payload: {} }, NOW);
    ctx.db.prepare('UPDATE jobs SET state = ?, log_file = ? WHERE id = ?').run(state, file, id);
    return { id, specId, file, row: jobs.getJob(ctx.db, id) };
  };
  return { ctx, logs, job };
}

test('stream-json lines become readable rows', t => {
  const s = world(t);
  const { row } = s.job([`${say('Đang so màn chào')}\n`, `${tool('Bash', { command: './gradlew :app:installDebug' })}\n`, `${toolOk()}\n`, `${toolError('BUILD FAILED')}\n`, `${done()}\n`, 'not json\n']);
  const out = readJobLog(s.ctx, row, 0);
  assert.deepEqual(out.lines.map(line => [line.kind, line.text]), [
    ['say', 'Đang so màn chào'], ['tool', 'Bash: ./gradlew :app:installDebug'], ['error', 'BUILD FAILED'], ['result', 'Xong · 1.23 USD · 12 lượt'],
  ]);
  assert.equal(out.lines[0].at, Date.parse('2026-11-25T13:00:00.000Z'));
  assert.equal(out.done, false);
});

test('offset resumes after the last full line', t => {
  const s = world(t);
  const first = `${say('một')}\n`;
  const { row, file } = s.job([first, say('h')]);
  const a = readJobLog(s.ctx, row, 0);
  assert.deepEqual([a.lines.map(line => line.text), a.offset], [['một'], Buffer.byteLength(first)]);
  fs.appendFileSync(file, 'ai\n');
  const b = readJobLog(s.ctx, row, a.offset);
  assert.deepEqual(b.lines.map(line => line.text), []);
  fs.writeFileSync(file, `${first}${say('hai')}\n`);
  assert.deepEqual(readJobLog(s.ctx, row, a.offset).lines.map(line => line.text), ['hai']);
});

test('no offset starts from the tail, and an offset past the end restarts at 0', t => {
  const s = world(t);
  const lines = Array.from({ length: 50 }, (_, i) => `${say(`dòng ${i}`)}\n`);
  const { row } = s.job(lines);
  const tail = readJobLog(s.ctx, row, null, { maxBytes: 600 });
  assert.ok(tail.lines.length > 0 && tail.lines.length < 50);
  assert.equal(tail.lines.at(-1).text, 'dòng 49');
  assert.equal(readJobLog(s.ctx, row, 10 ** 9).lines[0].text, 'dòng 0');
});

test('secrets are redacted and a file outside the logs folder is not read', t => {
  const s = world(t);
  const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
  const { row } = s.job([`${tool('Bash', { command: `curl -H "Authorization: token ${secret}"` })}\n`]);
  assert.ok(!readJobLog(s.ctx, row, 0).lines[0].text.includes(secret));
  const outside = s.job([`${say('bí mật')}\n`], { file: path.join(s.ctx.dzHome, 'outside.jsonl') });
  assert.deepEqual(readJobLog(s.ctx, outside.row, 0).lines, []);
  const finished = s.job([`${done()}\n`], { state: 'done' });
  assert.equal(readJobLog(s.ctx, finished.row, 0).done, true);
});

test('the log route serves only jobs of the viewer project', async t => {
  const s = world(t);
  const mine = s.job([`${say('xin chào')}\n`]);
  const other = s.job([`${say('khác')}\n`], { project: 'XYZ2' });
  const web = createWeb(s.ctx, { facade: s.ctx.facade, port: 0, now: () => NOW });
  const { url } = await web.start();
  t.after(() => web.stop());
  const port = Number(new URL(url).port);
  const get = target => send(port, { url: target });
  const all = tokens.issueViewer(s.ctx.db, { keys: [] }, NOW).token;
  const only = tokens.issueViewer(s.ctx.db, { keys: ['ABC1'] }, NOW).token;
  const res = await get(`/board/${all}/ABC1/job/${mine.id}/log?offset=0`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.json().lines.map(line => line.text), ['xin chào']);
  assert.equal((await get(`/board/${all}/ABC1/job/${other.id}/log`)).status, 404);
  assert.equal((await get(`/board/${only}/XYZ2/job/${other.id}/log`)).status, 404);
  assert.equal((await get(`/board/${all}/ABC1/job/999/log`)).status, 404);
});

test('key=value secrets in commands are hidden', t => {
  const s = world(t);
  const { row } = s.job([`${tool('Bash', { command: './gradlew assembleRelease -Pandroid.injected.signing.store.password=S3cretPass' })}\n`, `${tool('Bash', { command: 'export FIREBASE_TOKEN=1//0abcXYZ && API_KEY: zz99' })}\n`]);
  const text = readJobLog(s.ctx, row, 0).lines.map(line => line.text).join(' ');
  for (const secret of ['S3cretPass', '1//0abcXYZ', 'zz99']) assert.ok(!text.includes(secret), secret);
  assert.match(text, /assembleRelease/);
});
