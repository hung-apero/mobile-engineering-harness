const fs = require('node:fs');
const path = require('node:path');
const jobs = require('../jobs.cjs');
const files = require('./repo-files.cjs');
const { parseUidiff, SLUG } = require('./uidiff-result.cjs');
const { lastResultText } = require('../bugs/result-log.cjs');
const { clearParked } = require('../blocks.cjs');
const { fresh, keyOf, again, stateOf } = require('./segment.cjs');
const { leaseDevice, freeDevice } = require('./device-lease.cjs');
const { move, decide, findJob } = require('./kit.cjs');
const { buildOf, saveBuild, saveNotes } = require('./build-kit.cjs');
const { firstLine } = require('../redact.cjs');

const ROUNDS = 3;
const MAX_SCREENS = 60;

const text = (value, max) => String(value ?? '').replace(/[\p{C}\s]+/gu, ' ').trim().slice(0, max).toWellFormed();

function screensOf(repo) {
  const dir = path.join(repo, files.DIR, 'figma');
  if (!fs.lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) return [];
  const slugs = fs.readdirSync(dir).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5)).filter(slug => SLUG.test(slug)).sort();
  return slugs.map(slug => ({ slug, digest: files.readJson(repo, `figma/${slug}.json`) }))
    .filter(({ digest }) => digest && (digest.kind ?? 'screen') === 'screen')
    .slice(0, MAX_SCREENS)
    .map(({ slug, digest }) => ({ slug, name: text(digest.name, 120) || slug, node: text(digest.node, 40) }));
}

const jobOf = run => findJob(run.db, { project: run.project.key, kind: 'uidiff', key: keyOf(run.spec) });

function closeParkedJob(run, job) {
  run.db.prepare("UPDATE jobs SET state = 'failed', result = ?, finished_at = NULL, slots_granted = 0 WHERE id = ? AND state = 'parked'")
    .run(JSON.stringify({ error: job.parkReason ?? 'việc bị gác' }), job.id);
  clearParked(run.db, job.id, run.now);
}

function finish(run, notes) {
  saveNotes(run, 'ui', notes);
  if (notes.length) decide(run, 'S05', 'spec-ui-left', { notes: notes.slice(0, 20) });
  move(run, 'reviewing', { data: fresh(run.spec, 'review') });
  return true;
}

async function launch(run, screens) {
  const lock = await leaseDevice(run);
  if (!lock) return false;
  const { round, notes = [] } = buildOf(run).uidiff;
  const payload = { specId: run.spec.id, repo: run.spec.data.repo, serial: lock.serial, holder: lock.holder, figmaUrl: run.spec.data.figmaUrl, screens, round, notes };
  jobs.enqueue(run.db, { project: run.project.key, kind: 'uidiff', key: keyOf(run.spec), priority: 1, slots: 1, payload }, run.now);
  return false;
}

function resultOf(job) {
  try {
    const last = lastResultText(job.logFile);
    if (!last || last.isError) return { ok: false, error: 'log không có kết quả' };
    return parseUidiff(last.structuredOutput ?? last.text, { screens: job.payload.screens.map(screen => screen.slug) });
  } catch (error) {
    return { ok: false, error: firstLine(error) };
  }
}

const noteLines = screens => screens.flatMap(({ slug, score, verdict, findings }) => {
  const head = `${slug} (${verdict === 'blocked' ? 'không chụp được' : `${score}/100`})`;
  return findings.length ? findings.map(f => `${head}: ${f.text}`) : [head];
});

async function settle(run, job) {
  await freeDevice(run);
  const result = resultOf(job);
  if (!result.ok) {
    again(run, `so UI không có kết quả: ${result.error}`);
    return true;
  }
  const { round } = buildOf(run).uidiff;
  const left = result.screens.filter(screen => screen.verdict !== 'pass');
  decide(run, 'S05', 'spec-ui-round', { round, left: left.map(screen => `${screen.slug}:${screen.score}`) });
  const fixable = left.some(screen => screen.verdict === 'fail');
  const notes = noteLines(left).slice(0, 60);
  if (!left.length || round >= ROUNDS || !fixable) return finish(run, notes);
  saveBuild(run, { uidiff: { round: round + 1, notes } });
  move(run, 'uidiff', { data: fresh(run.spec, 'uidiff') });
  return true;
}

async function uidiff(run) {
  const { repo, figmaUrl } = run.spec.data;
  const screens = figmaUrl ? screensOf(repo) : [];
  if (!screens.length) return finish(run, figmaUrl ? ['Chưa so UI: không có màn nào có digest Figma'] : []);
  const now = stateOf(jobOf(run));
  if (now.type === 'waiting') return false;
  if (now.type === 'missing') return launch(run, screens);
  if (now.type === 'parked') {
    await freeDevice(run);
    closeParkedJob(run, now.job);
    again(run, now.job.parkReason ?? 'việc so UI bị gác');
    return true;
  }
  return settle(run, now.job);
}

module.exports = { uidiff, screensOf, closeParkedJob, ROUNDS };
