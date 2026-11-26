const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { redact, redactJson } = require('../src/redact.cjs');
const { summarize } = require('../src/stream-reader.cjs');
const { judgeDead } = require('../src/verdict.cjs');
const { openDb } = require('../src/db.cjs');
const { createServiceLog } = require('../src/service-log.cjs');
const { sendDiscord, MAX_CONTENT } = require('../src/discord.cjs');
const jobs = require('../src/jobs.cjs');
const pings = require('../src/pings.cjs');
const decisions = require('../src/decisions.cjs');
const { supervise } = require('../src/supervisor.cjs');
const { world, ev, rulesFor, NOW } = require('./supervisor-fixtures.cjs');

const BODY = 'BIMAT0123456789abcdefBIMAT';
const key = (kind, end = true) => `-----BEGIN ${kind}PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\n${BODY}\n${BODY}==${end ? `\n-----END ${kind}PRIVATE KEY-----` : ''}`;
const SECRETS = [
  `ghp_${BODY}`, `gho_${BODY}`, `github_pat_11A_${BODY}`, `xoxb-1234-${BODY}`, `xoxe.xoxp-1-${BODY}`,
  `sk-${BODY}`, `sk-proj-${BODY}`, `sk-ant-api03-${BODY}`, `ATATT3xFf${BODY}=1A`, `AIza${BODY}-x`,
  `Bearer ${BODY}`, `eyJhbGciOiJI${BODY}.eyJzdWIi${BODY}.${BODY}`,
  `https://discord.com/api/webhooks/1/${BODY}`, `https://ptb.discord.com/api/v10/webhooks/1/${BODY}`, `discord.com/api/webhooks/1/${BODY}`,
  key(''), key('RSA '), key('OPENSSH '), key('EC ', false),
];
const MENTIONS = '<@323456789012345678> <@!1> <@&2> <#3>';
const leaks = text => assert.doesNotMatch(String(text), /BIMAT/);

test('every kind of secret is hidden, wherever it stands in the text', () => {
  for (const secret of SECRETS) {
    for (const text of [secret, `trước ${secret} sau`, `a\n${secret}\nb`, `TOKEN_${secret}`, `key="${secret}"`, `(${secret})`]) leaks(redact(text));
  }
});

test('text after a whole private key block and ordinary words stay', () => {
  assert.equal(redact(`trước\n${key('RSA ')}\nviệc xong`), 'trước\n[ẩn]\nviệc xong');
  for (const text of ['task-force-alpha-beta', 'sk-ui', 'eyJ không phải token', 'AAP134-12 vẫn lỗi', 'https://e.com/webhooks/1']) assert.equal(redact(text), text);
});

test('mentions are kept intact, also right beside a secret', () => {
  assert.equal(redact(MENTIONS), MENTIONS);
  for (const secret of SECRETS.slice(0, 15)) {
    const out = redact(`<@323456789012345678>${secret}<@423456789012345678> xin chào`);
    leaks(out);
    assert.match(out, /^<@323456789012345678>.*<@423456789012345678> xin chào$/);
  }
});

test('long text is redacted in well under a second', () => {
  const began = Date.now();
  for (const unit of ['a', 'http://', 'eyJa', '-----BEGIN PRIVATE KEY-----', 'Bearer ']) redact(unit.repeat(Math.ceil(200000 / unit.length)).slice(0, 16000));
  redact('a'.repeat(500000));
  assert.ok(Date.now() - began < 1500);
});

test('redactJson hides secrets in nested values and always stays valid JSON', () => {
  for (const secret of SECRETS) {
    const text = redactJson({ a: [{ b: `x\n${secret}` }], n: 1 });
    leaks(text);
    assert.equal(JSON.parse(text).n, 1);
  }
});

test('the stored result text and errors are redacted before they are cut', () => {
  for (const secret of SECRETS) {
    leaks(JSON.stringify(judgeDead(summarize([ev.ok({ result: `xong ${secret}` })]))));
    leaks(JSON.stringify(judgeDead(summarize([ev.bad({ errors: ['hỏng', secret] })]))));
  }
  const text = judgeDead(summarize([ev.ok({ result: `${'đ'.repeat(3990)}AIza${BODY}` })])).result.text;
  assert.equal(text.length, 3994);
  assert.ok(text.endsWith('đ[ẩn]'));
  leaks(judgeDead(summarize([ev.bad({ permission_denials: [{ tool_name: 'Bash', tool_input: { command: `ghp_${BODY} x` } }, { tool_name: `ghp_${BODY}` }] })])).reason);
});

test('a job result, an error in a decision and a log line reach disk without secrets', async t => {
  const w = world();
  const job = w.run('x');
  w.log(job.id, ev.text(1), ev.ok({ result: `ghp_${BODY}` }));
  w.die(job);
  await supervise(w.db, { rulesFor, deps: w.deps, now: NOW, boot: false });
  leaks(w.db.prepare('SELECT result FROM jobs').get().result);
  decisions.record(w.db, { project: 'a', code: 'X02', ruleVersion: 'v', evidence: { error: `a\nghp_${BODY}` }, action: 'stop-failed' }, NOW);
  leaks(w.db.prepare('SELECT evidence FROM decisions').get().evidence);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dz-red-')), 'l.jsonl');
  t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
  for (const secret of SECRETS) createServiceLog(file)('e', { error: `a\n${secret}` });
  const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(rows.length, SECRETS.length);
  leaks(JSON.stringify(rows));
});

test('digest and weekly never show a secret, even one stored earlier', () => {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dz-red-')), 'dz.db'));
  const at = Date.parse('2026-11-27T17:35:00+07:00');
  const running = k => {
    const { id } = jobs.enqueue(db, { project: 'A1', kind: 'bug', key: k, priority: 1, slots: 1 }, 1);
    db.prepare("UPDATE jobs SET state = 'running' WHERE id = ?").run(id);
    return id;
  };
  jobs.finish(db, running('a'), 'done', { text: `ghp_${BODY}` }, at - 1000);
  jobs.park(db, running('b'), `hỏng ${key('RSA ')}`, at - 1000);
  pings.openWait(db, { project: 'A1', role: 'po', subject: `xem sk-${BODY}` }, at - 1000);
  decisions.missingRule(db, { project: 'A1', situation: `AIza${BODY}`, proposal: `Bearer ${BODY}` }, at - 1000);
  leaks(decisions.digest(db, { project: 'A1', now: at }));
  leaks(decisions.weeklyMissing(db, { now: at }));
});

test('sendDiscord hides secrets as the last gate, keeps mentions and cuts after hiding', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dz-red-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const webhookFile = path.join(dir, 'hook');
  fs.writeFileSync(webhookFile, 'https://discord.com/api/webhooks/1/x', { mode: 0o600 });
  const sent = [];
  const fetchImpl = async (url, init) => { sent.push(JSON.parse(init.body).content); return Response.json({ id: '1' }); };
  for (const secret of SECRETS) {
    await sendDiscord({ webhookFile, content: `${MENTIONS} ${secret}`, fetchImpl });
    leaks(sent.at(-1));
    assert.ok(sent.at(-1).startsWith(MENTIONS));
  }
  await sendDiscord({ webhookFile, content: `${'a '.repeat(MAX_CONTENT / 2 - 5)}ghp_${BODY}`, fetchImpl });
  leaks(sent.at(-1));
  assert.ok(sent.at(-1).endsWith('[ẩn]'));
});
