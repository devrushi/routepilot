import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bucketWeeklyProfit, renderWeeklyProfitChartSvg } from '../src/analytics.js';

// Jan 1, 2024 is a Monday, so Jan 1-7 is ISO week 2024-W01 and Jan 8-14 is 2024-W02.
const W1_DAY2 = Date.UTC(2024, 0, 2);
const W1_DAY3 = Date.UTC(2024, 0, 3);
const W2_DAY3 = Date.UTC(2024, 0, 10);
const W2_DAY4 = Date.UTC(2024, 0, 11);

test('bucketWeeklyProfit groups earnings/expenses into ISO weeks and computes gross/net', () => {
  const buckets = bucketWeeklyProfit({
    earnings: [{ at: W1_DAY2, amount: 100 }, { at: W1_DAY3, amount: 150 }, { at: W2_DAY3, amount: 200 }],
    expenses: [{ at: W1_DAY2, amount: 40 }, { at: W2_DAY4, amount: 80 }],
  });

  assert.equal(buckets.length, 2);
  assert.equal(buckets[0].week, '2024-W01');
  assert.equal(buckets[0].weekStart, '2024-01-01');
  assert.equal(buckets[0].gross, 250);
  assert.equal(buckets[0].expenses, 40);
  assert.equal(buckets[0].net, 210);

  assert.equal(buckets[1].week, '2024-W02');
  assert.equal(buckets[1].weekStart, '2024-01-08');
  assert.equal(buckets[1].gross, 200);
  assert.equal(buckets[1].expenses, 80);
  assert.equal(buckets[1].net, 120);
});

test('bucketWeeklyProfit returns weeks sorted oldest first regardless of input order', () => {
  const buckets = bucketWeeklyProfit({
    earnings: [{ at: W2_DAY3, amount: 200 }, { at: W1_DAY2, amount: 100 }],
    expenses: [],
  });
  assert.deepEqual(buckets.map((b) => b.week), ['2024-W01', '2024-W02']);
});

test('bucketWeeklyProfit handles a week with only expenses (net goes negative)', () => {
  const buckets = bucketWeeklyProfit({ earnings: [], expenses: [{ at: W1_DAY2, amount: 50 }] });
  assert.equal(buckets.length, 1);
  assert.equal(buckets[0].gross, 0);
  assert.equal(buckets[0].expenses, 50);
  assert.equal(buckets[0].net, -50);
});

test('bucketWeeklyProfit rejects malformed records', () => {
  assert.throws(() => bucketWeeklyProfit({ earnings: [{ at: 'nope', amount: 5 }] }), (e) => e.code === 'ANALYTICS_RECORDS');
  assert.throws(() => bucketWeeklyProfit({ expenses: [{ at: W1_DAY2, amount: 'nope' }] }), (e) => e.code === 'ANALYTICS_RECORDS');
});

test('bucketWeeklyProfit returns an empty array for no data', () => {
  assert.deepEqual(bucketWeeklyProfit({}), []);
});

test('renderWeeklyProfitChartSvg produces a well-formed SVG string without throwing', () => {
  const buckets = bucketWeeklyProfit({
    earnings: [{ at: W1_DAY2, amount: 100 }, { at: W2_DAY3, amount: 200 }],
    expenses: [{ at: W1_DAY2, amount: 40 }],
  });
  const svg = renderWeeklyProfitChartSvg(buckets);
  assert.match(svg, /^<svg /);
  assert.match(svg, /<\/svg>$/);
  assert.match(svg, /2024-W01/);
});

test('renderWeeklyProfitChartSvg does not throw for an empty bucket list', () => {
  const svg = renderWeeklyProfitChartSvg([]);
  assert.match(svg, /^<svg /);
});
