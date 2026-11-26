const { createClient, parse, JiraError } = require('./jira-client.cjs');
const { saveAttachments } = require('./jira-attachments.cjs');

const PAGE = 50;
const MAX_ISSUES = 200;
const MAX_COMMENT = 8000;
const ISSUE_FIELDS = 'summary,status,priority,labels,created,updated,assignee,description,attachment,comment';
const SEARCH_FIELDS = 'summary,status,priority,labels,created,updated,assignee,attachment';

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const assigneeOf = issue => JSON.stringify(issue?.assignee ?? null);
const commentsOf = issue => issue?.comment?.comments ?? issue?.comments ?? [];

function createJira({ configFile, live, record, connect, timeoutMs }) {
  const client = createClient({ configFile, live, connect, timeoutMs });
  const read = async (name, args) => parse(await client.call(name, args));
  const dry = what => {
    record('would', `jira ${what}`);
    return { dryRun: true };
  };

  const fetchIssue = key => read('jira_get_issue', { issue_key: key, fields: ISSUE_FIELDS, comment_limit: 100 });

  async function issue(key) {
    const raw = await fetchIssue(key);
    const trim = c => ({ ...c, body: String(c.body ?? '').slice(0, MAX_COMMENT) });
    if (raw?.comment?.comments) raw.comment.comments = raw.comment.comments.map(trim);
    if (Array.isArray(raw?.comments)) raw.comments = raw.comments.map(trim);
    return raw;
  }

  async function write(name, args, confirmed) {
    try {
      await client.call(name, args, { write: true });
    } catch (error) {
      if (!error.uncertain) throw error;
      if (!(await confirmed())) throw error;
      return { confirmed: true };
    }
    return {};
  }

  function checkAssignee(before, after) {
    if (assigneeOf(before) !== assigneeOf(after)) throw client.fail('assignee bị đổi sau khi ghi Jira');
  }

  async function transitions(key) {
    const list = await read('jira_get_transitions', { issue_key: key });
    return (Array.isArray(list) ? list : []).map(t => ({
      id: String(t.id),
      name: t.name,
      to_status: t.to_status ?? t.to?.name ?? t.status ?? t.name,
    }));
  }

  async function transition(key, toStatusName) {
    if (!live) return dry(`transition ${key} -> ${toStatusName}`);
    const before = await fetchIssue(key);
    if (same(before.status?.name, toStatusName)) return { status: before.status.name, changed: false };
    const available = await transitions(key);
    const pick = available.find(t => same(t.to_status, toStatusName)) ?? available.find(t => same(t.name, toStatusName));
    if (!pick) throw client.fail(`${key}: không có chuyển trạng thái tới "${toStatusName}" (có: ${available.map(t => t.to_status).join(', ')})`);
    const reached = async () => same((await fetchIssue(key)).status?.name, toStatusName);
    await write('jira_transition_issue', { issue_key: key, transition_id: pick.id }, reached);
    const after = await fetchIssue(key);
    if (!same(after.status?.name, toStatusName)) throw client.fail(`${key}: trạng thái chưa đổi sang "${toStatusName}"`);
    checkAssignee(before, after);
    return { status: after.status.name, changed: true };
  }

  async function comment(key, marker, text) {
    if (!live) return dry(`comment ${key} ${marker}`);
    const carries = async () => commentsOf(await fetchIssue(key)).some(c => String(c.body ?? '').includes(marker));
    if (await carries()) return { skipped: true };
    const head = text.startsWith('[Claude]') ? text : `[Claude] ${text}`;
    const result = await write('jira_add_comment', { issue_key: key, body: `${head}\n\n${marker}` }, carries);
    return { skipped: false, ...result };
  }

  async function changeLabels(key, label, compute) {
    if (!live) return dry(`${label} ${key}`);
    const before = await fetchIssue(key);
    const current = before.labels ?? [];
    const next = compute(current);
    if (next.length === current.length && next.every(l => current.includes(l))) return { labels: current };
    const landed = async () => {
      const got = (await fetchIssue(key)).labels ?? [];
      return got.length === next.length && next.every(l => got.includes(l));
    };
    await write('jira_update_issue', { issue_key: key, fields: JSON.stringify({ labels: next }) }, landed);
    const after = await fetchIssue(key);
    if (!(await landed())) throw client.fail(`${key}: nhãn chưa được ghi`);
    checkAssignee(before, after);
    return { labels: after.labels ?? [] };
  }

  const addLabels = (key, labels) => changeLabels(key, 'addLabels', cur => [...new Set([...cur, ...labels])]);
  const removeLabels = (key, labels) => changeLabels(key, 'removeLabels', cur => cur.filter(l => !labels.includes(l)));

  async function search(jql, { limit = MAX_ISSUES } = {}) {
    const cap = Math.min(limit, MAX_ISSUES);
    const found = [];
    while (found.length < cap) {
      const want = Math.min(PAGE, cap - found.length);
      const page = await read('jira_search', { jql, fields: SEARCH_FIELDS, limit: want, start_at: found.length });
      const issues = page?.issues;
      if (!Array.isArray(issues)) throw new JiraError('Jira trả về trang tìm kiếm không có danh sách issue');
      found.push(...issues);
      if (!issues.length) break;
      if (page.total === -1 || page.total === undefined) {
        if (issues.length < want || found.length >= cap) break;
        throw new JiraError('Jira không báo tổng số kết quả (total -1) mà trang đã đầy, không thể phân trang an toàn');
      }
      if (found.length >= page.total) break;
    }
    return found.slice(0, cap);
  }

  async function attachments(key, dir) {
    return saveAttachments(await client.call('jira_download_attachments', { issue_key: key }), dir);
  }

  const rawCall = (name, args) => read(name, args);

  return { search, issue, transitions, transition, comment, addLabels, removeLabels, attachments, rawCall, close: client.close };
}

module.exports = { createJira, JiraError };
