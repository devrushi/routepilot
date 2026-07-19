import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createShiftTracker } from '../src/shifts.js';

function makeTracker(nowRef) {
  return createShiftTracker({ now: () => nowRef.value });
}

test('startShift opens a shift with a timestamp and location stamp', async () => {
  const nowRef = { value: 1_700_000_000_000 };
  const tracker = makeTracker(nowRef);
  const shift = await tracker.startShift('drv_1', { lat: 40.7128, long: -74.006 });
  assert.equal(shift.status, 'active');
  assert.equal(shift.startedAt, nowRef.value);
  assert.deepEqual(shift.startLocation, { lat: 40.7128, long: -74.006 });
  assert.equal(shift.endedAt, null);
  assert.equal((await tracker.getActive('drv_1')).id, shift.id);
});

test('startShift rejects a second shift while one is already active', async () => {
  const nowRef = { value: 1_700_000_000_000 };
  const tracker = makeTracker(nowRef);
  await tracker.startShift('drv_1', { lat: 1, long: 1 });
  await assert.rejects(() => tracker.startShift('drv_1', { lat: 2, long: 2 }), (e) => e.code === 'SHIFT_ALREADY_ACTIVE');
});

test('startShift rejects an invalid location', async () => {
  const nowRef = { value: 1_700_000_000_000 };
  const tracker = makeTracker(nowRef);
  await assert.rejects(() => tracker.startShift('drv_1', { lat: 200, long: 1 }), (e) => e.code === 'SHIFT_LOCATION');
  await assert.rejects(() => tracker.startShift('drv_1', {}), (e) => e.code === 'SHIFT_LOCATION');
});

test('endShift closes the active shift with a timestamp and location stamp', async () => {
  const nowRef = { value: 1_700_000_000_000 };
  const tracker = makeTracker(nowRef);
  const started = await tracker.startShift('drv_1', { lat: 1, long: 1 });
  nowRef.value += 3 * 60 * 60 * 1000;
  const ended = await tracker.endShift('drv_1', { lat: 2, long: 2 });
  assert.equal(ended.id, started.id);
  assert.equal(ended.status, 'completed');
  assert.equal(ended.endedAt, nowRef.value);
  assert.deepEqual(ended.endLocation, { lat: 2, long: 2 });
  assert.equal(await tracker.getActive('drv_1'), null);
});

test('endShift rejects when the driver has no active shift', async () => {
  const nowRef = { value: 1_700_000_000_000 };
  const tracker = makeTracker(nowRef);
  await assert.rejects(() => tracker.endShift('drv_1', { lat: 1, long: 1 }), (e) => e.code === 'SHIFT_NOT_ACTIVE');

  await tracker.startShift('drv_1', { lat: 1, long: 1 });
  await tracker.endShift('drv_1', { lat: 2, long: 2 });
  await assert.rejects(() => tracker.endShift('drv_1', { lat: 3, long: 3 }), (e) => e.code === 'SHIFT_NOT_ACTIVE');
});

test('list returns a driver\'s shifts oldest first, isolated per driver', async () => {
  const nowRef = { value: 1_700_000_000_000 };
  const tracker = makeTracker(nowRef);
  const first = await tracker.startShift('drv_1', { lat: 1, long: 1 });
  await tracker.endShift('drv_1', { lat: 1, long: 1 });
  nowRef.value += 1000;
  const second = await tracker.startShift('drv_1', { lat: 1, long: 1 });
  await tracker.startShift('drv_2', { lat: 5, long: 5 });

  const list = await tracker.list('drv_1');
  assert.equal(list.length, 2);
  assert.equal(list[0].id, first.id);
  assert.equal(list[1].id, second.id);
  assert.equal((await tracker.list('drv_2')).length, 1);
});

test('startBreak/endBreak record a break with a computed duration', async () => {
  const nowRef = { value: 1_700_000_000_000 };
  const tracker = makeTracker(nowRef);
  await tracker.startShift('drv_1', { lat: 1, long: 1 });

  const started = await tracker.startBreak('drv_1');
  assert.equal(started.breaks.length, 1);
  assert.equal(started.breaks[0].endedAt, null);

  nowRef.value += 15 * 60 * 1000;
  const ended = await tracker.endBreak('drv_1');
  assert.equal(ended.breaks[0].durationMs, 15 * 60 * 1000);
});

test('startWait/endWait record a wait period with a computed duration', async () => {
  const nowRef = { value: 1_700_000_000_000 };
  const tracker = makeTracker(nowRef);
  await tracker.startShift('drv_1', { lat: 1, long: 1 });

  await tracker.startWait('drv_1');
  nowRef.value += 5 * 60 * 1000;
  const ended = await tracker.endWait('drv_1');
  assert.equal(ended.waits.length, 1);
  assert.equal(ended.waits[0].durationMs, 5 * 60 * 1000);
});

