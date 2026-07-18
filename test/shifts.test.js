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

test('startBreak/endBreak record a break with a computed duration', () => {
  const nowRef = { value: 1_700_000_000_000 };
  const tracker = makeTracker(nowRef);
  tracker.startShift('drv_1', { lat: 1, long: 1 });

  const started = tracker.startBreak('drv_1');
  assert.equal(started.breaks.length, 1);
  assert.equal(started.breaks[0].endedAt, null);

  nowRef.value += 15 * 60 * 1000;
  const ended = tracker.endBreak('drv_1');
  assert.equal(ended.breaks[0].durationMs, 15 * 60 * 1000);
});

test('startWait/endWait record a wait period with a computed duration', () => {
  const nowRef = { value: 1_700_000_000_000 };
  const tracker = makeTracker(nowRef);
  tracker.startShift('drv_1', { lat: 1, long: 1 });

  tracker.startWait('drv_1');
  nowRef.value += 5 * 60 * 1000;
  const ended = tracker.endWait('drv_1');
  assert.equal(ended.waits.length, 1);
  assert.equal(ended.waits[0].durationMs, 5 * 60 * 1000);
});

test('breaks and waits require an active shift and reject double-starts/ends', () => {
  const nowRef = { value: 1_700_000_000_000 };
  const tracker = makeTracker(nowRef);
  assert.throws(() => tracker.startBreak('drv_1'), (e) => e.code === 'SHIFT_NOT_ACTIVE');

  tracker.startShift('drv_1', { lat: 1, long: 1 });
  assert.throws(() => tracker.endBreak('drv_1'), (e) => e.code === 'SHIFT_BREAK_NOT_ACTIVE');
  tracker.startBreak('drv_1');
  assert.throws(() => tracker.startBreak('drv_1'), (e) => e.code === 'SHIFT_BREAK_ALREADY_ACTIVE');

  assert.throws(() => tracker.endWait('drv_1'), (e) => e.code === 'SHIFT_WAIT_NOT_ACTIVE');
  tracker.startWait('drv_1');
  assert.throws(() => tracker.startWait('drv_1'), (e) => e.code === 'SHIFT_WAIT_ALREADY_ACTIVE');
});

test('getDurations sums multiple breaks and wait periods for a shift', () => {
  const nowRef = { value: 1_700_000_000_000 };
  const tracker = makeTracker(nowRef);
  const shift = tracker.startShift('drv_1', { lat: 1, long: 1 });

  tracker.startBreak('drv_1');
  nowRef.value += 10 * 60 * 1000;
  tracker.endBreak('drv_1');

  tracker.startWait('drv_1');
  nowRef.value += 20 * 60 * 1000;
  tracker.endWait('drv_1');

  tracker.startBreak('drv_1');
  nowRef.value += 5 * 60 * 1000;
  tracker.endBreak('drv_1');

  const durations = tracker.getDurations('drv_1', shift.id);
  assert.equal(durations.totalBreakMs, 15 * 60 * 1000);
  assert.equal(durations.totalWaitMs, 20 * 60 * 1000);
});

test('getDurations throws for an unknown shift', () => {
  const nowRef = { value: 1_700_000_000_000 };
  const tracker = makeTracker(nowRef);
  assert.throws(() => tracker.getDurations('drv_1', 'nope'), (e) => e.code === 'SHIFT_NOT_FOUND');
});

test('addGpsPoint accumulates distance across consecutive points', () => {
  const nowRef = { value: 1_700_000_000_000 };
  const tracker = makeTracker(nowRef);
  const shift = tracker.startShift('drv_1', { lat: 40.7128, long: -74.006 });

  // A single point has nothing to accumulate against yet.
  const afterFirst = tracker.addGpsPoint('drv_1', { lat: 40.7128, long: -74.006 });
  assert.equal(afterFirst.trip.gpsDistanceMiles, 0);

  // Roughly the straight-line distance from NYC to Philadelphia (~80 miles).
  tracker.addGpsPoint('drv_1', { lat: 39.9526, long: -75.1652 });
  const distance = tracker.getTripDistance('drv_1', shift.id);
  assert.equal(distance.source, 'gps');
  assert.ok(distance.distanceMiles > 75 && distance.distanceMiles < 85, `expected ~80mi, got ${distance.distanceMiles}`);
});

test('addGpsPoint rejects an invalid location and requires an active shift', () => {
  const nowRef = { value: 1_700_000_000_000 };
  const tracker = makeTracker(nowRef);
  assert.throws(() => tracker.addGpsPoint('drv_1', { lat: 1, long: 1 }), (e) => e.code === 'SHIFT_NOT_ACTIVE');

  tracker.startShift('drv_1', { lat: 1, long: 1 });
  assert.throws(() => tracker.addGpsPoint('drv_1', { lat: 200, long: 1 }), (e) => e.code === 'SHIFT_LOCATION');
});

test('setOdometer takes precedence over GPS-accumulated distance', () => {
  const nowRef = { value: 1_700_000_000_000 };
  const tracker = makeTracker(nowRef);
  const shift = tracker.startShift('drv_1', { lat: 40.7128, long: -74.006 });

  tracker.addGpsPoint('drv_1', { lat: 40.7128, long: -74.006 });
  tracker.addGpsPoint('drv_1', { lat: 39.9526, long: -75.1652 });
  const gpsOnly = tracker.getTripDistance('drv_1', shift.id);
  assert.equal(gpsOnly.source, 'gps');

  tracker.setOdometer('drv_1', { startMiles: 1000, endMiles: 1042.5 });
  const withOverride = tracker.getTripDistance('drv_1', shift.id);
  assert.equal(withOverride.source, 'odometer');
  assert.equal(withOverride.distanceMiles, 42.5);
});

test('setOdometer validates readings', () => {
  const nowRef = { value: 1_700_000_000_000 };
  const tracker = makeTracker(nowRef);
  tracker.startShift('drv_1', { lat: 1, long: 1 });
  assert.throws(() => tracker.setOdometer('drv_1', { startMiles: -1, endMiles: 10 }), (e) => e.code === 'SHIFT_ODOMETER');
  assert.throws(() => tracker.setOdometer('drv_1', { startMiles: 10, endMiles: 5 }), (e) => e.code === 'SHIFT_ODOMETER');
});
