const { digest, weeklyMissing, markReportSent } = require('./reports.cjs');
const { redactJson } = require('./redact.cjs');

const EVIDENCE_MAX = 4000;

function encodeEvidence(evidence) {
  const json = redactJson(evidence ?? null) ?? 'null';
  if (json.length <= EVIDENCE_MAX) return json;
  let end = EVIDENCE_MAX;
  while (end > 0) {
    let cut = end;
    if (/[\ud800-\udbff]/.test(json[cut - 1])) cut--;
    const out = JSON.stringify({ truncated: true, text: json.slice(0, cut) });
    if (out.length <= EVIDENCE_MAX) return out;
    end -= Math.max(1, out.length - EVIDENCE_MAX);
  }
  return JSON.stringify({ truncated: true, text: '' });
}

function record(db, { project, jobId = null, code, ruleVersion, evidence, action }, now) {
  const result = db
    .prepare(
      `INSERT INTO decisions (project, job_id, code, rule_version, evidence, action, at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(project, jobId, code, ruleVersion, encodeEvidence(evidence), action, now);
  return Number(result.lastInsertRowid);
}

function missingRule(db, { project, situation, proposal }, now) {
  db.prepare(
    `INSERT INTO missing_rules (project, situation, proposal, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (project, situation) DO UPDATE SET
       count = count + 1, last_seen = excluded.last_seen, proposal = excluded.proposal`,
  ).run(project, situation, proposal, now, now);
  return db.prepare('SELECT count FROM missing_rules WHERE project = ? AND situation = ?').get(project, situation).count;
}

module.exports = { record, missingRule, digest, weeklyMissing, markReportSent };
