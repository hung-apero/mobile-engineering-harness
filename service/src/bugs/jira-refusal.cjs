const KEYS = /[A-Z][A-Z0-9]*-\d+/g;
const OUTAGE = /\b(?:401|429|5\d\d)\b|captcha/i;
const REFUSED = /\b40[34]\b|\bissue\b[^.]*\b(?:not found|does not exist)\b|\bforbidden\b|\bnot have permission\b/i;

function isRefused(error) {
  if (error?.name !== 'JiraError' || error.uncertain) return false;
  const text = String(error.message).replace(KEYS, ' ');
  return !OUTAGE.test(text) && REFUSED.test(text);
}

async function isKeyRefusal(jira, project, error) {
  if (!isRefused(error)) return false;
  try {
    return (await jira.search(`project = ${project}`, { limit: 1 })).length > 0;
  } catch {
    return false;
  }
}

module.exports = { isRefused, isKeyRefusal };