test('breaks and waits require an active shift and reject double-starts/ends', async () => {
  const nowRef = { value: 1_700_000_000_000 };
  const tracker = makeTracker(nowRef);
  await assert.rejects(() => tracker.startBreak('drv_1'), (e) => e.code === 'SHIFT_NOT_ACTIVE');

  await tracker.startShift('drv_1', { lat: 1, long: 1 });
  await assert.rejects(() => tracker.endBreak('drv_1'), (e) => e.code === 'SHIFT_BREAK_NOT_ACTIVE');
  await tracker.startBreak('drv_1');
  await assert.rejects(() => tracker.startBreak('drv_1'), (e) => e.code === 'SHIFT_BREAK_ALREADY_ACTIVE');

  await assert.rejects(() => tracker.endWait('drv_1'), (e) => e.code === 'SHIFT_WAIT_NOT_ACTIVE');
  await tracker.startWait('drv_1');
  await assert.rejects(() => tracker.startWait('drv_1'), (e) => e.code === 'SHIFT_WAIT_ALREADY_ACTIVE');
});

test('getDurations sums multiple breaks and wait periods for a shift', async () => {
  const nowRef = { value: 1_700_000_000_000 };
  const tracker = makeTracker(nowRef);
  const shift = await tracker.startShift('drv_1', { lat: 1, long: 1 });

  await tracker.startBreak('drv_1');
  nowRef.value += 10 * 60 * 1000;
  await tracker.endBreak('drv_1');

  await tracker.startWait('drv_1');
  nowRef.value += 20 * 60 * 1000;
  await tracker.endWait('drv_1');

  await tracker.startBreak('drv_1');
  nowRef.value += 5 * 60 * 1000;
  await tracker.endBreak('drv_1');

  const durations = await tracker.getDurations('drv_1', shift.id);
  assert.equal(durations.totalBreakMs, 15 * 60 * 1000);
  assert.equal(durations.totalWaitMs, 20 * 60 * 1000);
});

test('getDurations throws for an unknown shift', async () => {
  const nowRef = { value: 1_700_000_000_000 };
  const tracker = makeTracker(nowRef);
  await assert.rejects(() => tracker.getDurations('drv_1', 'nope'), (e) => e.code === 'SHIFT_NOT_FOUND');
});

test('addGpsPoint accumulates distance across consecutive points', async () => {
  const nowRef = { value: 1_700_000_000_000 };
  const tracker = makeTracker(nowRef);
  const shift = await tracker.startShift('drv_1', { lat: 40.7128, long: -74.006 });

  // A single point has nothing to accumulate against yet.
  const afterFirst = await tracker.addGpsPoint('drv_1', { lat: 40.7128, long: -74.006 });
  assert.equal(afterFirst.trip.gpsDistanceMiles, 0);

  // Roughly the straight-line distance from NYC to Philadelphia (~80 miles).
  await tracker.addGpsPoint('drv_1', { lat: 39.9526, long: -75.1652 });
  const distance = await tracker.getTripDistance('drv_1', shift.id);
  assert.equal(distance.source, 'gps');
  assert.ok(distance.distanceMiles > 75 && distance.distanceMiles < 85, `expected ~80mi, got ${distance.distanceMiles}`);
});

test('addGpsPoint rejects an invalid location and requires an active shift', async () => {
  const nowRef = { value: 1_700_000_000_000 };
  const tracker = makeTracker(nowRef);
  await assert.rejects(() => tracker.addGpsPoint('drv_1', { lat: 1, long: 1 }), (e) => e.code === 'SHIFT_NOT_ACTIVE');

  await tracker.startShift('drv_1', { lat: 1, long: 1 });
  await assert.rejects(() => tracker.addGpsPoint('drv_1', { lat: 200, long: 1 }), (e) => e.code === 'SHIFT_LOCATION');
});

test('setOdometer takes precedence over GPS-accumulated distance', async () => {
  const nowRef = { value: 1_700_000_000_000 };
  const tracker = makeTracker(nowRef);
  const shift = await tracker.startShift('drv_1', { lat: 40.7128, long: -74.006 });

  await tracker.addGpsPoint('drv_1', { lat: 40.7128, long: -74.006 });
  await tracker.addGpsPoint('drv_1', { lat: 39.9526, long: -75.1652 });
  const gpsOnly = await tracker.getTripDistance('drv_1', shift.id);
  assert.equal(gpsOnly.source, 'gps');

  await tracker.setOdometer('drv_1', { startMiles: 1000, endMiles: 1042.5 });
  const withOverride = await tracker.getTripDistance('drv_1', shift.id);
  assert.equal(withOverride.source, 'odometer');
  assert.equal(withOverride.distanceMiles, 42.5);
});

test('setOdometer validates readings', async () => {
  const nowRef = { value: 1_700_000_000_000 };
  const tracker = makeTracker(nowRef);
  await tracker.startShift('drv_1', { lat: 1, long: 1 });
  await assert.rejects(() => tracker.setOdometer('drv_1', { startMiles: -1, endMiles: 10 }), (e) => e.code === 'SHIFT_ODOMETER');
  await assert.rejects(() => tracker.setOdometer('drv_1', { startMiles: 10, endMiles: 5 }), (e) => e.code === 'SHIFT_ODOMETER');
});
