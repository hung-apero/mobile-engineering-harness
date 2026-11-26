const { test } = require('node:test');
const assert = require('node:assert/strict');
const { capacity, grant } = require('../src/slots.cjs');

const t = s => Date.parse(`${s}+07:00`);
const HOURS = t('2026-11-25T10:00:00');
const NIGHT = t('2026-11-25T20:00:00');
const limits = { code_agents_working: 2, code_agents_off: 3, reserved_for_bug: 1, build: 1, bugs_per_project: 2 };
const job = (kind, slots, project = 'a') => ({ kind, slots, project });
const running = (kind, slotsGranted, project = 'a') => ({ kind, slotsGranted, project });

test('2 in working hours, 3 outside', () => {
  assert.equal(capacity(HOURS, limits), 2);
  assert.equal(capacity(NIGHT, limits), 3);
});

test('feature may not take the reserved slot: hours, nothing running, slots 3 → 1', () => {
  assert.equal(grant({ job: job('feature', 3), running: [], limits, now: HOURS }), 1);
});

test('bug may take both: hours, nothing running, slots 3 → 2', () => {
  assert.equal(grant({ job: job('bug', 3), running: [], limits, now: HOURS }), 2);
});

test('bugs_per_project caps at 2 outside hours', () => {
  assert.equal(grant({ job: job('bug', 3), running: [], limits, now: NIGHT }), 2);
  assert.equal(grant({ job: job('bug', 3), running: [running('bug', 1)], limits, now: NIGHT }), 1);
  assert.equal(grant({ job: job('bug', 3, 'b'), running: [running('bug', 2)], limits, now: NIGHT }), 1);
  assert.equal(grant({ job: job('bug', 1), running: [running('bug', 2)], limits, now: NIGHT }), 0);
});

test('over capacity when the clock turns 9:00 grants 0 and never negative', () => {
  const busy = [running('feature', 1), running('feature', 1), running('bug', 1)];
  assert.equal(grant({ job: job('bug', 1), running: busy, limits, now: t('2026-11-25T09:00:00') }), 0);
  assert.equal(grant({ job: job('feature', 1), running: busy, limits, now: t('2026-11-25T09:00:00') }), 0);
});

test('a running bug consumes the reservation: feature may then use the free slot', () => {
  assert.equal(grant({ job: job('feature', 1), running: [running('bug', 1)], limits, now: HOURS }), 1);
});

test('feature already using a slot leaves the reserved one: another feature gets 0', () => {
  assert.equal(grant({ job: job('feature', 1), running: [running('feature', 1)], limits, now: HOURS }), 0);
});
