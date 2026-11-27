const fs = require('node:fs');
const path = require('node:path');
const store = require('../specs/store.cjs');
const { SPEC_LABELS } = require('../web/spec-labels.cjs');
const { productsOf } = require('./spec-products.cjs');
const { stepsOf, stepLine } = require('./spec-steps.cjs');
const { uiRounds } = require('./spec-ui-rounds.cjs');
const { timeOf } = require('./bug-groups.cjs');
const { webBase } = require('../specs/kit.cjs');

const LINK_ROLES = { po: 'PO', qa: 'QA', dev: 'Dev' };

const ROLES = { po: 'PO', qa: 'QA', dev: 'dev' };
const SPEC_KINDS = ['spec', 'uidiff', 'explain'];
const LIVE = ['starting', 'running'];
const SEGMENTS = {
  ask: 'soạn câu hỏi', clarify: 'viết lại spec', build: 'code', smoke: 'chạy thử', uidiff: 'so giao diện', review: 'kiểm code',
  candidate: 'dựng bản cài', landing: 'gộp', explain: 'trả lời PO',
};

const parseJson = text => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

function readRun(repo, name) {
  if (typeof repo !== 'string') return null;
  try {
    return parseJson(fs.readFileSync(path.join(repo, '.harness-run', name), 'utf8'));
  } catch {
    return null;
  }
}

function decisionsOf(db, project, id) {
  return db.prepare("SELECT action, evidence, at FROM decisions WHERE project = ? AND action LIKE 'spec-%' ORDER BY id").all(project)
    .map(row => ({ action: row.action, at: row.at, evidence: parseJson(row.evidence) }))
    .filter(row => row.evidence?.specId === id);
}

function linkName(role, pathname) {
  if (pathname.startsWith('/quiz/')) return `Mở quiz phần ${LINK_ROLES[role] ?? role}`;
  if (pathname.startsWith('/review/')) return 'Mở trang duyệt spec';
  return 'Mở link';
}

function linksOf(ctx, id) {
  const rows = ctx.db.prepare("SELECT w.role, w.subject, w.link FROM kv k JOIN waits w ON w.id = CAST(k.value AS INTEGER) WHERE k.key LIKE ? AND w.state = 'open' AND w.link IS NOT NULL ORDER BY w.id").all(`spec-wait:${id}:%`);
  const base = webBase(ctx).replace(/\/$/, '');
  return rows.flatMap(row => {
    try {
      const url = new URL(row.link);
      return [{ role: row.role, subject: row.subject, name: linkName(row.role, url.pathname), url: `${base}${url.pathname}${url.hash}` }];
    } catch {
      return [];
    }
  });
}

function waitingOf(db, id) {
  const row = db.prepare("SELECT w.role, w.subject, w.opened_at, w.ping_count FROM kv k JOIN waits w ON w.id = CAST(k.value AS INTEGER) WHERE k.key LIKE ? AND w.state = 'open' ORDER BY w.id LIMIT 1").get(`spec-wait:${id}:%`);
  return row ? { role: ROLES[row.role] ?? row.role, subject: row.subject, openedAt: row.opened_at, pings: row.ping_count } : null;
}

const segmentOf = key => String(key).split('#')[1]?.replace(/-[^-]*$/, '') ?? '';

function jobsOf(db, project, id) {
  return db.prepare(`SELECT * FROM jobs WHERE project = ? AND ((key LIKE ? AND kind IN (${SPEC_KINDS.map(() => '?').join(',')})) OR key LIKE ?) ORDER BY id DESC`)
    .all(project, `${id}#%`, ...SPEC_KINDS, `spec-${id}#%`)
    .map(job => {
      const result = parseJson(job.result) ?? {};
      return {
        id: job.id, kind: job.kind, segment: segmentOf(job.key), state: job.state, startedAt: job.started_at, finishedAt: job.finished_at,
        costUsd: Number.isFinite(result.costUsd) ? result.costUsd : null, turns: Number.isFinite(result.turns) ? result.turns : null,
        sessionId: job.session_id,
      };
    });
}

