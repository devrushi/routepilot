import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectCostAnomaly, createRouteCostTracker } from '../src/cost-anomaly.js';

const HISTORY = [50, 52, 48, 51, 49, 53, 47]; // mean 50, population stddev 2

test('detectCostAnomaly does not flag a cost within normal variance', () => {
  const result = detectCostAnomaly(51, HISTORY);
  assert.equal(result.isAnomaly, false);
  assert.equal(result.mean, 50);
  assert.equal(result.stddev, 2);
  assert.equal(result.zScore, 0.5);
});

test('detectCostAnomaly flags a clear outlier more than 2 standard deviations above the mean', () => {
  const result = detectCostAnomaly(60, HISTORY);
  assert.equal(result.isAnomaly, true);
  assert.equal(result.zScore, 5);
});

test('detectCostAnomaly never flags with fewer than 2 historical points', () => {
  assert.equal(detectCostAnomaly(1000, []).isAnomaly, false);
  assert.equal(detectCostAnomaly(1000, [10]).isAnomaly, false);
});

test('detectCostAnomaly handles zero-variance history without dividing by zero', () => {
  const flat = [50, 50, 50];
  assert.equal(detectCostAnomaly(50, flat).isAnomaly, false);
  assert.equal(detectCostAnomaly(80, flat).isAnomaly, true);
});

test('detectCostAnomaly rejects invalid input', () => {
  assert.throws(() => detectCostAnomaly(NaN, HISTORY), (e) => e.code === 'ANOMALY_COST');
  assert.throws(() => detectCostAnomaly(50, ['x']), (e) => e.code === 'ANOMALY_HISTORY');
});

test('createRouteCostTracker records history and flags an outlier for a driver\'s route', () => {
  const tracker = createRouteCostTracker();
  for (const cost of HISTORY) {
    tracker.recordCost('drv_1', 'downtown-loop', cost);
  }
  assert.deepEqual(tracker.history('drv_1', 'downtown-loop'), HISTORY);

  const normal = tracker.checkCost('drv_1', 'downtown-loop', 51);
  assert.equal(normal.isAnomaly, false);

  const outlier = tracker.checkCost('drv_1', 'downtown-loop', 200);
  assert.equal(outlier.isAnomaly, true);
});

test('recordAndCheck evaluates against prior history, then appends the new cost', () => {
  const tracker = createRouteCostTracker();
  for (const cost of HISTORY) {
    tracker.recordCost('drv_1', 'airport-run', cost);
  }
  const result = tracker.recordAndCheck('drv_1', 'airport-run', 200);
  assert.equal(result.isAnomaly, true);
  assert.equal(tracker.history('drv_1', 'airport-run').length, HISTORY.length + 1);
});

test('route history is isolated per driver and per route', () => {
  const tracker = createRouteCostTracker();
  tracker.recordCost('drv_1', 'route-a', 50);
  tracker.recordCost('drv_2', 'route-a', 999);
  tracker.recordCost('drv_1', 'route-b', 10);
  assert.deepEqual(tracker.history('drv_1', 'route-a'), [50]);
  assert.deepEqual(tracker.history('drv_2', 'route-a'), [999]);
  assert.deepEqual(tracker.history('drv_1', 'route-b'), [10]);
});
