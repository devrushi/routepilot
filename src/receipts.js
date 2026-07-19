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
//
// Storage is a `repo` — no separate `pending` FIFO array; "queued" is just a
// status, and `repo.claimNextQueued()` atomically finds-and-flips the oldest
// queued receipt (across all drivers) to `processing` in one step, so two
// concurrent claims can never grab the same receipt. The Postgres repo does
// this with `SELECT ... FOR UPDATE SKIP LOCKED` in a single statement; the
// in-memory repo just mutates synchronously (no concurrency to race against
// in one JS thread). Every other repo method follows the established
// copy-on-read rule (session.js/shifts.js/fuel.js) — `claimNextQueued` is
// the one deliberate exception, since atomically claiming *is* its job.
//
// Uploaded file bytes (`upload.buffer`) are never persisted to Postgres —
// only `path`/`mimeType` are. A real deployment should upload the file to
// blob storage first and queue with that `path`; `buffer` only round-trips
// through the in-memory repo (fine for tests/local dev).

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

/** In-memory receipt repo (default) — nested Map-backed, async interface. */
export function createInMemoryReceiptRepo() {
  const byDriver = new Map(); // driverId -> Map(id -> record)

  function driverReceipts(driverId) {
    let receipts = byDriver.get(driverId);
    if (!receipts) {
      receipts = new Map();
      byDriver.set(driverId, receipts);
    }
    return receipts;
  }

  return {
    async insert(record) {
      driverReceipts(record.driverId).set(record.id, structuredClone(record));
    },
    async findById(driverId, id) {
      const receipts = byDriver.get(driverId);
      const record = receipts && receipts.get(id);
      return record ? structuredClone(record) : null;
    },
    async update(record) {
      driverReceipts(record.driverId).set(record.id, structuredClone(record));
    },
    async listByDriver(driverId, filter = {}) {
      const receipts = byDriver.get(driverId);
      if (!receipts) return [];
      let records = [...receipts.values()].sort((a, b) => a.queuedAt - b.queuedAt);
      if (filter.status !== undefined) {
        records = records.filter((r) => r.status === filter.status);
      }
      return records.map((r) => structuredClone(r));
    },
    // Atomically claims (flips to 'processing') the oldest queued receipt
    // across all drivers. Mutates the canonical stored record directly
    // (single JS thread, no interleaving possible between the find and the
    // flip) then returns a copy — the one method here that isn't a plain
    // read, by design, matching the Postgres repo's claim semantics.
    async claimNextQueued() {
      let oldest = null;
      for (const receipts of byDriver.values()) {
        for (const record of receipts.values()) {
          if (record.status === 'queued' && (!oldest || record.queuedAt < oldest.queuedAt)) {
            oldest = record;
          }
        }
      }
      if (!oldest) return null;
      oldest.status = 'processing';
      return structuredClone(oldest);
    },
  };
}

function parseJsonColumn(value, fallback) {
  if (value === null || value === undefined) return fallback;
  return typeof value === 'string' ? JSON.parse(value) : value;
}

/**
 * Postgres-backed receipt repo. Expects a `receipts` table (see
 * db/migrations). `claimNextQueued` uses `FOR UPDATE SKIP LOCKED` in a
 * single CTE + UPDATE statement so concurrent workers never claim the same
 * row.
 * @param {import('@neondatabase/serverless').NeonQueryFunction<false,false>} sql
 */
export function createPostgresReceiptRepo(sql) {
  function fromRow(row) {
    return {
      id: row.id,
      driverId: row.driver_id,
      status: row.status,
      upload: parseJsonColumn(row.upload, {}),
      _buffer: null, // never persisted — see module header
      queuedAt: Number(row.queued_at),
      processedAt: row.processed_at === null ? null : Number(row.processed_at),
      fields: parseJsonColumn(row.fields, null),
      rawText: row.raw_text,
      error: row.error,
    };
  }

  return {
    async insert(record) {
      await sql`
        INSERT INTO receipts (id, driver_id, status, upload, queued_at, processed_at, fields, raw_text, error)
        VALUES (
          ${record.id}, ${record.driverId}, ${record.status}, ${JSON.stringify(record.upload)}::jsonb,
          ${record.queuedAt}, ${record.processedAt},
          ${record.fields ? JSON.stringify(record.fields) : null}::jsonb, ${record.rawText}, ${record.error}
        )
      `;
    },
    async findById(driverId, id) {
      const rows = await sql`SELECT * FROM receipts WHERE driver_id = ${driverId} AND id = ${id} LIMIT 1`;
      return rows[0] ? fromRow(rows[0]) : null;
    },
    async update(record) {
      await sql`
        UPDATE receipts SET
          status = ${record.status},
          processed_at = ${record.processedAt},
          fields = ${record.fields ? JSON.stringify(record.fields) : null}::jsonb,
          raw_text = ${record.rawText},
          error = ${record.error}
        WHERE id = ${record.id}
      `;
    },
    async listByDriver(driverId, filter = {}) {
      const rows = filter.status !== undefined
        ? await sql`SELECT * FROM receipts WHERE driver_id = ${driverId} AND status = ${filter.status} ORDER BY queued_at ASC`
        : await sql`SELECT * FROM receipts WHERE driver_id = ${driverId} ORDER BY queued_at ASC`;
      return rows.map(fromRow);
    },
    async claimNextQueued() {
      const rows = await sql`
        WITH next_receipt AS (
          SELECT id FROM receipts WHERE status = 'queued' ORDER BY queued_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED
        )
        UPDATE receipts SET status = 'processing'
        WHERE id = (SELECT id FROM next_receipt)
        RETURNING *
      `;
      return rows[0] ? fromRow(rows[0]) : null;
    },
  };
}

