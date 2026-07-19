// Receipt upload queueing and OCR-based key-value extraction.
//
// A driver uploads a receipt (image/PDF); it's queued rather than processed
// inline so a slow/rate-limited OCR call never blocks the request. Processing
// pulls the next queued receipt, runs it through an OCR **provider** — a
// small interface (`{ recognize(input) }`) any real engine can implement —
// and extracts the fields RoutePilot actually needs (vendor, date, total,
// currency) either from structured fields the provider already returns, or
// by parsing them out of raw recognized text as a fallback.
//
// No real OCR engine is wired up yet: `createMockOcrProvider` stands in,
// returning canned/injectable responses. Swap it for a real provider by
// passing a different `ocrProvider` to `createReceiptProcessor` — the queue
// and extraction logic here doesn't change.

import { randomUUID } from 'node:crypto';

export class ReceiptError extends Error {
  constructor(message, code = 'RECEIPT_INVALID') {
    super(message);
    this.name = 'ReceiptError';
    this.code = code;
  }
}

/**
 * A minimal mock OCR provider implementing the `{ recognize(input) }`
 * interface. `input` is `{ buffer, path, mimeType }` — a real provider reads
 * whichever it needs and calls out to an actual OCR/document-AI service.
 * This mock instead looks up a canned response by `path` (for deterministic
 * tests), falling back to `defaultResponse` or an empty result.
 * @param {object} [config]
 * @param {Map<string, {text?:string, fields?:object}>} [config.responses] Canned responses keyed by upload path.
 * @param {{text?:string, fields?:object}} [config.defaultResponse]
 */
export function createMockOcrProvider(config = {}) {
  const { responses = new Map(), defaultResponse = null } = config;
  return {
    async recognize(input) {
      const canned = input && input.path ? responses.get(input.path) : undefined;
      return canned ?? defaultResponse ?? { text: '', fields: {} };
    },
  };
}

// Best-effort field parsing from raw OCR text, used when a provider doesn't
// already return structured fields. Heuristics, not a full receipt parser:
// vendor = first non-blank line; date = first ISO or slash-formatted date;
// total = number following "total"; currency = inferred from a symbol.
function parseVendor(text) {
  const line = text.split('\n').map((l) => l.trim()).find(Boolean);
  return line ?? null;
}

function parseDate(text) {
  const match = text.match(/\b(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})\b/);
  return match ? match[1] : null;
}

function parseTotal(text) {
  const match = text.match(/total[:\s]*[$£€]?\s*([\d,]+\.\d{2})/i);
  return match ? Number(match[1].replace(/,/g, '')) : null;
}

function parseCurrency(text) {
  if (text.includes('€')) return 'EUR';
  if (text.includes('£')) return 'GBP';
  if (text.includes('$')) return 'USD';
  return null;
}

/**
 * Extract `{ vendor, date, total, currency }` from an OCR result. Fields the
 * provider already returned (`result.fields`) win; anything missing is
 * filled in by parsing `result.text`.
 * @param {{text?:string, fields?:object}} result
 */
export function extractFields(result = {}) {
  const text = typeof result.text === 'string' ? result.text : '';
  const provided = result.fields && typeof result.fields === 'object' ? result.fields : {};
  return {
    vendor: provided.vendor ?? parseVendor(text),
    date: provided.date ?? parseDate(text),
    total: provided.total ?? parseTotal(text),
    currency: provided.currency ?? parseCurrency(text),
  };
}

function deepFreeze(obj) {
  if (obj && typeof obj === 'object') {
    for (const key of Object.keys(obj)) deepFreeze(obj[key]);
    Object.freeze(obj);
  }
  return obj;
}

/**
 * Create the receipt processing queue.
 * @param {object} [config]
 * @param {Map} [config.store] Per-driver receipt store (defaults in-memory).
 * @param {Array} [config.pending] Global FIFO of `{ driverId, id }` awaiting processing.
 * @param {{recognize: (input:object) => Promise<{text?:string, fields?:object}>}} [config.ocrProvider]
 * @param {() => number} [config.now] Clock in ms (injectable for tests).
 * @param {() => string} [config.generateId] Receipt id generator.
 */
