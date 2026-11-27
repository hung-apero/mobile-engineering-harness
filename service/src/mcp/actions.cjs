const inbox = require('../inbox.cjs');
const { discordLive } = require('../discord-live.cjs');
const { firstLine } = require('../redact.cjs');
const { DeskError, isDefinite } = require('./desk-error.cjs');
const { readMessage, requirePo, requireTeam } = require('./verify.cjs');
const { pickProject, checkPost, pickSpec } = require('./pick.cjs');
const { readApproval } = require('./approval-text.cjs');
const { readAnswers } = require('./answer-text.cjs');
const { readSpec } = require('./spec-text.cjs');

const byOf = message => `discord:${message.authorId}`;
const list = value => (Array.isArray(value) ? value : []);

function checkUnused(db, messageId) {
  const row = inbox.rowOf(db, messageId);
  if (row?.action) throw new DeskError('USED', `Tin này đã được dùng (${row.action}${row.outcome ? `: ${row.outcome}` : ', không rõ kết quả'}).`);
}

async function open(deps, args, now, { kind = null, allowEdited = true, check = requirePo } = {}) {
  checkUnused(deps.db, args.message_id);
  const message = await readMessage(deps, args, now, { allowEdited });
  if (inbox.record(deps.db, message.raw, message.channelId, now).channelId !== message.channelId) throw new DeskError('REFUSED', 'Tin đã ghi ở kênh khác.');
  const post = kind && message.replyTo ? inbox.postOf(deps.db, message.replyTo) : null;
  if (kind) checkPost(post, kind, message);
  const project = pickProject(message, post, deps.projects());
  await check(deps, message, project);
  return { message, post, project };
}

async function useOnce(deps, message, { action, specId }, now, work) {
  if (!inbox.claim(deps.db, message.messageId, { action, specId }, now)) throw new DeskError('USED', 'Tin này đã được dùng.');
  try {
    const { outcome, ...result } = await work();
    inbox.finish(deps.db, message.messageId, outcome);
    return { ...result, outcome };
  } catch (error) {
    if (isDefinite(error)) inbox.release(deps.db, message.messageId);
    else inbox.finish(deps.db, message.messageId, 'lỗi, không rõ kết quả');
    throw error;
  }
}

async function confirm(deps, { message, project }, content, threadName = null) {
  try {
    await deps.bot.reply({
      channelId: message.channelId, messageId: message.messageId, content, live: discordLive(project),
      threadName: message.inThread ? null : threadName,
    });
  } catch (error) {
    deps.log('desk-reply-failed', { messageId: message.messageId, code: error?.code ?? 'INTERNAL' });
  }
}

async function submit(deps, args, now) {
  const found = await open(deps, args, now);
  const { message, project } = found;
  const spec = readSpec(message.text);
  const result = await useOnce(deps, message, { action: 'submit', specId: null }, now, async () => {
    const created = await deps.facade.newSpec({ project: project.key, ...spec, title: null }, now);
    return { project: project.key, specId: created?.id ?? null, outcome: `đã nhận spec ${created?.id ?? ''}`.trim() };
  });
  await confirm(deps, found, `Đã nhận spec ${result.specId ?? ''} cho ${project.key}. Câu hỏi sẽ được gửi khi soạn xong.`, `Spec ${result.specId ?? ''} ${project.key}`);
  return result;
}

async function saveAll(deps, specId, answers, by, now) {
  for (const { qid, choice, text } of answers) {
    const saved = await deps.facade.saveDraft(specId, { qid, choice, text }, by, now);
    if (saved === false || saved?.ok === false) throw new DeskError('STATE', 'Quiz đã nộp nên không sửa được nữa.');
  }
}

