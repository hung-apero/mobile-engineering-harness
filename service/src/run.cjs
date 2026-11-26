const kv = require('./kv.cjs');
const { tick } = require('./tick.cjs');
const { acquireLock, releaseLock, ownsLock } = require('./service-lock.cjs');
const { firstLine } = require('./redact.cjs');
const { createWeb } = require('./web/server.cjs');
const { startDeskSocket } = require('./desk-service.cjs');
const { WEB_URL } = require('./specs/kit.cjs');

const TICK_MS = 10000;
const STOP_WAIT_MS = 15000;
const BUG_STOP_WAIT_MS = 30000;
const CLOSE_WAIT_MS = 2000;

class ExpectedError extends Error {}

async function within(promise, ms) {
  let timer;
  const limit = new Promise(resolve => {
    timer = setTimeout(resolve, ms);
  });
  await Promise.race([promise.catch(() => {}), limit]);
  clearTimeout(timer);
}

async function settleSteps(ctx, waitMs) {
  await within(Promise.all([ctx.bugStepPending, ctx.specStepPending, ctx.boardStepPending, ctx.deskStepPending].map(pending => Promise.resolve(pending).catch(() => {}))), waitMs);
  await within(Promise.allSettled([ctx.bugs?.closeAll(), ctx.specs?.closeAll()]), CLOSE_WAIT_MS);
}

async function startWeb(ctx) {
  kv.del(ctx.db, WEB_URL);
  try {
    const web = createWeb(ctx, { facade: ctx.facade });
    const { url } = await web.start();
    kv.set(ctx.db, WEB_URL, url, Date.now());
    ctx.log('web-started', { url });
    return web;
  } catch (error) {
    ctx.log('web-error', { route: 'start', error: firstLine(error) });
    return null;
  }
}

async function runService(ctx, { tickMs = TICK_MS, stopWaitMs = STOP_WAIT_MS, bugWaitMs = BUG_STOP_WAIT_MS, tickFn = tick, on = (name, fn) => process.on(name, fn) } = {}) {
  let onStop = () => {};
  const stop = () => {
    if (ctx.stopping) return;
    ctx.stopping = true;
    onStop();
  };
  for (const name of ['SIGTERM', 'SIGINT']) on(name, stop);

  const lock = acquireLock(ctx.db, ctx.lockFile);
  if (!lock.ok) throw new ExpectedError(`dz đang chạy rồi (pid ${lock.pid})`);
  ctx.log('service-started', { pid: process.pid });
  const web = await startWeb(ctx);
  const deskSocket = await startDeskSocket(ctx);

  const runTick = () => new Promise(resolve => {
    onStop = () => setTimeout(resolve, stopWaitMs);
    tickFn(ctx, Date.now())
      .catch(error => ctx.log('tick-error', { error: firstLine(error) }))
      .then(resolve);
  });
  const rest = ms => new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    onStop = () => {
      clearTimeout(timer);
      resolve();
    };
  });

  let code = 0;
  try {
    while (!ctx.stopping) {
      if (!ownsLock(ctx.lockFile)) {
        ctx.log('lock-lost', { pid: process.pid });
        code = 1;
        break;
      }
      const began = Date.now();
      await runTick();
      if (!ctx.stopping) await rest(Math.max(0, tickMs - (Date.now() - began)));
    }
  } finally {
    if (deskSocket) await within(deskSocket.stop(), CLOSE_WAIT_MS);
    if (web) await within(web.stop(), CLOSE_WAIT_MS);
    await settleSteps(ctx, bugWaitMs);
    ctx.log('service-stopped', { pid: process.pid, code });
    releaseLock(ctx.db, ctx.lockFile);
  }
  return code;
}

module.exports = { runService, ExpectedError };
