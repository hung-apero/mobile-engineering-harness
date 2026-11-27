const f = require('./formats.cjs');
const { firstLine } = require('../redact.cjs');

const ok = detail => ({ state: 'ok', detail });
const missing = detail => ({ state: 'missing', detail });
const wrong = detail => ({ state: 'wrong', detail });

async function repoEmpty({ app, deps }) {
  if (!app.repo) return missing('dev chưa cung cấp repo');
  if (!f.REPO.test(app.repo)) return wrong('repo phải có dạng owner/name');
  try {
    const refs = await deps.repo.lsRemote(app.repo);
    return refs > 0 ? wrong(`repo đã có ${refs} ref, cần repo trống`) : ok('repo trống');
  } catch (error) {
    return wrong(`không đọc được repo: ${firstLine(error)}`);
  }
}

async function repoWritable({ app, deps }) {
  if (!app.repo) return missing('dev chưa cung cấp repo');
  if (!f.REPO.test(app.repo)) return wrong('repo phải có dạng owner/name');
  try {
    const permissions = await deps.repo.permissions(app.repo);
    return permissions?.push || permissions?.admin ? ok('có quyền ghi') : wrong('máy chủ không có quyền ghi vào repo');
  } catch (error) {
    return wrong(`không đọc được quyền repo: ${firstLine(error)}`);
  }
}

async function jiraProject({ app, deps }) {
  if (!app.jiraProject) return missing('dev chưa cung cấp project Jira');
  if (!f.KEY.test(app.jiraProject)) return wrong('mã project Jira sai định dạng');
  if (app.jiraProject !== app.key) return wrong(`project Jira ${app.jiraProject} phải trùng mã app ${app.key}, vì service theo dõi bug theo mã app`);
  try {
    await deps.jira.search(`project = ${app.jiraProject}`, { limit: 1 });
    return ok(`đọc được ${app.jiraProject}`);
  } catch (error) {
    return wrong(`không đọc được project Jira: ${firstLine(error)}`);
  }
}

module.exports = { 'repo-empty': repoEmpty, 'repo-writable': repoWritable, 'jira-project': jiraProject };