/**
 * Create the receipt processing queue.
 * @param {object} [config]
 * @param {{insert:Function, findById:Function, update:Function, listByDriver:Function, claimNextQueued:Function}} [config.repo] Receipt repo (defaults to an in-memory one).
 * @param {{recognize: (input:object) => Promise<{text?:string, fields?:object}>}} [config.ocrProvider]
 * @param {() => number} [config.now] Clock in ms (injectable for tests).
 * @param {() => string} [config.generateId] Receipt id generator.
 */
export function createReceiptProcessor(config = {}) {
  const {
    repo = createInMemoryReceiptRepo(),
    ocrProvider = createMockOcrProvider(),
    now = () => Date.now(),
    generateId = () => `rcpt_${randomUUID()}`,
  } = config;

  function snapshot(record) {
    const { _buffer, ...rest } = record;
    return deepFreeze(structuredClone(rest));
  }

  /**
   * Queue a receipt upload for OCR processing.
   * @param {string} driverId
   * @param {object} upload
   * @param {Buffer} [upload.buffer] Raw file bytes (in-memory repo only — see module header).
   * @param {string} [upload.path] Path to the uploaded file.
   * @param {string} [upload.mimeType]
   * @returns {Promise<object>} The queued, frozen receipt record.
   */
  async function queue(driverId, upload = {}) {
    if (!driverId) {
      throw new ReceiptError('A driverId is required', 'RECEIPT_DRIVER');
    }
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
    await repo.insert(record);
    return snapshot(record);
  }

  // Runs the OCR call for an already-claimed (status: 'processing') record
  // and persists the outcome. Shared by process() and processNext().
  async function finishProcessing(record) {
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
    await repo.update(record);
    return snapshot(record);
  }

  /**
   * Process one queued receipt: run it through the OCR provider and extract
   * fields. On provider failure the receipt is marked `failed` with the
   * error message rather than throwing, so a queue sweep can continue past it.
   * @returns {Promise<object>} The updated, frozen receipt record.
   */
  async function process(driverId, id) {
    const record = await repo.findById(driverId, id);
    if (!record) {
      throw new ReceiptError(`No receipt "${id}" for driver "${driverId}"`, 'RECEIPT_NOT_FOUND');
    }
    if (record.status !== 'queued') {
      throw new ReceiptError(`Receipt "${id}" is not queued (status: ${record.status})`, 'RECEIPT_NOT_QUEUED');
    }
    record.status = 'processing';
    await repo.update(record);
    return finishProcessing(record);
  }

  /** Process the oldest queued receipt across all drivers (FIFO), or `null` if the queue is empty. */
  async function processNext() {
    const claimed = await repo.claimNextQueued();
    if (!claimed) return null;
    return finishProcessing(claimed);
  }

  /** Process every currently queued receipt (FIFO), returning their results in order. */
  async function processAll() {
    const results = [];
    let result = await processNext();
    while (result !== null) {
      results.push(result);
      result = await processNext();
    }
    return results;
  }

  /** Get one receipt, or `null`. */
  async function get(driverId, id) {
    const record = await repo.findById(driverId, id);
    return record ? snapshot(record) : null;
  }

  /**
   * List a driver's receipts, oldest first.
   * @param {string} driverId
   * @param {object} [filter]
   * @param {'queued'|'processing'|'processed'|'failed'} [filter.status]
   */
  async function list(driverId, filter = {}) {
    const records = await repo.listByDriver(driverId, filter);
    return records.map(snapshot);
  }

  return { queue, process, processNext, processAll, get, list, repo };
}
