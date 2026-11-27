const OWN_LABEL = 'claude-fixing';

const nameOf = value => (value && typeof value === 'object' ? value.name : value) ?? null;
const commentsOf = raw => raw?.comment?.comments ?? raw?.comments ?? [];
const isOwn = comment => String(comment?.body ?? '').trimStart().startsWith('[Claude]');

function toIssue(raw) {
  const attachments = raw.attachments ?? raw.attachment ?? [];
  return {
    key: raw.key,
    status: nameOf(raw.status),
    priority: nameOf(raw.priority),
    summary: raw.summary ?? '',
    labels: (raw.labels ?? []).filter(label => label !== OWN_LABEL),
    commentCount: commentsOf(raw).filter(c => !isOwn(c)).length,
    attachmentCount: attachments.length,
  };
}

const loadIssue = async (jira, key) => toIssue(await jira.issue(key));

module.exports = { toIssue, loadIssue, OWN_LABEL };