function issuesOf(result) {
  const empty = { source: 'none', blocking: [], open: [], fixed: [], raw: [] };
  if (Array.isArray(result?.issues)) {
    const items = result.issues.filter(item => item && typeof item.title === 'string');
    return {
      ...empty, source: 'issues',
      blocking: items.filter(item => item.status === 'open' && item.blocksMerge === true),
      open: items.filter(item => item.status === 'open' && item.blocksMerge !== true),
      fixed: items.filter(item => item.status === 'fixed'),
    };
  }
  const findings = Array.isArray(result?.review?.findings) ? result.review.findings : [];
  if (findings.length) return { ...empty, source: 'findings', raw: findings.map(item => String(item?.message ?? item)) };
  return empty;
}

function provisionalOf(data) {
  const questions = Array.isArray(data.questions) ? data.questions : [];
  const asked = new Set((data.rounds ?? []).flatMap(round => round.ask ?? []));
  const answered = data.answered ?? {};
  return questions.filter(q => asked.has(q.id) && !q.blocking && !answered[q.id]).map(q => {
    const label = q.proposal?.label ?? '';
    return { id: q.id, label, text: (q.options ?? []).find(option => option.label === label)?.text ?? '' };
  });
}

function plansOf(progress) {
  const plans = Array.isArray(progress?.plans) ? progress.plans : [];
  return plans.filter(plan => plan && typeof plan === 'object').map(plan => ({ id: String(plan.id ?? ''), title: String(plan.title ?? ''), status: String(plan.status ?? '') }));
}

function specDetail(ctx, key, id, now) {
  const spec = store.getSpec(ctx.db, Number(id));
  if (!spec || spec.project !== key) return null;
  const { data } = spec;
  const decisions = decisionsOf(ctx.db, key, spec.id);
  const result = readRun(data.repo, 'result.json');
  const jobs = jobsOf(ctx.db, key, spec.id);
  const live = jobs.find(job => LIVE.includes(job.state));
  return {
    id: spec.id, title: spec.title || `Spec #${spec.id}`, state: spec.state, label: SPEC_LABELS[spec.state] ?? spec.state,
    waiting: waitingOf(ctx.db, spec.id),
    links: linksOf(ctx, spec.id),
    running: live ? { jobId: live.id, kind: live.segment || live.kind, startedAt: live.startedAt } : null,
    steps: stepsOf(spec.state, decisions, data.parked?.from ?? data.needs?.from),
    issues: issuesOf(result),
    provisional: provisionalOf(data),
    ui: uiRounds(decisions, data.build),
    plans: plansOf(readRun(data.repo, 'progress.json')),
    jobs,
    heldJobId: spec.state === 'parked' ? data.parked?.jobId ?? null : null,
    totalUsd: Math.round(jobs.reduce((sum, job) => sum + (job.costUsd ?? 0), 0) * 100) / 100,
    version: data.build?.version ?? null,
    install: data.build?.candidate?.n ?? null,
    branch: typeof result?.branch === 'string' ? result.branch : null,
    commit: typeof result?.commit === 'string' ? result.commit.slice(0, 12) : null,
    products: productsOf(spec, now),
    now,
  };
}

function nowLine(detail) {
  const { waiting, running, now } = detail;
  if (waiting) return `Đang chờ ${waiting.role}: ${waiting.subject} · từ ${timeOf(waiting.openedAt, now)} · nhắc ${waiting.pings} lần`;
  if (!running) return null;
  const minutes = Number.isFinite(running.startedAt) ? ` · ${Math.max(0, Math.round((now - running.startedAt) / 60000))} phút` : '';
  return `Đang chạy: ${SEGMENTS[running.kind] ?? running.kind}${minutes}`;
}

function issueLine({ issues, provisional }) {
  const parts = [
    issues.blocking.length && `⚠ ${issues.blocking.length} vấn đề chặn merge`,
    issues.open.length && `${issues.open.length} còn mở`,
    provisional.length && `${provisional.length} câu tạm theo đề xuất`,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

const specSummary = detail => ({ stepLine: stepLine(detail.steps), nowLine: nowLine(detail), issueLine: issueLine(detail) });

module.exports = { specDetail, specSummary, SEGMENTS };
