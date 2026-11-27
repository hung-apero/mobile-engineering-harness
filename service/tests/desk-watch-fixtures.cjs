const assert = require('node:assert/strict');
const inbox = require('../src/inbox.cjs');
const { createDeskManager, setWanted } = require('../src/desk.cjs');
const { NOW, MIN, CHANNEL, THREAD, idAt, project, deskHome, message } = require('./desk-fixtures.cjs');

const projects = [project('AAA', { live: true })];

function setupWatch(t, { wanted = true } = {}) {
  const h = deskHome(t);
  const events = [];
  const state = { row: null, failStart: false, missed: null, onStart: () => {} };
  const session = {
    current: () => state.row,
    start: async (list, now) => {
      if (state.failStart) throw new Error('tmux hỏng');
      events.push('start');
      state.row = { pid: 1000 + events.length, startedAt: now, alive: true };
      await state.onStart();
      return state.row;
    },
    stop: async () => {
      events.push('stop');
      state.row = null;
      return true;
    },
  };
  const reconciler = {
    reconcile: async (list, now) => {
      events.push('read');
      if (state.missed) inbox.collect(h.db, CHANNEL, [state.missed], now);
      return { added: state.missed ? 1 : 0, threads: state.incomplete ? [] : [{ id: THREAD, parent: CHANNEL }], complete: state.incomplete !== true };
    },
  };
  const manager = createDeskManager({ db: h.db, dzHome: h.home, bot: null, session, reconciler, log: (event, fields) => events.push({ event, ...fields }) });
  if (wanted) setWanted(h.db, true, NOW);
  const names = () => events.filter(item => typeof item === 'string');
  const waits = () => h.db.prepare("SELECT * FROM waits WHERE state = 'open'").all();
  const unacked = (now = NOW) => inbox.record(h.db, message(idAt(now)), CHANNEL, now);
  return { ...h, state, events, manager, names, waits, unacked, step: now => manager.step(projects, now) };
}

async function burn(h, from) {
  let now = from;
  for (let i = 0; i < 5; i += 1) {
    h.state.row.alive = false;
    assert.equal(await h.step(now), 'restarted');
    now += 9 * MIN;
  }
  return now;
}

module.exports = { setupWatch, burn };
