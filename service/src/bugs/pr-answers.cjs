const kv = require('../kv.cjs');
const store = require('./store.cjs');
const { runGh } = require('./git.cjs');
const { commentPr } = require('./publish.cjs');
const { log, pages } = require('./pr-api.cjs');

const textFor = commit => `[Claude] Đã sửa theo góp ý này, commit ${commit.slice(0, 12)}, đã vào bản build mới.`;

async function isPosted(ctx, project, note, body) {
  if (note.kind === 'inline') return (await pages(ctx, project, `pulls/${note.pr}/comments`)).some(row => row?.body === body && row.in_reply_to_id === note.commentId);
  return (await pages(ctx, project, `issues/${note.pr}/comments`)).some(row => row?.body === body);
}

async function postReply(ctx, project, note, body) {
  const gh = ctx.bugs.gh ?? runGh;
  if (note.kind === 'inline') await gh(['api', '--method', 'POST', `repos/${project.repo}/pulls/${note.pr}/comments/${note.commentId}/replies`, '-f', `body=${body}`], { cwd: ctx.dzHome });
  else await commentPr({ dzHome: ctx.dzHome, project, number: note.pr, body, live: true, record: () => {}, gh });
}

async function answerOne(ctx, project, batch, id, now) {
  const note = kv.get(ctx.db, id);
  const lane = (batch.data.lanes ?? []).find(item => note?.keys?.some(key => item.keys.includes(key)));
  if (note?.state !== 'queued' || !lane) return;
  const body = textFor(lane.commit);
  if (!(note.tried && await isPosted(ctx, project, note, body))) {
    kv.set(ctx.db, id, { ...note, tried: true }, now);
    await postReply(ctx, project, note, body);
  }
  kv.set(ctx.db, id, { ...note, tried: true, state: 'answered', batchId: batch.id }, now);
  log(ctx, project, 'replied', { commentId: note.commentId, commit: lane.commit }, now);
}

async function answerNotes(ctx, project, batch, now) {
  if (project.live !== true || !batch?.data.delivered || !batch.data.prNotes) return;
  let failure = null;
  for (const id of batch.data.prNotes) await answerOne(ctx, project, batch, id, now).catch(error => { failure ??= error; });
  if (failure) throw failure;
}

async function retryAnswers(ctx, project, version, now) {
  for (const batch of store.listBatches(ctx.db, { project: project.key, version: version.version, states: ['done'] })) await answerNotes(ctx, project, batch, now);
}

module.exports = { answerNotes, retryAnswers };
