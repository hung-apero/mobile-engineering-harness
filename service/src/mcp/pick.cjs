const { DeskError } = require('./desk-error.cjs');
const { splitUrls } = require('./spec-text.cjs');
const { firstPost, newerUsed } = require('../inbox.cjs');
const { snowflakeTime } = require('../discord-bot.cjs');

const KINDS = {
  review: { state: 'review', name: 'bản chờ duyệt', version: view => view.sha, closed: view => Boolean(view.approved) },
  quiz: { state: 'quiz', name: 'quiz đang mở', version: view => view.round, closed: view => Boolean(view.submitted) },
};

const KEY_WORD = /(?<![\p{L}\p{N}_])[A-Z][A-Z0-9]+(?![\p{L}\p{N}_])/gu;

const choose = message => new DeskError('CHOOSE', message);
const list = value => (Array.isArray(value) ? value : []);

function keysIn(text, projects) {
  const words = new Set(splitUrls(text).words.match(KEY_WORD) ?? []);
  return [...projects.keys()].filter(key => words.has(key));
}

function pickProject({ candidates, text }, post, projects) {
  const named = keysIn(text, projects);
  if (named.some(key => !candidates.some(project => project.key === key))) throw new DeskError('REFUSED', 'Tin nhắc tới project của kênh khác.');
  if (post) {
    const project = candidates.find(item => item.key === post.project);
    if (!project) throw new DeskError('REFUSED', 'Tin được trả lời không thuộc project của kênh này.');
    if (named.some(key => key !== project.key)) throw choose(`Tin trả lời bản của ${project.key} nhưng lại nhắc project khác. Hãy nói rõ project nào.`);
    return project;
  }
  const wanted = named.length > 0 ? candidates.filter(project => named.includes(project.key)) : candidates;
  if (wanted.length !== 1) throw choose(`Kênh này có nhiều project (${candidates.map(p => p.key).join(', ')}). Hãy gửi tin mới có đúng một mã project.`);
  return wanted[0];
}

async function onlyOpen({ facade }, kind, project) {
  const open = list(await facade.openSpecs(project.key, KINDS[kind].state));
  if (open.length === 0) throw new DeskError('STATE', `${project.key} không có ${KINDS[kind].name}.`);
  if (open.length > 1) throw choose(`${project.key} có ${open.length} ${KINDS[kind].name}. Hãy trả lời trực tiếp vào tin của bản muốn chọn.`);
  return open[0].id;
}

function checkFresh({ db }, kind, specId, version, updatedAt, messageId) {
  const first = firstPost(db, { specId, kind, version });
  const fresh = first ? BigInt(messageId) > BigInt(first.messageId) : snowflakeTime(messageId) > (Number.isFinite(updatedAt) ? updatedAt : Infinity);
  if (!fresh) throw new DeskError('STALE', `Tin này gửi trước ${KINDS[kind].name}. Hãy gửi một tin mới.`);
}

function checkPost(post, kind, { channelId, replyTo }) {
  if (!replyTo) return;
  if (!post || post.kind !== kind || post.channelId !== channelId) throw choose(`Tin này trả lời một tin khác. Hãy trả lời đúng tin của ${KINDS[kind].name}.`);
}

async function pickSpec(deps, kind, { project, post, message, now }) {
  const specId = post ? post.specId : await onlyOpen(deps, kind, project);
  const view = await deps.facade[kind](specId);
  const { state, version: versionOf, closed, name } = KINDS[kind];
  if (view?.spec?.project !== project.key) throw new DeskError('REFUSED', 'Spec này thuộc project khác.');
  if (view.spec.state !== state || closed(view)) throw new DeskError('STATE', `${project.key} không có ${name}.`);
  const version = versionOf(view);
  if (version === undefined || version === null || version === '') throw new DeskError('STATE', 'Không rõ phiên bản của spec.');
  if (post && post.version !== String(version)) throw new DeskError('STALE', 'Spec đã có bản mới hơn tin được trả lời. Hãy trả lời vào tin của bản mới.');
  if (!post) checkFresh(deps, kind, specId, version, view.spec.updatedAt, message.messageId);
  if (newerUsed(deps.db, specId, message.messageId)) throw new DeskError('STALE', 'Đã ghi một tin mới hơn cho spec này. Hãy gửi một tin mới.');
  return { specId, view, version };
}

module.exports = { pickProject, checkPost, pickSpec };
