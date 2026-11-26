const files = require('./repo-files.cjs');
const { pendingChange, askChange } = require('./change.cjs');
const { openItems, toBuilding } = require('./provisional.cjs');
const { trialNotes } = require('./trial-notes.cjs');
const { oneLine } = require('./answers.cjs');
const { fresh } = require('./segment.cjs');
const { move, patch, decide, once, openOnce, closeWaits, linkFor, nameOf } = require('./kit.cjs');
const { buildOf, saveBuild, sendBack, state } = require('./build-kit.cjs');
const { firstLine } = require('../redact.cjs');

async function recordGate3(run, { sha, quote }) {
  await once(run, `g3-${sha}`, async () => {
    try {
      await state(run, ['approve', 'g3', '--quote', quote]);
    } catch (error) {
      decide(run, 'X08', 'spec-g3-not-recorded', { sha, error: firstLine(error) });
    }
    return { sha };
  });
}

function approvalOf(run) {
  const { candidate, trial, published, pendingNotes } = buildOf(run);
  const sha = pendingNotes?.length ? null : trial?.approved?.sha;
  return sha && sha === candidate?.sha && sha === trial.sha && sha === published?.sha ? trial.approved : null;
}

async function finishTrial(run) {
  const approved = approvalOf(run);
  await recordGate3(run, approved);
  closeWaits(run.db, run.spec.id, run.now, 'trial');
  move(run, 'landing', { data: fresh(run.spec, 'landing') });
  return { ok: true };
}

async function applyNotes(run) {
  const { pendingNotes = [] } = buildOf(run);
  const last = pendingNotes.at(-1);
  if (!last) return false;
  const told = pendingNotes.map(({ name, note }) => `(.harness-run/${name})\n${note}`).join('\n\n');
  sendBack(run, `PO thử bản cài và góp ý.\n\n${told}`, `trial-${last.number}`);
  saveBuild(run, { pendingNotes: [] });
  toBuilding(run);
  return true;
}

async function poTrial(run) {
  if (buildOf(run).pendingNotes?.length) {
    await applyNotes(run);
    return true;
  }
  const { trial, candidate } = buildOf(run);
  if (trial.live !== run.live || trial.sha !== candidate.sha) {
    closeWaits(run.db, run.spec.id, run.now, 'trial');
    saveBuild(run, { trial: null });
    move(run, 'candidate', { data: fresh(run.spec, 'candidate') });
    return true;
  }
  if (pendingChange(run.spec)) {
    askChange(run);
    return false;
  }
  if (approvalOf(run) && !openItems(run.spec).length) {
    await finishTrial(run);
    return true;
  }
  const count = trialNotes(run.spec).length;
  openOnce(run, `trial-${trial.sha.slice(0, 12)}`, 'po', `Thử bản cài ${nameOf(run.spec)}, commit ${trial.sha.slice(0, 12)}${count ? ` (${count} điểm cần lưu ý ở đầu trang)` : ''}`, () => linkFor(run.ctx, run.spec.id, 'review', run.now));
  return false;
}

function trialView(spec) {
  const { trial, version } = spec.data.build;
  return {
    markdown: '', diff: [], agentChoices: [], poChoices: [], approved: false, sha: trial.sha,
    trial: { version, versionName: trial.versionName, versionCode: trial.versionCode, pr: trial.pr, live: trial.live, notes: trialNotes(spec), open: openItems(spec).length },
  };
}

async function approveTrial(run, { sha, quote }, by) {
  const { trial, candidate } = buildOf(run);
  if (sha !== trial.sha || sha !== candidate.sha) return { ok: false, error: 'Đã có bản cài mới hơn bản bạn đang xem. Hãy tải lại trang.' };
  if (trial.live !== run.live) return { ok: false, error: 'Bản cài đang được gửi lại. Bạn sẽ được nhắn khi xong.' };
  if (buildOf(run).pendingNotes?.length) return { ok: false, error: 'Còn góp ý của bạn chưa đưa vào bản cài. Bạn sẽ được nhắn khi có bản mới.' };
  if (openItems(run.spec).length) return { ok: false, error: 'Còn câu tạm chọn chưa xác nhận. Hãy trả lời trước rồi duyệt bản cài.' };
  const approved = { sha, quote: oneLine(quote, 500).replace(/^-+/, ''), by, at: run.now };
  saveBuild(run, { trial: { ...trial, approved } });
  decide(run, 'F03', 'spec-trial-approved', approved);
  return finishTrial(run);
}

async function feedbackTrial(run, note) {
  const { trial, pendingNotes = [] } = buildOf(run);
  const number = (run.spec.data.feedbackCount ?? 0) + 1;
  const name = `inputs/po-notes-${number}.md`;
  patch(run, { feedbackCount: number });
  saveBuild(run, { pendingNotes: [...pendingNotes, { number, name, note, sha: trial.sha }] });
  decide(run, 'S05', 'spec-trial-feedback', { sha: trial.sha, notes: name });
  try {
    files.write(run.spec.data.repo, name, `${note}\n`);
    if (await applyNotes(run)) return { ok: true };
  } catch (error) {
    decide(run, 'X08', 'spec-feedback-waiting', { notes: name, error: firstLine(error) });
  }
  return { ok: false, error: 'Đã ghi góp ý nhưng chưa đưa được vào việc code. Dev trực đã được báo, bạn không cần gửi lại.' };
}

module.exports = { poTrial, trialView, approveTrial, feedbackTrial, approvalOf };