async function answer(deps, args, now) {
  const found = await open(deps, args, now, { kind: 'quiz', allowEdited: false });
  const { message, project } = found;
  const { specId, view } = await pickSpec(deps, 'quiz', { ...found, now });
  const { answers, submit: wantsSubmit } = readAnswers(message.text, Array.isArray(view.ask) ? view.ask : []);
  const by = byOf(message);
  const result = await useOnce(deps, message, { action: 'answer', specId }, now, async () => {
    await saveAll(deps, specId, answers, by, now);
    const sent = wantsSubmit ? await deps.facade.submit(specId, by, now) : null;
    const missing = sent?.missing ?? [];
    const saved = answers.length > 0 ? `đã lưu ${answers.map(item => item.qid).join(', ')}` : 'không có câu mới';
    const tail = !sent ? '' : sent.ok ? '; đã nộp' : missing.length > 0 ? `; chưa nộp, còn thiếu ${missing.join(', ')}` : '; chưa nộp được';
    return { project: project.key, specId, saved: answers.map(item => item.qid), submitted: sent?.ok === true, missing, outcome: saved + tail };
  });
  await confirm(deps, found, `Spec ${specId}: ${result.outcome}.${wantsSubmit ? '' : ' Nhắn "nộp" khi đã trả lời xong.'}`);
  return result;
}

async function runApprove(deps, { specId, version, message, now }) {
  const result = await deps.facade.approve(specId, { sha: version, quote: message.text }, byOf(message), now);
  if (!result?.ok) throw new DeskError('STALE', result?.error ? firstLine(result.error) : 'Chưa ghi được lời duyệt. Hãy xem lại bản mới.');
  return { decision: 'approved', outcome: `đã duyệt bản ${version.slice(0, 8)}` };
}

async function runFeedback(deps, { specId, message, now }) {
  const result = await deps.facade.feedback(specId, { text: message.text }, byOf(message), now);
  if (result?.ok === false) throw new DeskError('STATE', 'Spec đã sang bước khác nên chưa ghi được góp ý.');
  return { decision: 'feedback', outcome: 'đã ghi góp ý' };
}

const hasExtras = raw => Boolean(raw.attachments?.length || raw.sticker_items?.length || raw.poll || raw.mention_everyone);

async function approve(deps, args, now) {
  const found = await open(deps, args, now, { kind: 'review', allowEdited: false });
  const { message, project } = found;
  if (!found.post) throw new DeskError('CHOOSE', 'Tin này chưa được tính là duyệt hay góp ý. Hãy trả lời (Reply) trực tiếp vào tin gửi bản duyệt.');
  const verdict = readApproval(message.text, [project.key]);
  if (verdict === 'empty') throw new DeskError('INVALID', 'Tin không có nội dung chữ.');
  const { specId, version } = await pickSpec(deps, 'review', { ...found, now });
  const run = verdict === 'approved' && !hasExtras(message.raw) ? runApprove : runFeedback;
  const result = await useOnce(deps, message, { action: 'approve', specId }, now, () => run(deps, { specId, version, message, now }));
  const note = result.decision === 'approved' ? `đã duyệt bản ${version.slice(0, 8)}` : 'đã ghi là góp ý, chưa tính là duyệt. Spec sẽ được sửa rồi gửi lại';
  await confirm(deps, found, `Spec ${specId} (${project.key}): ${note}.`);
  return { project: project.key, specId, ...result };
}

const SPEC_NO = /(?:#|spec\s*)(\d{1,9})(?!\d)/iu;

async function ask(deps, args, now) {
  const found = await open(deps, args, now, { check: requireTeam });
  const { message, project } = found;
  const specs = list((await deps.facade.overview(now))?.specs).filter(spec => spec.project === project.key && spec.asks);
  const wanted = SPEC_NO.exec(message.text)?.[1];
  const spec = wanted ? specs.find(item => item.id === Number(wanted)) : specs.length === 1 ? specs[0] : null;
  if (!spec && wanted) throw new DeskError('STATE', `Spec ${wanted} của ${project.key} không có câu nào chờ chốt.`);
  if (!spec) throw new DeskError(specs.length ? 'CHOOSE' : 'STATE', specs.length ? `Có ${specs.length} spec đang có câu chờ chốt (${specs.map(item => `#${item.id}`).join(', ')}). Hãy ghi rõ spec nào.` : `${project.key} không có spec nào có câu chờ chốt.`);
  const sent = await deps.facade.askNow(spec.id, now);
  if (!sent?.ok) throw new DeskError('STATE', sent?.error ? firstLine(sent.error) : 'Chưa gửi được câu hỏi.');
  await confirm(deps, found, `${sent.line}. Mỗi người nhận link tới đúng phần của mình.`);
  return { project: project.key, specId: spec.id, outcome: sent.line };
}

module.exports = { submit, answer, approve, ask };
