import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateExpenseCsv, generateMileageCsv, generateTaxExportPdf, renderPdf } from '../src/exports.js';

const EXPENSES = [
  { at: Date.UTC(2024, 2, 5), categoryLabel: 'Fuel', amount: 45.5, currency: 'USD' },
  { at: Date.UTC(2024, 2, 1), categoryLabel: 'Vehicle insurance', amount: 120, currency: 'USD' },
];

const MILEAGE = [
  { at: Date.UTC(2024, 2, 2), distanceMiles: 32.4, purpose: 'Deliveries' },
  { at: Date.UTC(2024, 2, 6), distanceMiles: 10, purpose: 'Airport run' },
];

test('generateExpenseCsv produces a known CSV, sorted by date, with the tax-ready columns', () => {
  const csv = generateExpenseCsv(EXPENSES);
  assert.equal(
    csv,
    'Date,Category,Amount,Currency\n' +
    '2024-03-01,Vehicle insurance,120,USD\n' +
    '2024-03-05,Fuel,45.5,USD\n',
  );
});

test('generateExpenseCsv filters to a date range', () => {
  const csv = generateExpenseCsv(EXPENSES, { from: Date.UTC(2024, 2, 3) });
  assert.equal(csv, 'Date,Category,Amount,Currency\n2024-03-05,Fuel,45.5,USD\n');
});

test('generateExpenseCsv quotes values containing commas', () => {
  const csv = generateExpenseCsv([{ at: Date.UTC(2024, 0, 1), categoryLabel: 'Other, misc', amount: 10, currency: 'USD' }]);
  assert.match(csv, /"Other, misc"/);
});

test('generateMileageCsv produces a known CSV with distance and purpose', () => {
  const csv = generateMileageCsv(MILEAGE);
  assert.equal(
    csv,
    'Date,Distance (mi),Purpose\n' +
    '2024-03-02,32.4,Deliveries\n' +
    '2024-03-06,10,Airport run\n',
  );
});

test('generateExpenseCsv/generateMileageCsv reject non-array input', () => {
  assert.throws(() => generateExpenseCsv('nope'), (e) => e.code === 'EXPORT_EXPENSES');
  assert.throws(() => generateMileageCsv(null), (e) => e.code === 'EXPORT_MILEAGE');
});

test('generateTaxExportPdf does not throw and returns a well-formed PDF buffer', () => {
  const pdf = generateTaxExportPdf({ expenses: EXPENSES, mileageEntries: MILEAGE, from: Date.UTC(2024, 2, 1), to: Date.UTC(2024, 2, 31) });
  assert.ok(Buffer.isBuffer(pdf));
  assert.ok(pdf.length > 0);
  assert.equal(pdf.subarray(0, 5).toString('latin1'), '%PDF-');
  assert.equal(pdf.subarray(-5).toString('latin1'), '%%EOF');
  assert.match(pdf.toString('latin1'), /RoutePilot Tax Export/);
});

test('generateTaxExportPdf does not throw for an empty dataset', () => {
  const pdf = generateTaxExportPdf({});
  assert.ok(Buffer.isBuffer(pdf));
  assert.match(pdf.toString('latin1'), /none/);
});

test('renderPdf paginates when lines overflow a single page', () => {
  const manyLines = Array.from({ length: 100 }, (_, i) => `Line ${i}`);
  const pdf = renderPdf(manyLines, { height: 200, margin: 20, lineHeight: 14 });
  const text = pdf.toString('latin1');
  const pageCount = (text.match(/\/Type \/Page(?!s)/g) || []).length;
  assert.ok(pageCount > 1, `expected multiple pages, got ${pageCount}`);
});
