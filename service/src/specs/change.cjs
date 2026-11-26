const files = require('./repo-files.cjs');
const store = require('./store.cjs');
const kv = require('../kv.cjs');
const { lineDiff } = require('./line-diff.cjs');
const { oneLine } = require('./answers.cjs');
const { move, patch, decide, openOnce, closeWaits, linkFor, nameOf } = require('./kit.cjs');
const { sendBack } = require('./build-kit.cjs');
const { toBuilding } = require('./provisional.cjs');

const textKey = id => `spec-change:${id}`;
const rawKey = id => `spec-raw:${id}`;
const pendingChange = spec => (spec.data.change && spec.data.change.state !== 'applied' ? spec.data.change : null);
const inReview = spec => spec.data.change?.state === 'review';

function sections(markdown) {
  const out = new Map();
  for (const part of String(markdown ?? '').replace(/\r\n?/g, '\n').split(/^(?=#{1,6} )/m)) {
    const name = part.match(/^#{1,6} +(.+)/)?.[1].trim() ?? 'Đầu spec';
    out.set(name, `${out.get(name) ?? ''}${part}`.trim());
  }
  return out;
}

function changedSections(before, after) {
  const [old, next] = [sections(before), sections(after)];
  const changed = [...next].filter(([name, body]) => old.get(name) !== body).map(([name, body]) => ({ name, body }));
  const removed = [...old.keys()].filter(name => !next.has(name)).map(name => ({ name, body: null }));
  return [...changed, ...removed];
}

function approvedText(spec) {
  const { repo } = spec.data;
  const found = files.specVersions(repo).map(version => files.specAt(repo, version)).findLast(item => item?.sha === spec.approvedSha);
  return found?.markdown ?? '';
}

const dayOf = now => new Date(now + 7 * 3600000).toISOString().slice(0, 10);

function sourceSection(changed, now) {
  const parts = changed.map(({ name, body }) => (body === null ? `### Bỏ mục: ${name}` : body.replace(/^#{1,6} /, '### ')));
  return `## Thay đổi của spec gốc (đọc ngày ${dayOf(now)}), thay cho phần nói khác ở trên\n\n${parts.join('\n\n')}`;
}

const feedbackSection = ({ day, note }) => `## Góp ý của PO (${day})\n\n${note.split('\n').map(row => `> ${row}`).join('\n')}`;
const extras = (added, feedback) => [added, ...feedback.map(feedbackSection)].filter(Boolean).join('\n\n');
const union = (a, b) => [...new Set([...a, ...b])];

function propose(db, spec, { kind, base, added = '', names, raw = null, rawSha = null, note = null }, now) {
  const before = pendingChange(spec);
  const feedback = [...(before?.feedback ?? []), ...(note === null ? [] : [{ day: dayOf(now), note }])];
  const more = extras(added, feedback);
  const text = more ? `${base.markdown.trimEnd()}\n\n${more}\n` : base.markdown;
  const kept = feedback.length ? before : null;
  kv.set(db, textKey(spec.id), { text, raw, added, base }, now);
  const change = {
    n: (spec.data.change?.n ?? 0) + 1, kind, state: 'review', sha: files.sha256(text), feedback,
    names: union(kept?.names ?? [], names), base: base.sha, rawSha, at: now,
  };
  closeWaits(db, spec.id, now, 'change');
  return store.patchData(db, spec.id, { change }, now);
}

const baseOf = ({ markdown, sha }) => ({ markdown, sha });

function sourceChange(db, spec, { markdown, rawSha }, now) {
  const before = kv.get(db, rawKey(spec.id))?.text ?? files.read(spec.data.repo, 'inputs/spec-v1.md') ?? '';
  const changed = changedSections(before, markdown);
  if (!changed.length) return null;
  const names = changed.map(item => item.name);
  propose(db, spec, { kind: 'source', base: baseOf(files.latestSpec(spec.data.repo)), added: sourceSection(changed, now), names, raw: markdown, rawSha }, now);
  return { names };
}

function noteSelfChange(run) {
  const { spec } = run;
  const latest = files.latestSpec(spec.data.repo);
  const known = pendingChange(spec);
  if (!latest || latest.sha === spec.approvedSha || known?.base === latest.sha) return;
  const { added = '', raw = null } = known?.kind === 'source' ? kv.get(run.db, textKey(spec.id)) : {};
  const { kind = 'self', names = [`spec-v${latest.version}`], rawSha = null } = known?.kind === 'source' ? known : {};
  run.spec = propose(run.db, spec, { kind, base: baseOf(latest), added, names, raw, rawSha }, run.now);
  decide(run, 'S04', 'spec-changed-by-agent', { sha: latest.sha, version: latest.version });
}

function askChange(run) {
  if (!inReview(run.spec)) return;
  const { sha } = run.spec.data.change;
  openOnce(run, `change-${sha.slice(0, 12)}`, 'po', `Duyệt phần spec đổi khi đang code: ${nameOf(run.spec)}`, () => linkFor(run.ctx, run.spec.id, 'review', run.now));
}

const textOf = (db, spec) => kv.get(db, textKey(spec.id))?.text ?? '';

function changeView(db, spec) {
  const text = textOf(db, spec);
  return { markdown: text, sha: spec.data.change.sha, diff: lineDiff(approvedText(spec), text) };
}

function approveChange(run, { quote, by }) {
  const change = { ...run.spec.data.change, state: 'approved', quote: oneLine(quote, 500), by, approvedAt: run.now };
  patch(run, { change });
  decide(run, 'S04', 'spec-change-approved', { sha: change.sha, quote: change.quote, by, names: change.names });
  closeWaits(run.db, run.spec.id, run.now, 'change');
}

function feedbackChange(run, note) {
  const { change } = run.spec.data;
  const { base, added, raw } = kv.get(run.db, textKey(run.spec.id));
  run.spec = propose(run.db, run.spec, { kind: 'source', base, added, names: change.names, raw, rawSha: change.rawSha, note }, run.now);
  askChange(run);
}

function writeSpec(run, text) {
  const { repo } = run.spec.data;
  const latest = files.latestSpec(repo);
  if (latest?.sha === files.sha256(text)) return latest.version;
  const version = (latest?.version ?? 0) + 1;
  files.write(repo, `inputs/spec-v${version}.md`, text);
  return version;
}

async function applyChange(run) {
  const { change } = run.spec.data;
  if (change?.state !== 'approved') return false;
  const saved = kv.get(run.db, textKey(run.spec.id));
  if (files.sha256(saved?.text ?? '') !== change.sha) throw new Error('nội dung thay đổi đã duyệt không còn khớp');
  const version = change.kind === 'source' ? writeSpec(run, saved.text) : null;
  const started = run.spec.state !== 'waiting-prereq';
  if (change.kind === 'source' && started) {
    sendBack(run, `Spec đổi và PO đã duyệt (${change.names.join(', ')}): làm theo mục "Thay đổi" và "Góp ý của PO" cuối inputs/spec-v${version}.md\n\n${extras(saved.added, change.feedback ?? [])}`, `change-${change.n}`);
  }
  if (saved.raw) kv.set(run.db, rawKey(run.spec.id), { text: saved.raw }, run.now);
  move(run, run.spec.state, { specSha: change.sha, approvedSha: change.sha, data: { change: { ...change, state: 'applied' }, ...(change.rawSha && { rawSha: change.rawSha }) } });
  if (change.kind === 'source' && started) toBuilding(run);
  return true;
}

module.exports = { sourceChange, noteSelfChange, askChange, changeView, approveChange, feedbackChange, applyChange, pendingChange, inReview, changedSections };
