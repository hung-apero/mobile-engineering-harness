const wrap = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const wrapped = value => ({ content: [{ type: 'text', text: JSON.stringify({ result: JSON.stringify(value) }) }] });

function createFakeJira({ issues = {}, wrapResult = false, timeoutMs = 50 } = {}) {
  const fake = { issues, calls: [], connects: 0, closes: 0, fail: null, drift: null, timeoutMs };
  const out = wrapResult ? wrapped : wrap;

  function summary(key) {
    const i = issues[key];
    return { key, summary: i.summary ?? key, status: { name: i.status }, priority: { name: i.priority ?? 'High' }, labels: i.labels ?? [], created: '2026-11-20T09:00:00.000+0700', updated: '2026-11-21T09:00:00.000+0700', assignee: i.assignee ?? null };
  }
  const full = key => ({ ...summary(key), description: issues[key].description ?? '', attachments: issues[key].attachments ?? [], comment: { comments: (issues[key].comments ?? []).map(body => ({ id: 'c', body })) } });

  const tools = {
    jira_search: a => {
      const all = Object.keys(issues);
      const start = Number(a.start_at ?? 0);
      const limit = Math.min(Number(a.limit ?? 10), 50);
      return out({ total: all.length, start_at: start, max_results: limit, issues: all.slice(start, start + limit).map(summary) });
    },
    jira_get_issue: a => (issues[a.issue_key] ? out(full(a.issue_key)) : { isError: true, content: [{ type: 'text', text: 'Issue not found' }] }),
    jira_get_transitions: a => out(issues[a.issue_key].transitions ?? []),
    jira_transition_issue: a => {
      const issue = issues[a.issue_key];
      const t = (issue.transitions ?? []).find(x => x.id === a.transition_id);
      if (!t) return { isError: true, content: [{ type: 'text', text: 'bad transition' }] };
      issue.status = t.to_status;
      if (fake.drift === 'assignee') issue.assignee = { displayName: 'Someone Else' };
      return out({ message: 'ok' });
    },
    jira_add_comment: a => {
      (issues[a.issue_key].comments ??= []).push(a.body);
      return out({ id: 'c1' });
    },
    jira_update_issue: a => {
      const f = JSON.parse(a.fields);
      if (f.labels) issues[a.issue_key].labels = f.labels;
      if (fake.drift === 'assignee') issues[a.issue_key].assignee = { displayName: 'Someone Else' };
      return out({ message: 'ok' });
    },
    jira_download_attachments: a => {
      const list = issues[a.issue_key].files ?? [];
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, downloaded: list.length }) }, ...list.map(f => ({ type: 'resource', resource: { uri: `attachment:///${a.issue_key}/${f.name}`, mimeType: 'application/octet-stream', blob: Buffer.from(f.data).toString('base64') } }))] };
    },
  };

  fake.connect = async () => {
    fake.connects += 1;
    return {
      async callTool({ name, arguments: args }) {
        fake.calls.push({ name, args });
        const f = fake.fail;
        if (f && f.name === name && f.times > 0) {
          f.times -= 1;
          if (f.mode === 'dead') throw new Error('Connection closed');
          if (f.mode === 'hang') return new Promise(() => {});
          if (f.mode === 'apply-then-hang') {
            tools[name](args);
            return new Promise(() => {});
          }
        }
        return tools[name](args);
      },
      async close() {
        fake.closes += 1;
      },
    };
  };
  return fake;
}

module.exports = { createFakeJira };
