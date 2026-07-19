import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReceiptProcessor, createMockOcrProvider, extractFields } from '../src/receipts.js';

function makeProcessor(nowRef, ocrProvider) {
  return createReceiptProcessor({ now: () => nowRef.value, ocrProvider });
}

test('queue accepts an upload and stores it as queued', () => {
  const nowRef = { value: 1_700_000_000_000 };
  const processor = makeProcessor(nowRef);
  const receipt = processor.queue('drv_1', { path: '/uploads/r1.jpg', mimeType: 'image/jpeg' });
  assert.equal(receipt.status, 'queued');
  assert.equal(receipt.queuedAt, nowRef.value);
  assert.equal(receipt.fields, null);
  assert.equal(processor.list('drv_1').length, 1);
  assert.equal(processor.list('drv_1', { status: 'queued' }).length, 1);
});

test('queue rejects an upload with neither buffer nor path', () => {
  const nowRef = { value: 1_700_000_000_000 };
  const processor = makeProcessor(nowRef);
  assert.throws(() => processor.queue('drv_1', {}), (e) => e.code === 'RECEIPT_UPLOAD');
});

test('process extracts fields from a mocked OCR response with structured fields', async () => {
  const nowRef = { value: 1_700_000_000_000 };
  const ocrProvider = createMockOcrProvider({
    responses: new Map([
      ['/uploads/r1.jpg', { text: 'Shell Gas Station\nTOTAL $42.17', fields: { vendor: 'Shell', total: 42.17, currency: 'USD', date: '2024-03-01' } }],
    ]),
  });
  const processor = makeProcessor(nowRef, ocrProvider);
  const receipt = processor.queue('drv_1', { path: '/uploads/r1.jpg' });

  const processed = await processor.process('drv_1', receipt.id);
  assert.equal(processed.status, 'processed');
  assert.equal(processed.processedAt, nowRef.value);
  assert.deepEqual(processed.fields, { vendor: 'Shell', date: '2024-03-01', total: 42.17, currency: 'USD' });
});

test('process falls back to parsing raw text when the provider has no structured fields', async () => {
  const nowRef = { value: 1_700_000_000_000 };
  const ocrProvider = createMockOcrProvider({
    responses: new Map([
      ['/uploads/r2.jpg', { text: 'Joe\'s Diner\n2024-05-10\nTOTAL: $18.50' }],
    ]),
  });
  const processor = makeProcessor(nowRef, ocrProvider);
  const receipt = processor.queue('drv_1', { path: '/uploads/r2.jpg' });

  const processed = await processor.process('drv_1', receipt.id);
  assert.equal(processed.fields.vendor, "Joe's Diner");
  assert.equal(processed.fields.date, '2024-05-10');
  assert.equal(processed.fields.total, 18.5);
  assert.equal(processed.fields.currency, 'USD');
});

test('a failed OCR call marks the receipt failed instead of throwing', async () => {
  const nowRef = { value: 1_700_000_000_000 };
  const ocrProvider = { recognize: async () => { throw new Error('provider unavailable'); } };
  const processor = makeProcessor(nowRef, ocrProvider);
  const receipt = processor.queue('drv_1', { path: '/uploads/r3.jpg' });

  const processed = await processor.process('drv_1', receipt.id);
  assert.equal(processed.status, 'failed');
  assert.equal(processed.error, 'provider unavailable');
});

test('processAll drains the FIFO queue across drivers in order', async () => {
  const nowRef = { value: 1_700_000_000_000 };
  const ocrProvider = createMockOcrProvider({ defaultResponse: { text: 'Vendor\nTOTAL $1.00' } });
  const processor = makeProcessor(nowRef, ocrProvider);
  const a = processor.queue('drv_1', { path: '/a.jpg' });
  const b = processor.queue('drv_2', { path: '/b.jpg' });

  const results = await processor.processAll();
  assert.deepEqual(results.map((r) => r.id), [a.id, b.id]);
  assert.equal(processor.list('drv_1', { status: 'queued' }).length, 0);
  assert.equal(processor.get('drv_1', a.id).status, 'processed');
  assert.equal(processor.get('drv_2', b.id).status, 'processed');
});

test('extractFields parses currency symbols and prefers provided fields', () => {
  assert.equal(extractFields({ text: 'Total: £12.50' }).currency, 'GBP');
  assert.equal(extractFields({ text: 'Total: €12.50' }).currency, 'EUR');
  assert.deepEqual(extractFields({ text: 'ignored', fields: { vendor: 'Explicit Co' } }).vendor, 'Explicit Co');
});
