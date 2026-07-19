import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createNotificationScheduler,
  createMockPushProvider,
  shiftMissingMileage,
  receiptOverdue,
} from '../src/notifications.js';
import { createShiftTracker } from '../src/shifts.js';
import { createReceiptProcessor } from '../src/receipts.js';

test('shiftMissingMileage flags a completed shift with no GPS or odometer data', async () => {
  const tracker = createShiftTracker({ now: () => 1_700_000_000_000 });
  await tracker.startShift('drv_1', { lat: 1, long: 1 });
  const shift = await tracker.endShift('drv_1', { lat: 1, long: 1 });
  assert.equal(shiftMissingMileage(shift), true);
});

test('shiftMissingMileage does not flag a shift with GPS distance, an odometer reading, or one still active', async () => {
  const tracker = createShiftTracker({ now: () => 1_700_000_000_000 });
  const active = await tracker.startShift('drv_1', { lat: 1, long: 1 });
  assert.equal(shiftMissingMileage(active), false); // still active

  await tracker.addGpsPoint('drv_1', { lat: 1, long: 1 });
  await tracker.addGpsPoint('drv_1', { lat: 1.01, long: 1.01 });
  const withGps = await tracker.endShift('drv_1', { lat: 1.01, long: 1.01 });
  assert.equal(shiftMissingMileage(withGps), false);

  await tracker.startShift('drv_2', { lat: 1, long: 1 });
  await tracker.setOdometer('drv_2', { startMiles: 100, endMiles: 110 });
  const withOdometer = await tracker.endShift('drv_2', { lat: 1, long: 1 });
  assert.equal(shiftMissingMileage(withOdometer), false);
});

test('receiptOverdue fires only once the window has elapsed with no matching receipt', () => {
  const purchaseAt = 1_700_000_000_000;
  const windowMs = 48 * 60 * 60 * 1000;
  assert.equal(receiptOverdue(purchaseAt, [], { now: purchaseAt + windowMs - 1000, windowMs }), false); // window not elapsed yet
  assert.equal(receiptOverdue(purchaseAt, [], { now: purchaseAt + windowMs + 1000, windowMs }), true); // elapsed, nothing logged
  assert.equal(
    receiptOverdue(purchaseAt, [{ queuedAt: purchaseAt + 1000 }], { now: purchaseAt + windowMs + 1000, windowMs }),
    false, // a receipt was logged within the window
  );
});

test('sweepDriver sends a missing-mileage notification for a shift with no mileage logged', async () => {
  const shiftTracker = createShiftTracker({ now: () => 1_700_000_000_000 });
  await shiftTracker.startShift('drv_1', { lat: 1, long: 1 });
  await shiftTracker.endShift('drv_1', { lat: 1, long: 1 });

  const pushProvider = createMockPushProvider();
  const scheduler = createNotificationScheduler({ pushProvider, shiftTracker, now: () => 1_700_000_100_000 });

  const results = await scheduler.sweepDriver('drv_1');
  assert.equal(results.length, 1);
  assert.equal(results[0].notification.type, 'missing_mileage');
  assert.equal(pushProvider.sent.length, 1);
});

test('sweepDriver does not send a notification when a shift has mileage logged', async () => {
  const shiftTracker = createShiftTracker({ now: () => 1_700_000_000_000 });
  await shiftTracker.startShift('drv_1', { lat: 1, long: 1 });
  await shiftTracker.setOdometer('drv_1', { startMiles: 0, endMiles: 12 });
  await shiftTracker.endShift('drv_1', { lat: 1, long: 1 });

  const pushProvider = createMockPushProvider();
  const scheduler = createNotificationScheduler({ pushProvider, shiftTracker, now: () => 1_700_000_100_000 });

  const results = await scheduler.sweepDriver('drv_1');
  assert.equal(results.length, 0);
  assert.equal(pushProvider.sent.length, 0);
});

test('sweepDriver sends a late-receipt notification once the window elapses with nothing logged', async () => {
  const windowMs = 48 * 60 * 60 * 1000;
  const purchaseAt = 1_700_000_000_000;
  const receiptProcessor = createReceiptProcessor({ now: () => purchaseAt });
  const pushProvider = createMockPushProvider();
  const scheduler = createNotificationScheduler({
    pushProvider,
    receiptProcessor,
    receiptWindowMs: windowMs,
    now: () => purchaseAt + windowMs + 1000,
  });

  const results = await scheduler.sweepDriver('drv_1', { purchases: [{ id: 'pur_1', at: purchaseAt }] });
  assert.equal(results.length, 1);
  assert.equal(results[0].notification.type, 'late_receipt');
});

test('sweepDriver does not send a late-receipt notification when a receipt was queued on time', async () => {
  const windowMs = 48 * 60 * 60 * 1000;
  const purchaseAt = 1_700_000_000_000;
  const receiptProcessor = createReceiptProcessor({ now: () => purchaseAt + 1000 });
  receiptProcessor.queue('drv_1', { path: '/r1.jpg' });

  const pushProvider = createMockPushProvider();
  const scheduler = createNotificationScheduler({
    pushProvider,
    receiptProcessor,
    receiptWindowMs: windowMs,
    now: () => purchaseAt + windowMs + 1000,
  });

  const results = await scheduler.sweepDriver('drv_1', { purchases: [{ id: 'pur_1', at: purchaseAt }] });
  assert.equal(results.length, 0);
});
