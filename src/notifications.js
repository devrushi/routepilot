// Proactive push notification triggers: a shift that ended with no mileage
// logged, and a purchase with no receipt logged within a reasonable window.
//
// The actual push send is stubbed behind a `{ send(notification) }` provider
// interface (same reasoning as the LLM/embedding tickets) — trigger
// conditions and the sweep/scheduling logic that decides *when* to call it
// are real, reusing shifts.js/receipts.js data directly rather than
// re-deriving mileage/receipt state.

export class NotificationError extends Error {
  constructor(message, code = 'NOTIFICATION_INVALID') {
    super(message);
    this.name = 'NotificationError';
    this.code = code;
  }
}

/** Default window a receipt has to show up after a purchase before it's considered late. */
export const DEFAULT_RECEIPT_WINDOW_MS = 48 * 60 * 60 * 1000;

/**
 * A push provider stand-in: `{ send(notification): Promise<{id, status}> }`.
 * Real push (FCM/APNs/a notification service) plugs in later as a different
 * object satisfying the same interface. This one just records what was sent.
 */
export function createMockPushProvider() {
  const sent = [];
  return {
    async send(notification) {
      const record = { id: `push_${sent.length + 1}`, status: 'sent', notification };
      sent.push(record);
      return record;
    },
    sent,
  };
}

/**
 * True if a shift ended with no mileage recorded at all — no GPS-accumulated
 * distance and no manual odometer reading (see shifts.js `shift.trip`).
 * @param {object} shift A shift record (see `createShiftTracker`).
 */
export function shiftMissingMileage(shift) {
  if (!shift || shift.status !== 'completed') return false;
  const trip = shift.trip ?? {};
  const hasOdometer = Boolean(trip.odometer);
  const hasGpsDistance = typeof trip.gpsDistanceMiles === 'number' && trip.gpsDistanceMiles > 0;
  return !hasOdometer && !hasGpsDistance;
}

/**
 * True if a purchase has no matching receipt logged within `windowMs` after
 * it, and that window has already elapsed as of `now`.
 * @param {number} purchaseAt Purchase timestamp (ms since epoch).
 * @param {object[]} receipts A driver's receipt records (see `createReceiptProcessor`), each with a `queuedAt` timestamp.
 * @param {object} [options]
 * @param {number} [options.windowMs=DEFAULT_RECEIPT_WINDOW_MS]
 * @param {number} [options.now=Date.now()]
 */
export function receiptOverdue(purchaseAt, receipts, options = {}) {
  const { windowMs = DEFAULT_RECEIPT_WINDOW_MS, now = Date.now() } = options;
  if (now - purchaseAt < windowMs) return false; // window hasn't elapsed yet
  const hasTimelyReceipt = Array.isArray(receipts) && receipts.some((r) => {
    const loggedAt = r.queuedAt;
    return typeof loggedAt === 'number' && loggedAt >= purchaseAt && loggedAt <= purchaseAt + windowMs;
  });
  return !hasTimelyReceipt;
}

/**
 * Create the notification trigger scheduler.
 * @param {object} [config]
 * @param {{send:(notification:object)=>Promise<object>}} [config.pushProvider]
 * @param {ReturnType<import('./shifts.js').createShiftTracker>} [config.shiftTracker]
 * @param {ReturnType<import('./receipts.js').createReceiptProcessor>} [config.receiptProcessor]
 * @param {number} [config.receiptWindowMs=DEFAULT_RECEIPT_WINDOW_MS]
 * @param {() => number} [config.now] Clock in ms (injectable for tests).
 */
export function createNotificationScheduler(config = {}) {
  const {
    pushProvider = createMockPushProvider(),
    shiftTracker = null,
    receiptProcessor = null,
    receiptWindowMs = DEFAULT_RECEIPT_WINDOW_MS,
    now = () => Date.now(),
  } = config;

  /** Check one shift; sends (and returns) a notification if mileage is missing, else `null`. */
  async function checkShiftMileage(driverId, shift) {
    if (!shiftMissingMileage(shift)) return null;
    return pushProvider.send({
      type: 'missing_mileage',
      driverId,
      shiftId: shift.id,
      message: `Your shift ending ${new Date(shift.endedAt).toISOString()} has no mileage logged — add one so it isn't missed for taxes.`,
    });
  }

  /** Check one purchase; sends (and returns) a notification if its receipt is overdue, else `null`. */
  async function checkReceiptOverdue(driverId, purchase, receipts) {
    if (!receiptOverdue(purchase.at, receipts, { windowMs: receiptWindowMs, now: now() })) return null;
    return pushProvider.send({
      type: 'late_receipt',
      driverId,
      purchaseId: purchase.id,
      message: `You made a purchase on ${new Date(purchase.at).toISOString()} but haven't logged a receipt for it yet.`,
    });
  }

  /**
   * Sweep a driver's shifts (via `shiftTracker`) and a given list of
   * purchases for missed-trigger notifications, sending any that fire.
   * @param {string} driverId
   * @param {object} [options]
   * @param {object[]} [options.purchases] Purchase events `{ id, at }` to check for overdue receipts.
   * @returns {Promise<object[]>} The notifications that were sent.
   */
  async function sweepDriver(driverId, options = {}) {
    const { purchases = [] } = options;
    const results = [];

    if (shiftTracker) {
      for (const shift of await shiftTracker.list(driverId)) {
        const result = await checkShiftMileage(driverId, shift);
        if (result) results.push(result);
      }
    }

    if (purchases.length > 0) {
      const receipts = receiptProcessor ? await receiptProcessor.list(driverId) : [];
      for (const purchase of purchases) {
        const result = await checkReceiptOverdue(driverId, purchase, receipts);
        if (result) results.push(result);
      }
    }

    return results;
  }

  return { checkShiftMileage, checkReceiptOverdue, sweepDriver, pushProvider };
}
