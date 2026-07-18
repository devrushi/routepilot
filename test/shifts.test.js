import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createShiftTracker } from '../src/shifts.js';

function makeTracker(nowRef) {
  return createShiftTracker({ now: () => nowRef.value });
}

test('startShift opens a shift with a timestamp and location stamp', () => {
  const nowRef = { value: 1_700_000_000_000 };
  const tracker = makeTracker(nowRef);
  const shift = tracker.startShift('drv_1', { lat: 40.7128, long: -74.006 });
  assert.equal(shift.status, 'active');
  assert.equal(shift.startedAt, nowRef.value);
  assert.deepEqual(shift.startLocation, { lat: 40.7128, long: -74.006 });
  assert.equal(shift.endedAt, null);
  assert.equal(tracker.getActive('drv_1').id, shift.id);
});

test('startShift rejects a second shift while one is already active', () => {
  const nowRef = { value: 1_700_000_000_000 };
  const tracker = makeTracker(nowRef);
  tracker.startShift('drv_1', { lat: 1, long: 1 });
  assert.throws(() => tracker.startShift('drv_1', { lat: 2, long: 2 }), (e) => e.code === 'SHIFT_ALREADY_ACTIVE');
});

test('startShift rejects an invalid location', () => {
  const nowRef = { value: 1_700_000_000_000 };
  const tracker = makeTracker(nowRef);
  assert.throws(() => tracker.startShift('drv_1', { lat: 200, long: 1 }), (e) => e.code === 'SHIFT_LOCATION');
  assert.throws(() => tracker.startShift('drv_1', {}), (e) => e.code === 'SHIFT_LOCATION');
});

test('endShift closes the active shift with a timestamp and location stamp', () => {
  const nowRef = { value: 1_700_000_000_000 };
  const tracker = makeTracker(nowRef);
  const started = tracker.startShift('drv_1', { lat: 1, long: 1 });
  nowRef.value += 3 * 60 * 60 * 1000;
  const ended = tracker.endShift('drv_1', { lat: 2, long: 2 });
  assert.equal(ended.id, started.id);
  assert.equal(ended.status, 'completed');
  assert.equal(ended.endedAt, nowRef.value);
  assert.deepEqual(ended.endLocation, { lat: 2, long: 2 });
  assert.equal(tracker.getActive('drv_1'), null);
});

test('endShift rejects when the driver has no active shift', () => {
  const nowRef = { value: 1_700_000_000_000 };
  const tracker = makeTracker(nowRef);
  assert.throws(() => tracker.endShift('drv_1', { lat: 1, long: 1 }), (e) => e.code === 'SHIFT_NOT_ACTIVE');

  tracker.startShift('drv_1', { lat: 1, long: 1 });
  tracker.endShift('drv_1', { lat: 2, long: 2 });
  assert.throws(() => tracker.endShift('drv_1', { lat: 3, long: 3 }), (e) => e.code === 'SHIFT_NOT_ACTIVE');
});

test('list returns a driver\'s shifts oldest first, isolated per driver', () => {
  const nowRef = { value: 1_700_000_000_000 };
  const tracker = makeTracker(nowRef);
  const first = tracker.startShift('drv_1', { lat: 1, long: 1 });
  tracker.endShift('drv_1', { lat: 1, long: 1 });
  nowRef.value += 1000;
  const second = tracker.startShift('drv_1', { lat: 1, long: 1 });
  tracker.startShift('drv_2', { lat: 5, long: 5 });

  const list = tracker.list('drv_1');
  assert.equal(list.length, 2);
  assert.equal(list[0].id, first.id);
  assert.equal(list[1].id, second.id);
  assert.equal(tracker.list('drv_2').length, 1);
});