export function createReceiptProcessor(config = {}) {
  const {
    store = new Map(),
    pending = [],
    ocrProvider = createMockOcrProvider(),
    now = () => Date.now(),
    generateId = () => `rcpt_${randomUUID()}`,
  } = config;

  function requireDriverReceipts(driverId) {
    if (!driverId) {
      throw new ReceiptError('A driverId is required', 'RECEIPT_DRIVER');
    }
    let receipts = store.get(driverId);
    if (!receipts) {
      receipts = new Map();
      store.set(driverId, receipts);
    }
    return receipts;
  }

  function snapshot(record) {
    const { _buffer, ...rest } = record;
    return deepFreeze(structuredClone(rest));
  }

  /**
   * Queue a receipt upload for OCR processing.
   * @param {string} driverId
   * @param {object} upload
   * @param {Buffer} [upload.buffer] Raw file bytes.
   * @param {string} [upload.path] Path to the uploaded file.
   * @param {string} [upload.mimeType]
   * @returns {object} The queued, frozen receipt record.
   */
  function queue(driverId, upload = {}) {
    const receipts = requireDriverReceipts(driverId);
    if (upload === null || typeof upload !== 'object') {
      throw new ReceiptError('An upload must be an object', 'RECEIPT_UPLOAD');
    }
    if (!upload.buffer && !upload.path) {
      throw new ReceiptError('An upload must include a buffer or a path', 'RECEIPT_UPLOAD');
    }
    const record = {
      id: generateId(),
      driverId,
      status: 'queued',
      upload: {
        path: upload.path ?? null,
        mimeType: upload.mimeType ?? null,
        hasBuffer: Boolean(upload.buffer),
      },
      _buffer: upload.buffer ?? null,
      queuedAt: now(),
      processedAt: null,
      fields: null,
      rawText: null,
      error: null,
    };
    receipts.set(record.id, record);
    pending.push({ driverId, id: record.id });
    return snapshot(record);
  }

  /**
   * Process one queued receipt: run it through the OCR provider and extract
   * fields. On provider failure the receipt is marked `failed` with the
   * error message rather than throwing, so a queue sweep can continue past it.
   * @returns {Promise<object>} The updated, frozen receipt record.
   */
  async function process(driverId, id) {
    const receipts = store.get(driverId);
    const record = receipts && receipts.get(id);
    if (!record) {
      throw new ReceiptError(`No receipt "${id}" for driver "${driverId}"`, 'RECEIPT_NOT_FOUND');
    }
    if (record.status !== 'queued') {
      throw new ReceiptError(`Receipt "${id}" is not queued (status: ${record.status})`, 'RECEIPT_NOT_QUEUED');
    }
    const idx = pending.findIndex((p) => p.driverId === driverId && p.id === id);
    if (idx !== -1) pending.splice(idx, 1);

    try {
      const result = await ocrProvider.recognize({
        buffer: record._buffer,
        path: record.upload.path,
        mimeType: record.upload.mimeType,
      });
      record.rawText = typeof result.text === 'string' ? result.text : null;
      record.fields = extractFields(result);
      record.status = 'processed';
    } catch (err) {
      record.status = 'failed';
      record.error = err instanceof Error ? err.message : String(err);
    }
    record.processedAt = now();
    return snapshot(record);
  }

  /** Process the oldest queued receipt across all drivers (FIFO), or `null` if the queue is empty. */
  async function processNext() {
    if (pending.length === 0) return null;
    const { driverId, id } = pending[0];
    return process(driverId, id);
  }

  /** Process every currently queued receipt (FIFO), returning their results in order. */
  async function processAll() {
    const results = [];
    while (pending.length > 0) {
      results.push(await processNext());
    }
    return results;
  }

  /** Get one receipt, or `null`. */
  function get(driverId, id) {
    const receipts = store.get(driverId);
    const record = receipts && receipts.get(id);
    return record ? snapshot(record) : null;
  }

  /**
   * List a driver's receipts, oldest first.
   * @param {string} driverId
   * @param {object} [filter]
   * @param {'queued'|'processed'|'failed'} [filter.status]
   */
  function list(driverId, filter = {}) {
    const receipts = store.get(driverId);
    if (!receipts) return [];
    let records = [...receipts.values()].sort((a, b) => a.queuedAt - b.queuedAt);
    if (filter.status !== undefined) {
      records = records.filter((r) => r.status === filter.status);
    }
    return records.map(snapshot);
  }

  return { queue, process, processNext, processAll, get, list, store };
}
