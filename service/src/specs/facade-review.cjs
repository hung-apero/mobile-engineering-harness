const files = require('./repo-files.cjs');
const { lineDiff } = require('./line-diff.cjs');
const { fresh } = require('./segment.cjs');
const phase = require('./phase-review.cjs');
const { changeView, approveChange, feedbackChange, inReview } = require('./change.cjs');
const { trialView, approveTrial, feedbackTrial } = require('./phase-trial.cjs');
const { isBuilding } = require('./build-kit.cjs');
const { createRun, move, closeWaits } = require('./kit.cjs');
const { hedged } = require('../web/approve-text.cjs');
const { wrongState, invalid, stale } = require('./facade-error.cjs');

const MAX_QUOTE = 500;
const MAX_FEEDBACK = 8000;
const KEEP_FEEDBACK = 20;

function choices(spec, kind) {
  return Object.values(spec.data.answered ?? {}).filter(answer => answer.kind === kind).map(({ id, label, text }) => {
    const question = spec.data.questions?.find(q => q.id === id);
    const option = question?.options.find(o => o.label === label)?.text ?? label;
    const reason = question?.auto?.reason;
    return { id, title: question?.title ?? id, label, ...(kind === 'po' ? { text: text || option } : { text: option, source: text, ...(reason && { reason }) }) };
  });
}

function createReview(ctx) {
  let cache = { key: null, diff: [] };

  function diffOf(spec, latest) {
    const before = (spec.data.reviewed ?? []).filter(version => version < latest.version).at(-1) ?? 1;
    const base = before < latest.version ? files.specAt(spec.data.repo, before) : null;
    if (!base) return [];
    const key = `${base.sha}:${latest.sha}`;
    if (cache.key !== key) cache = { key, diff: lineDiff(base.markdown, latest.markdown) };
    return cache.diff;
  }

  const choicesOf = spec => ({ agentChoices: choices(spec, 'agent'), poChoices: choices(spec, 'po') });
  const changing = spec => isBuilding(spec) && inReview(spec);
  const trying = spec => spec.state === 'po-trial' && spec.data.build?.trial;

  function buildReview(spec) {
    const { id, project, title, state, updatedAt } = spec;
    if (changing(spec)) return { spec: { id, project, title, state: 'review', updatedAt }, ...changeView(ctx.db, spec), ...choicesOf(spec), approved: false };
    return { spec: { id, project, title, state, updatedAt }, ...trialView(spec) };
  }

  function review(spec) {
    if (changing(spec) || trying(spec)) return buildReview(spec);
    const latest = spec.data.repo && spec.data.reviewed?.length ? files.latestSpec(spec.data.repo) : null;
    const { id, project, title, state, updatedAt } = spec;
    return {
      spec: { id, project, title, state, updatedAt }, markdown: latest?.markdown ?? '', sha: latest?.sha ?? '', diff: latest ? diffOf(spec, latest) : [],
      ...choicesOf(spec), approved: (spec.state === 'approved' || isBuilding(spec) || ['done', 'landed-dry'].includes(spec.state)) && latest?.sha === spec.approvedSha,
    };
  }

  async function locked(spec, work) {
    const { busy } = ctx.specs;
    if (busy.has(spec.id)) return { ok: false, error: 'Spec đang được xử lý, bạn thử lại sau ít giây.' };
    busy.add(spec.id);
    try {
      return await work();
    } finally {
      busy.delete(spec.id);
    }
  }

  async function approve(project, spec, { sha, quote }, by, now) {
    if (spec.state !== 'review' && !changing(spec) && !trying(spec)) throw wrongState();
    const text = typeof quote === 'string' ? quote.trim() : '';
    if (!text || text.length > MAX_QUOTE) throw invalid('Lời duyệt cần có nội dung.');
    if (hedged(text)) throw invalid('Lời duyệt có điều kiện. Hãy ghi phần cần đổi vào ô góp ý.');
    const run = createRun(ctx, project, spec, now);
    if (changing(spec)) {
      if (sha !== spec.data.change.sha) throw stale();
      return locked(spec, () => ({ ok: true, ...approveChange(run, { quote: text, by }) }));
    }
    if (trying(spec)) {
      if (sha !== spec.data.build.trial.sha) throw stale();
      return locked(spec, () => approveTrial(run, { sha, quote: text }, by));
    }
    if (typeof sha !== 'string' || sha !== spec.specSha || sha !== files.latestSpec(spec.data.repo)?.sha) throw stale();
    return locked(spec, () => phase.approve(run, { sha, quote: text }, by));
  }

  function feedback(project, spec, { text }, by, now) {
    const building = changing(spec) || trying(spec);
    if ((spec.state !== 'review' && !building) || spec.data.approving || ctx.specs.busy.has(spec.id)) throw wrongState();
    const note = typeof text === 'string' ? text.trim() : '';
    if (!note || note.length > MAX_FEEDBACK) throw invalid('Góp ý cần có nội dung.');
    if (building) {
      const run = createRun(ctx, project, spec, now);
      return locked(spec, () => (changing(spec) ? { ok: true, ...feedbackChange(run, note) } : feedbackTrial(run, note)));
    }
    const number = (spec.data.feedbackCount ?? 0) + 1;
    const name = `inputs/po-notes-${number}.md`;
    files.write(spec.data.repo, name, `${note}\n`);
    const run = createRun(ctx, project, spec, now);
    move(run, 'clarifying', {
      data: { notes: name, feedbackCount: number, feedback: [...(spec.data.feedback ?? []), note].slice(-KEEP_FEEDBACK), reviewFloor: spec.data.reviewVersion, ...fresh(spec, 'clarify') },
    });
    closeWaits(ctx.db, spec.id, now, 'review');
    return { ok: true };
  }

  return { review, approve, feedback };
}

module.exports = { createReview };
