const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isWorking, addWorkingMinutes, workingDayKey } = require('../src/work-hours.cjs');

const t = s => Date.parse(`${s}+07:00`);

test('boundaries', () => {
  assert.equal(isWorking(t('2026-11-25T09:00:00')), true);
  assert.equal(isWorking(t('2026-11-25T18:00:00')), false);
  assert.equal(isWorking(t('2026-11-28T10:00:00')), false);
});

test('adds across night and weekend', () => {
  assert.equal(addWorkingMinutes(t('2026-11-25T10:00:00'), 240), t('2026-11-25T14:00:00'));
  assert.equal(addWorkingMinutes(t('2026-11-27T16:00:00'), 240), t('2026-11-30T11:00:00'));
  assert.equal(addWorkingMinutes(t('2026-11-28T10:00:00'), 60), t('2026-11-30T10:00:00'));
});

test('a deadline exactly at closing time stays that day', () => {
  assert.equal(addWorkingMinutes(t('2026-11-25T14:00:00'), 240), t('2026-11-25T18:00:00'));
});

test('workingDayKey uses Saigon date', () => {
  assert.equal(workingDayKey(t('2026-11-25T00:30:00')), '2026-11-25');
  assert.equal(workingDayKey(t('2026-11-25T23:59:00')), '2026-11-25');
});
