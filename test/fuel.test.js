import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFuelLogger, convertCurrency, convertVolume } from '../src/fuel.js';

function makeLogger(nowRef) {
  return createFuelLogger({ now: () => nowRef.value });
}

test('logFuelPurchase stores a normalized record', async () => {
  const nowRef = { value: 1_700_000_000_000 };
  const logger = makeLogger(nowRef);
  const record = await logger.logFuelPurchase('drv_1', { amount: 50, currency: 'gbp', volume: 40, unit: 'liters' });
  assert.equal(record.type, 'fuel');
  assert.equal(record.currency, 'GBP');
  assert.equal(record.amountBase, 63.5); // 50 * 1.27
  assert.equal(record.unit, 'liter');
  assert.equal(record.volumeLiters, 40);
  assert.equal(record.at, nowRef.value);
  assert.equal((await logger.list('drv_1')).length, 1);
});

test('logFuelPurchase converts a gallons purchase to liters', async () => {
  const nowRef = { value: 1_700_000_000_000 };
  const logger = makeLogger(nowRef);
  const record = await logger.logFuelPurchase('drv_1', { amount: 30, currency: 'USD', volume: 10, unit: 'gallon' });
  assert.equal(record.volumeLiters, 37.854);
});

test('logFuelPurchase rejects invalid input', async () => {
  const nowRef = { value: 1_700_000_000_000 };
  const logger = makeLogger(nowRef);
  await assert.rejects(
    () => logger.logFuelPurchase('drv_1', { amount: -5, currency: 'USD', volume: 10, unit: 'liter' }),
    (e) => e.code === 'FUEL_AMOUNT',
  );
  await assert.rejects(
    () => logger.logFuelPurchase('drv_1', { amount: 10, currency: 'US', volume: 10, unit: 'liter' }),
    (e) => e.code === 'FUEL_CURRENCY',
  );
  await assert.rejects(
    () => logger.logFuelPurchase('drv_1', { amount: 10, currency: 'USD', volume: 10, unit: 'furlong' }),
    (e) => e.code === 'FUEL_UNIT',
  );
});

test('logChargingSession stores a normalized record', async () => {
  const nowRef = { value: 1_700_000_000_000 };
  const logger = makeLogger(nowRef);
  const record = await logger.logChargingSession('drv_1', { cost: 20, currency: 'EUR', kWh: 45 });
  assert.equal(record.type, 'charging');
  assert.equal(record.costBase, 21.6); // 20 * 1.08
  assert.equal(record.kWh, 45);
  assert.equal((await logger.list('drv_1', { type: 'charging' })).length, 1);
});

test('list separates fuel purchases from charging sessions', async () => {
  const nowRef = { value: 1_700_000_000_000 };
  const logger = makeLogger(nowRef);
  await logger.logFuelPurchase('drv_1', { amount: 10, currency: 'USD', volume: 5, unit: 'gallon' });
  await logger.logChargingSession('drv_1', { cost: 15, currency: 'USD', kWh: 30 });
  assert.equal((await logger.list('drv_1')).length, 2);
  assert.equal((await logger.list('drv_1', { type: 'fuel' })).length, 1);
  assert.equal((await logger.list('drv_1', { type: 'charging' })).length, 1);
});

test('convertCurrency converts known values between currencies', () => {
  assert.equal(convertCurrency(10, 'GBP', 'USD'), 12.7);
  assert.equal(convertCurrency(12.7, 'USD', 'GBP'), 10);
  assert.equal(convertCurrency(100, 'USD', 'USD'), 100);
});

test('convertCurrency rejects unknown currencies', () => {
  assert.throws(() => convertCurrency(10, 'XXX', 'USD'), (e) => e.code === 'FUEL_CURRENCY');
});

test('convertVolume converts known values between liters and gallons', () => {
  assert.equal(convertVolume(1, 'gallon', 'liter'), 3.785);
  assert.equal(convertVolume(10, 'liters', 'gallons'), 2.642);
  assert.equal(convertVolume(5, 'l', 'l'), 5);
});
