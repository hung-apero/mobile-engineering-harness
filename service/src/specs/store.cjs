const crypto = require('node:crypto');
const { transaction } = require('../kv.cjs');

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const parse = (text, fallback) => {
  try {
    return text == null ? fallback : JSON.parse(text);
  } catch {
    return fallback;
  }
};

function toSpec(row) {
  if (!row) return null;
  return {
    id: row.id, project: row.project, title: row.title, source: parse(row.source, {}),
    figma: parse(row.figma, null), state: row.state, round: row.round, data: parse(row.data, {}),
    specSha: row.spec_sha, approvedSha: row.approved_sha, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function createSpec(db, { project, title, source, figma }, now) {
  const info = db.prepare(
    `INSERT INTO specs (project, title, source, figma, state, created_at, updated_at) VALUES (?, ?, ?, ?, 'new', ?, ?)`,
  ).run(project, title, JSON.stringify(source ?? {}), figma == null ? null : JSON.stringify(figma), now, now);
  return getSpec(db, Number(info.lastInsertRowid));
}

function getSpec(db, id) {
  return toSpec(db.prepare('SELECT * FROM specs WHERE id = ?').get(id));
}

function listSpecs(db, { project, states } = {}) {
  const where = [];
  const args = [];
  if (project !== undefined) {
    where.push('project = ?');
    args.push(project);
  }
  if (states) {
    where.push(`state IN (${states.map(() => '?').join(', ')})`);
    args.push(...states);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM specs ${clause} ORDER BY id`).all(...args).map(toSpec);
}

const PATCH_COLUMNS = { title: 'title', round: 'round', specSha: 'spec_sha', approvedSha: 'approved_sha' };

function transitionSpec(db, id, from, to, now, patch = {}) {
  return transaction(db, () => {
    const spec = getSpec(db, id);
    if (!spec || !from.includes(spec.state)) return null;
    const sets = ['state = ?', 'updated_at = ?'];
    const args = [to, now];
    for (const [key, column] of Object.entries(PATCH_COLUMNS)) {
      if (key in patch) {
        sets.push(`${column} = ?`);
        args.push(patch[key]);
      }
    }
    if (patch.data) {
      sets.push('data = ?');
      args.push(JSON.stringify({ ...spec.data, ...patch.data }));
    }
    db.prepare(`UPDATE specs SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
    return getSpec(db, id);
  });
}

function patchData(db, id, patch, now) {
  return transaction(db, () => {
    const spec = getSpec(db, id);
    if (!spec) return null;
    db.prepare('UPDATE specs SET data = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify({ ...spec.data, ...patch }), now, id);
    return getSpec(db, id);
  });
}

const submitted = (db, specId, round) =>
  db.prepare('SELECT 1 FROM spec_rounds WHERE spec_id = ? AND round = ?').get(specId, round) !== undefined;

function saveDraft(db, { specId, qid, round, choice, text, by }, now) {
  return transaction(db, () => {
    if (submitted(db, specId, round)) return false;
    db.prepare(
      `INSERT INTO spec_answers (spec_id, qid, round, choice, text, "by", at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (spec_id, qid, round) DO UPDATE SET choice = excluded.choice, text = excluded.text,
         "by" = excluded."by", at = excluded.at`,
    ).run(specId, qid, round, choice ?? null, text ?? '', by, now);
    return true;
  });
}

function submitRound(db, specId, round, by, now) {
  return db.prepare(
    `INSERT INTO spec_rounds (spec_id, round, submitted_by, submitted_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (spec_id, round) DO NOTHING`,
  ).run(specId, round, by, now).changes === 1;
}

function answersOf(db, specId, round) {
  const rows = round === undefined
    ? db.prepare('SELECT * FROM spec_answers WHERE spec_id = ? ORDER BY round, rowid').all(specId)
    : db.prepare('SELECT * FROM spec_answers WHERE spec_id = ? AND round = ? ORDER BY rowid').all(specId, round);
  return rows.map(r => ({ specId: r.spec_id, qid: r.qid, round: r.round, choice: r.choice, text: r.text, by: r.by, at: r.at }));
}

function addChat(db, { specId, qid, question, by }, now) {
  const info = db.prepare('INSERT INTO spec_chat (spec_id, qid, question, "by", at) VALUES (?, ?, ?, ?, ?)')
    .run(specId, qid, question, by, now);
  return Number(info.lastInsertRowid);
}

function answerChat(db, id, answer, state, now) {
  db.prepare('UPDATE spec_chat SET answer = ?, state = ?, at = ? WHERE id = ?').run(answer, state, now, id);
}

function chatsOf(db, specId, qid) {
  const rows = qid === undefined
    ? db.prepare('SELECT * FROM spec_chat WHERE spec_id = ? ORDER BY id').all(specId)
    : db.prepare('SELECT * FROM spec_chat WHERE spec_id = ? AND qid = ? ORDER BY id').all(specId, qid);
  return rows.map(r => ({ id: r.id, specId: r.spec_id, qid: r.qid, question: r.question, by: r.by, answer: r.answer, state: r.state, at: r.at }));
}

function issueToken(db, { specId, purpose, ttlMs }, now) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO spec_tokens (hash, spec_id, purpose, expires_at) VALUES (?, ?, ?, ?)')
    .run(sha(token), specId, purpose, now + ttlMs);
  return token;
}

function resolveToken(db, token, purpose, now) {
  if (typeof token !== 'string' || token.length < 16 || token.length > 200) return null;
  const row = db.prepare('SELECT spec_id, purpose, expires_at FROM spec_tokens WHERE hash = ?').get(sha(token));
  if (!row || row.purpose !== purpose || row.expires_at <= now) return null;
  return row.spec_id;
}

function revokeTokens(db, specId, purpose) {
  db.prepare('DELETE FROM spec_tokens WHERE spec_id = ? AND purpose = ?').run(specId, purpose);
}

module.exports = {
  createSpec, getSpec, listSpecs, transitionSpec, patchData, saveDraft, submitRound, answersOf,
  addChat, answerChat, chatsOf, issueToken, resolveToken, revokeTokens,
};
