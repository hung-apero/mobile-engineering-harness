const { test } = require('node:test');
const assert = require('node:assert/strict');
const { summarize } = require('../src/stream-reader.cjs');
const { judgeDead, isSilent, mergeSummary, newestQuota, canResume } = require('../src/verdict.cjs');
const { ev, NOW, MIN } = require('./supervisor-fixtures.cjs');

const judge = (...events) => judgeDead(summarize(events));
const denied = (command, tool_name = 'Bash') => ({ tool_name, tool_use_id: 'u', tool_input: { command } });

test('the last result decides: success then error is not done, error then success is done', () => {
  assert.equal(judge(ev.ok(), ev.bad()).type, 'resume');
  assert.equal(judge(ev.bad(), ev.ok()).type, 'done');
  assert.equal(judge(ev.ok({ is_error: true })).type, 'resume');
  assert.equal(judge(ev.ok({ subtype: 'error_max_turns' })).type, 'resume');
});

test('done keeps text cut to 4000, cost, turns and denials', () => {
  const denials = [denied('curl -H x')];
  const verdict = judge(ev.ok({ result: 'đ'.repeat(5000), permission_denials: denials }));
  assert.equal(verdict.result.text.length, 4000);
  assert.deepEqual({ ...verdict.result, text: '' }, { text: '', costUsd: 0.5, turns: 3, denials: [{ tool_name: 'Bash', command: 'curl' }] });
});

test('a rejected quota wins over denials and errors but not over a successful last result', () => {
  assert.equal(judge(ev.quota('rejected')).type, 'quota');
  assert.equal(judge(ev.quota('rejected'), ev.bad({ permission_denials: [denied('x')] })).type, 'quota');
  assert.equal(judge(ev.quota('rejected'), ev.ok()).type, 'done');
});

test('a quota that was allowed again after a rejection is not X01', () => {
  assert.equal(judge(ev.quota('rejected'), ev.quota('allowed'), ev.bad()).type, 'resume');
});

test('denials with an error park with the blocked commands listed once each', () => {
  const verdict = judge(ev.bad({ permission_denials: [denied('rm -rf /x'), denied('rm /y'), { tool_name: 'Write', tool_input: { file_path: '/a' } }, { tool_name: 'WebFetch' }, null] }));
  assert.equal(verdict.type, 'park');
  assert.equal(verdict.code, 'X03');
  assert.equal(verdict.reason, 'X03: lệnh bị chặn: Bash(rm); Write; WebFetch; ?');
});

test('a resume verdict says why the run failed', () => {
  assert.equal(judge(ev.text(1)).result.error, 'no_result');
  const verdict = judge(ev.bad());
  assert.equal(verdict.result.error, 'error_during_execution');
  assert.equal(verdict.result.text, 'hỏng');
  assert.equal(judge(ev.ok({ is_error: true })).result.error, 'error');
});

test('silence is measured from the last event and reached exactly at the limit', () => {
  const rules = { X02: { silent_minutes: 30 } };
  const job = { startedAt: NOW - 500 * MIN, lastEventAt: NOW - 30 * MIN };
  assert.equal(isSilent(job, rules, NOW), true);
  assert.equal(isSilent(job, rules, NOW - 1), false);
  assert.equal(isSilent({ startedAt: NOW - 31 * MIN, lastEventAt: null }, rules, NOW), true);
});

test('merging chunk summaries equals summarizing everything at once', () => {
  const gone = ev.bad({ errors: ['No conversation found with session ID: 1'] });
  const all = [ev.quota('allowed'), ev.bad({ permission_denials: [denied('a')] }), ev.text(1), ev.tasks('t'), gone, ev.quota('rejected'), ev.ok({ permission_denials: [denied('b')] }), ev.text(2), { type: 'user' }];
  for (let end = 1; end <= all.length; end++) {
    const events = all.slice(0, end);
    const merged = events.map(e => summarize([e])).reduce(mergeSummary, summarize([]));
    assert.deepEqual(merged, summarize(events));
  }
});

