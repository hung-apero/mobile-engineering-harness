const crypto = require('node:crypto');
const store = require('./store.cjs');
const { operatorOff } = require('./polling.cjs');

const HOUR = 60 * 60 * 1000;
const CRASH = /\b(?:crash(?:es|ed|ing)?|anr)\b/i;
const DEFAULT_BATCH = { max_bugs: 8, max_hours: 4 };

function priorityOf(issue) {
  const text = [issue.summary ?? '', ...(issue.labels ?? [])].join(' ');
  if (CRASH.test(text)) return 0;
  return store.PRIORITIES[String(issue.priority ?? '').toLowerCase()] ?? 2;
}

function fingerprintOf(issue) {
  const labels = [...(issue.labels ?? [])].sort();
  const raw = JSON.stringify([issue.status, issue.commentCount ?? 0, issue.attachmentCount ?? 0, labels]);
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

function upsert(db, project, version, issue, patch, now) {
  db.prepare(
    `INSERT INTO tickets (project, key, version, priority, state, verdict, batch_id, reopen_count, fingerprint, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (project, key) DO UPDATE SET version = excluded.version, priority = excluded.priority, state = excluded.state,
       batch_id = excluded.batch_id, reopen_count = excluded.reopen_count, fingerprint = excluded.fingerprint, updated_at = excluded.updated_at`,
  ).run(project, issue.key, version, priorityOf(issue), patch.state, patch.verdict ?? null, patch.batchId ?? null, patch.reopenCount ?? 0, fingerprintOf(issue), now);
}

function decide(issue, existing, options) {
  const { inProgress, reopenLimit } = options;
  const fingerprint = fingerprintOf(issue);
  if (same(issue.status, inProgress) || (issue.labels ?? []).includes('human-only')) {
    return { skip: { code: 'B02', reason: 'ticket đang được dev làm hoặc gắn human-only' }, state: 'skipped' };
  }
  if (existing?.state === 'dev') return { ignore: true };
  const reopened = same(issue.status, 'Reopened');
  if (reopened && existing?.state === 'done' && existing.fingerprint === fingerprint) return { ignore: true };
  if (reopened && (!existing || existing.state === 'done')) {
    const reopenCount = (existing?.reopenCount ?? 0) + 1;
    if (reopenCount >= reopenLimit) {
      return { skip: { code: 'B09', reason: `reopen lần ${reopenCount}, giao dev trực` }, state: 'dev', reopenCount, giveDev: true };
    }
    return { accept: true, reopenCount };
  }
  if (!existing) return { accept: true, reopenCount: 0 };
  const reopenCount = existing.reopenCount;
  if (existing.state === 'accepted' || existing.state === 'batched') return { ignore: true, refresh: true };
  if (existing.fingerprint === fingerprint && existing.state !== 'skipped') {
    if (existing.verdict != null) return { skip: { code: 'B08', reason: 'đã có kết luận, ticket không có gì mới' }, state: existing.state, keep: true };
    return { ignore: true };
  }
  return { accept: true, reopenCount };
}

function intake(db, { project, version, issues, now, inProgress = 'In Progress', reopenLimit = 3 }) {
  store.checkVersion(version);
  const result = { accepted: [], skipped: [], giveDev: [] };
  store.inTransaction(db, () => {
    for (const issue of issues) {
      if (typeof issue.key !== 'string' || !store.KEY_RE.test(issue.key)) throw new Error(`mã ticket không hợp lệ: ${issue.key}`);
      const existing = store.getTicket(db, project, issue.key);
      const d = decide(issue, existing, { inProgress, reopenLimit });
      if (d.ignore) {
        if (d.refresh) db.prepare('UPDATE tickets SET fingerprint = ?, priority = ? WHERE project = ? AND key = ?').run(fingerprintOf(issue), priorityOf(issue), project, issue.key);
        continue;
      }
      if (d.skip) {
        result.skipped.push({ key: issue.key, ...d.skip });
        if (d.keep) continue;
        if (d.giveDev) result.giveDev.push(issue.key);
        const state = existing?.state === 'batched' && d.state === 'skipped' ? 'batched' : d.state;
        upsert(db, project, version, issue, { state, verdict: existing?.verdict, batchId: state === 'batched' ? existing.batchId : null, reopenCount: d.reopenCount ?? existing?.reopenCount }, now);
        continue;
      }
      upsert(db, project, version, issue, { state: 'accepted', reopenCount: d.reopenCount }, now);
      result.accepted.push(issue.key);
    }
  });
  return result;
}

function planBatches(db, project, now, limits = DEFAULT_BATCH) {
  const created = [];
  const maxWait = limits.max_hours * HOUR;
  store.inTransaction(db, () => {
    for (const version of store.listVersions(db, project)) {
      if (version.state === 'closed' || operatorOff(db, project, version.version)) continue;
      const waiting = store.listTickets(db, { project, version: version.version, states: ['accepted'] });
      const running = store.listBatches(db, { project, version: version.version }).filter(b => !store.FINISHED.includes(b.state));
      const open = kind => running.some(b => b.kind === kind);
      const make = (kind, tickets) => {
        const keys = tickets.map(t => t.key);
        const info = db.prepare("INSERT INTO batches (project, version, kind, state, keys, opened_at, updated_at) VALUES (?, ?, ?, 'open', ?, ?, ?)")
          .run(project, version.version, kind, JSON.stringify(keys), now, now);
        const mark = db.prepare("UPDATE tickets SET batch_id = ?, state = 'batched' WHERE project = ? AND key = ?");
        for (const key of keys) mark.run(Number(info.lastInsertRowid), project, key);
        created.push(store.getBatch(db, Number(info.lastInsertRowid)));
      };
      const urgent = waiting.filter(t => t.priority === 0);
      if (urgent.length && !open('highest')) make('highest', [urgent[0]]);
      const normal = waiting.filter(t => t.priority !== 0);
      if (!normal.length || open('normal')) continue;
      const oldest = Math.min(...normal.map(t => t.updatedAt));
      const drained = version.lastPollAt != null && (version.lastNewAt == null || version.lastNewAt < version.lastPollAt);
      if (normal.length >= limits.max_bugs || now - oldest >= maxWait || drained) make('normal', normal.slice(0, limits.max_bugs));
    }
  });
  return created;
}

module.exports = { intake, planBatches, priorityOf, fingerprintOf };
