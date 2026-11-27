const kv = require('./kv.cjs');
const inbox = require('./inbox.cjs');
const watch = require('./desk-watch.cjs');
const { prepare, writeAccess } = require('./desk-config.cjs');
const { createDeskSession, SESSION } = require('./desk-session.cjs');
const { createReconciler } = require('./desk-reconcile.cjs');
const { firstLine } = require('./redact.cjs');

const WANTED = 'desk:wanted';
const RECONCILE_MS = 60 * 1000;

const deskProjects = projects => [...projects].filter(project => project.enabled && project.channel);
const isWanted = db => kv.get(db, WANTED) === true;

function setWanted(db, wanted, now) {
  kv.set(db, WANTED, wanted, now);
  if (wanted) watch.reset(db, now);
}

function createDeskManager({ db, dzHome, bot, env = process.env, claudeBin = env.DZ_CLAUDE_BIN || 'claude', log = () => {}, session = createDeskSession({ db, dzHome, env, claudeBin }), reconciler = createReconciler({ db, bot, log }), isStopping = () => false }) {
  let busy = null;
  let readAt = 0;
  let threads = [];

  async function read(projects, now) {
    readAt = now;
    writeAccess(dzHome, projects, threads);
    const result = await reconciler.reconcile(projects, now);
    if (result.added > 0) log('desk-missed', { added: result.added });
    if (!result.complete) return;
    threads = result.threads;
    writeAccess(dzHome, projects, threads);
  }

  async function open(projects, reason, now) {
    const { pid } = await session.start(projects, now);
    readAt = 0;
    log('desk-started', { reason, pid });
    if (!isWanted(db)) await session.stop(now);
  }

  async function restart(projects, reason, now) {
    if (watch.isHeld(db, now)) return 'held';
    if (watch.restartsIn(db, now).length >= watch.MAX_RESTARTS) {
      watch.openHold(db, projects, now);
      log('desk-held', { reason });
      return 'held';
    }
    if (now < watch.nextAllowed(db, now)) return 'backoff';
    watch.noteRestart(db, now);
    await session.stop(now);
    await read(projects, now);
    await open(projects, reason, now);
    return 'restarted';
  }

  async function first(projects, now) {
    try {
      await read(projects, now);
      await open(projects, 'first', now);
      return 'started';
    } catch (error) {
      watch.noteRestart(db, now);
      throw error;
    }
  }

  async function daily(projects, now) {
    await read(projects, now);
    if (inbox.pending(db, 1).length > 0) return 'alive';
    await session.stop(now);
    await open(projects, 'daily', now);
    return 'daily';
  }

  async function runStep(all, now) {
    const projects = deskProjects(all);
    const running = session.current(now);
    if (!isWanted(db) || projects.length === 0) {
      if (running) {
        writeAccess(dzHome, []);
        await session.stop(now);
      }
      watch.clearHold(db, now);
      return 'off';
    }
    if (running) writeAccess(dzHome, projects, threads);
    if (!running && watch.restartsIn(db, now).length === 0) return first(projects, now);
    if (!running?.alive) return restart(projects, 'dead', now);
    if (now - readAt >= RECONCILE_MS) await read(projects, now);
    if (watch.isStuck(db, running.startedAt, now)) return restart(projects, 'stuck', now);
    if (inbox.overdue(db, now).length === 0 && inbox.pending(db, 1).length === 0) watch.clearHold(db, now);
    return watch.isDailyDue(db, running.startedAt, now) ? daily(projects, now) : 'alive';
  }

  function step(projects, now) {
    if (busy) return busy;
    if (isStopping()) return Promise.resolve('stopping');
    busy = runStep([...projects], now)
      .catch(error => {
        log('desk-error', { error: firstLine(error) });
        return 'error';
      })
      .finally(() => {
        busy = null;
      });
    return busy;
  }

  async function stop(now) {
    setWanted(db, false, now);
    return session.stop(now);
  }

  function status(now) {
    const running = session.current(now);
    return {
      wanted: isWanted(db),
      alive: running?.alive === true,
      pid: running?.alive ? running.pid : null,
      startedAt: running?.startedAt ?? null,
      pending: db.prepare('SELECT COUNT(*) AS n FROM inbox WHERE acked_at IS NULL').get().n,
      overdue: inbox.overdue(db, now).length,
      restarts: watch.restartsIn(db, now).length,
      held: kv.get(db, 'desk:hold') !== null,
      attach: `tmux -L ${SESSION} attach -t ${SESSION}`,
    };
  }

  return { prepare: projects => prepare(dzHome, deskProjects(projects)), start: (projects, now) => session.start(deskProjects(projects), now), stop, status, step };
}

module.exports = { createDeskManager, setWanted, isWanted, deskProjects };