test('the newest quota wins; at the same time the stricter one', () => {
  const q = (status, utilization) => ({ status, utilization, resetsAt: 1 });
  assert.equal(newestQuota([]), null);
  assert.deepEqual(newestQuota([{ at: 2, quota: q('allowed', 0.2) }, { at: 1, quota: q('rejected', 0.9) }]), q('allowed', 0.2));
  assert.deepEqual(newestQuota([{ at: 2, quota: q('allowed', 0.2) }, { at: 2, quota: q('allowed', 0.3) }]), q('allowed', 0.3));
  assert.deepEqual(newestQuota([{ at: 2, quota: q('rejected', null) }, { at: 2, quota: q('allowed', 0.9) }]), q('rejected', null));
});

test('only the denials of the last result count for X03', () => {
  assert.equal(judge(ev.bad({ permission_denials: [denied('rm x')] }), ev.bad()).type, 'resume');
  assert.equal(judge(ev.bad({ permission_denials: [denied('rm x')] }), ev.text(1)).type, 'park');
  assert.equal(judge(ev.ok({ permission_denials: [denied('rm x')] }), ev.tasks('t')).type, 'resume');
});

test('a secret in a blocked command never reaches a reason, a result or an action', () => {
  const commands = ['curl -H "Authorization: SECRET"', 'TOKEN=SECRET curl x', 'cat<<<SECRET', '"SECRET" x', '$(echo SECRET)', 'A="b SECRET" c', 'sh\tSECRET'];
  const denials = [...commands.map(c => denied(c)), denied('SECRET', 'Write'), { tool_name: 'WebFetch', tool_input: { url: 'SECRET' } }];
  const verdict = judge(ev.bad({ permission_denials: denials }));
  assert.equal(JSON.stringify(verdict).includes('SECRET'), false);
  assert.deepEqual(verdict.denials.slice(0, 5), [{ tool_name: 'Bash', command: 'curl' }, { tool_name: 'Bash', command: 'TOKEN' }, { tool_name: 'Bash', command: 'cat' }, { tool_name: 'Bash' }, { tool_name: 'Bash' }]);
  assert.equal(JSON.stringify(judge(ev.ok({ permission_denials: denials }))).includes('SECRET'), false);
  assert.equal(JSON.stringify(judge(ev.bad({ permission_denials: denials }), ev.bad())).includes('SECRET'), false);
});

test('a background task still listed or killed by the system makes a success result not done', () => {
  assert.equal(judge(ev.tasks('t'), ev.ok()).type, 'resume');
  assert.equal(judge(ev.tasks('t'), ev.ok()).result.error, 'interrupted');
  assert.equal(judge(ev.ok(), ev.tasks('t')).type, 'resume');
  const killed = system => ev.ok({ subagent_stats: { killed: { parent: 0, user: 0, system } } });
  assert.equal(judge(ev.tasks('t'), ev.tasks(), killed(1)).type, 'resume');
  assert.equal(judge(ev.tasks('t'), ev.tasks(), killed(0)).type, 'done');
});

test('a clean multi-wake log with no task left and two success results is done', () => {
  const init = { type: 'system', subtype: 'init' };
  const verdict = judge(init, ev.text(1), ev.tasks('t'), ev.ok({ result: 'một' }), ev.tasks(), init, ev.text(2), ev.ok({ result: 'hai' }));
  assert.equal(verdict.type, 'done');
  assert.equal(verdict.result.text, 'hai');
});

test('a wake that began after the last success and never ended is not done', () => {
  const init = { type: 'system', subtype: 'init' };
  assert.equal(judge(init, ev.text(1), ev.ok(), init).type, 'resume');
  assert.equal(judge(init, ev.text(1), ev.ok(), ev.text(2)).type, 'resume');
  assert.equal(judge(init, ev.text(1), ev.ok(), { type: 'system', subtype: 'task_updated' }).type, 'done');
});

test('a session is resumable after an assistant event or an earlier resume, never when it is missing', () => {
  const fresh = { resume: false };
  assert.equal(canResume(summarize([ev.text(1)]), fresh), true);
  assert.equal(canResume(summarize([{ type: 'system', subtype: 'init' }]), fresh), false);
  assert.equal(canResume(summarize([]), { resume: true }), true);
  const gone = ev.bad({ errors: ['No conversation found with session ID: 1'] });
  assert.equal(canResume(summarize([ev.text(1), gone]), { resume: true }), false);
  assert.equal(canResume(summarize([ev.bad({ result: 'No conversation found with session ID: 1' })]), { resume: true }), false);
});
