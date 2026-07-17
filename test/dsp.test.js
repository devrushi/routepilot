import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDspConnectionManager,
  validateDspLink,
  validatePayoutRate,
  computePayout,
  DSP_PARTNERS,
  PAYOUT_RATE_TYPES,
  LINK_STATUSES,
  DspError,
} from '../src/dsp.js';

// A fixed clock so timestamps are deterministic.
const FIXED_NOW = Date.UTC(2024, 0, 1);
const now = () => FIXED_NOW;

function rateCard(overrides = {}) {
  return {
    currency: 'USD',
    components: [
      { type: 'per_delivery', rate: 3 },
      { type: 'per_mile', rate: 0.5 },
    ],
    ...overrides,
  };
}

function linkInput(overrides = {}) {
  return {
    partner: 'doordash',
    externalAccountId: 'dd-acct-123',
    payoutRate: rateCard(),
    ...overrides,
  };
}

let idCounter = 0;
function manager(config = {}) {
  idCounter = 0;
  return createDspConnectionManager({
    now,
    generateId: () => `dsp_${(idCounter += 1)}`,
    ...config,
  });
}

// --- validatePayoutRate --------------------------------------------------

test('validatePayoutRate normalizes a multi-component card with defaults', () => {
  const rate = validatePayoutRate(rateCard());
  assert.equal(rate.currency, 'USD');
  assert.equal(rate.peakMultiplier, 1);
  assert.equal(rate.minimumPayout, 0);
  assert.equal(rate.components.length, 2);
  assert.deepEqual(rate.components[0], {
    type: 'per_delivery', label: 'Per delivery', basis: 'deliveries', unit: 'delivery', rate: 3,
  });
});

test('validatePayoutRate lower/upper-cases and defaults the currency', () => {
  assert.equal(validatePayoutRate(rateCard({ currency: 'gbp' })).currency, 'GBP');
  assert.equal(validatePayoutRate(rateCard({ currency: undefined })).currency, 'USD');
  assert.throws(() => validatePayoutRate(rateCard({ currency: 'US' })), (e) => e.code === 'DSP_CURRENCY');
  assert.throws(() => validatePayoutRate(rateCard({ currency: 'DOLLAR' })), (e) => e.code === 'DSP_CURRENCY');
});

test('validatePayoutRate accepts a peak multiplier and minimum guarantee', () => {
  const rate = validatePayoutRate(rateCard({ peakMultiplier: 1.5, minimumPayout: 4 }));
  assert.equal(rate.peakMultiplier, 1.5);
  assert.equal(rate.minimumPayout, 4);
});

test('validatePayoutRate coerces numeric strings', () => {
  const rate = validatePayoutRate({
    components: [{ type: 'per_hour', rate: '18.50' }],
    peakMultiplier: '2',
    minimumPayout: '10',
  });
  assert.equal(rate.components[0].rate, 18.5);
  assert.equal(rate.peakMultiplier, 2);
  assert.equal(rate.minimumPayout, 10);
});

test('validatePayoutRate requires at least one component', () => {
  assert.throws(() => validatePayoutRate({ components: [] }), (e) => e.code === 'DSP_RATE');
  assert.throws(() => validatePayoutRate({}), (e) => e.code === 'DSP_RATE');
  assert.throws(() => validatePayoutRate(null), (e) => e.code === 'DSP_RATE');
});

test('validatePayoutRate rejects unknown, duplicate and out-of-range components', () => {
  assert.throws(
    () => validatePayoutRate({ components: [{ type: 'per_light_year', rate: 1 }] }),
    (e) => e.code === 'DSP_RATE_TYPE',
  );
  assert.throws(
    () => validatePayoutRate({ components: [{ type: 'per_mile', rate: 1 }, { type: 'per_mile', rate: 2 }] }),
    (e) => e.code === 'DSP_RATE',
  );
  assert.throws(
    () => validatePayoutRate({ components: [{ type: 'per_delivery', rate: -1 }] }),
    (e) => e.code === 'DSP_RATE',
  );
  assert.throws(
    () => validatePayoutRate({ components: [{ type: 'percentage', rate: 150 }] }),
    (e) => e.code === 'DSP_RATE',
  );
});

test('validatePayoutRate bounds the peak multiplier at >= 1', () => {
  assert.throws(() => validatePayoutRate(rateCard({ peakMultiplier: 0.5 })), (e) => e.code === 'DSP_RATE');
  assert.throws(() => validatePayoutRate(rateCard({ peakMultiplier: 99 })), (e) => e.code === 'DSP_RATE');
});

// --- computePayout -------------------------------------------------------

test('computePayout sums each variable component for a work batch', () => {
  const rate = validatePayoutRate({
    components: [
      { type: 'per_delivery', rate: 3 },
      { type: 'per_mile', rate: 0.5 },
      { type: 'per_hour', rate: 12 },
      { type: 'percentage', rate: 10 },
    ],
  });
  const result = computePayout(rate, { deliveries: 4, miles: 10, hours: 2, orderValue: 100 });
  // 4*3 + 10*0.5 + 2*12 + 10% of 100 = 12 + 5 + 24 + 10 = 51
  assert.equal(result.subtotal, 51);
  assert.equal(result.total, 51);
  assert.equal(result.peak, false);
  assert.equal(result.multiplier, 1);
  assert.equal(result.currency, 'USD');
  assert.equal(result.breakdown.length, 4);
  assert.deepEqual(
    result.breakdown.map((b) => b.amount),
    [12, 5, 24, 10],
  );
});

test('computePayout treats missing work fields as zero', () => {
  const rate = validatePayoutRate(rateCard());
  const result = computePayout(rate, { deliveries: 2 });
  assert.equal(result.total, 6); // 2*3, miles default 0
});

test('computePayout applies the peak multiplier only when requested', () => {
  const rate = validatePayoutRate(rateCard({ peakMultiplier: 1.5 }));
  const off = computePayout(rate, { deliveries: 4 });
  const on = computePayout(rate, { deliveries: 4 }, { peak: true });
  assert.equal(off.total, 12);
  assert.equal(on.total, 18); // 12 * 1.5
  assert.equal(on.multiplier, 1.5);
  assert.equal(on.peak, true);
});

test('computePayout raises a shortfall to the minimum guarantee', () => {
  const rate = validatePayoutRate(rateCard({ minimumPayout: 10 }));
  const low = computePayout(rate, { deliveries: 1 }); // 3 < 10
  assert.equal(low.subtotal, 3);
  assert.equal(low.total, 10);
  assert.equal(low.floorApplied, true);

  const high = computePayout(rate, { deliveries: 5 }); // 15 > 10
  assert.equal(high.total, 15);
  assert.equal(high.floorApplied, false);
});

test('computePayout rounds money to whole cents', () => {
  const rate = validatePayoutRate({ components: [{ type: 'per_mile', rate: 0.575 }] });
  const result = computePayout(rate, { miles: 3 }); // 1.725 -> 1.73
  assert.equal(result.total, 1.73);
});

test('computePayout returns a frozen result and rejects bad work', () => {
  const rate = validatePayoutRate(rateCard());
  const result = computePayout(rate, { deliveries: 1 });
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.breakdown));
  assert.throws(() => computePayout(rate, { deliveries: -1 }), (e) => e.code === 'DSP_WORK');
  assert.throws(() => computePayout(rate, 'nope'), (e) => e.code === 'DSP_WORK');
  assert.throws(() => computePayout(null, {}), (e) => e.code === 'DSP_RATE');
});

// --- validateDspLink -----------------------------------------------------

test('validateDspLink resolves a known partner and derives a display name', () => {
  const core = validateDspLink(linkInput());
  assert.deepEqual(core.partner, { id: 'doordash', label: 'DoorDash', category: 'food' });
  assert.equal(core.externalAccountId, 'dd-acct-123');
  assert.equal(core.label, null);
  assert.equal(core.displayName, 'DoorDash');
  assert.equal(core.payoutRate.components.length, 2);
});

test('validateDspLink resolves a partner by label and prefers a nickname', () => {
  const core = validateDspLink(linkInput({ partner: 'Amazon Flex', label: 'Morning blocks' }));
  assert.equal(core.partner.id, 'amazon_flex');
  assert.equal(core.displayName, 'Morning blocks');
});

test('validateDspLink accepts a custom partner object', () => {
  const core = validateDspLink(linkInput({ partner: { id: 'Local Co', label: 'Local Courier Co' } }));
  assert.deepEqual(core.partner, { id: 'local_co', label: 'Local Courier Co', category: 'other' });
});

test('validateDspLink rejects an unknown partner and a missing account id', () => {
  assert.throws(() => validateDspLink(linkInput({ partner: 'nope' })), (e) => e.code === 'DSP_PARTNER');
  assert.throws(() => validateDspLink(linkInput({ externalAccountId: '' })), (e) => e.code === 'DSP_FIELD');
  assert.throws(() => validateDspLink(linkInput({ payoutRate: undefined })), (e) => e.code === 'DSP_RATE');
});

// --- manager: link -------------------------------------------------------

test('link stores an active link and freezes the record', () => {
  const dsp = manager();
  const record = dsp.link('drv_1', linkInput());
  assert.equal(record.id, 'dsp_1');
  assert.equal(record.driverId, 'drv_1');
  assert.equal(record.partner.id, 'doordash');
  assert.equal(record.status, 'active');
  assert.equal(record.linkedAt, FIXED_NOW);
  assert.equal(record.updatedAt, FIXED_NOW);
  assert.ok(Object.isFrozen(record));
  assert.ok(Object.isFrozen(record.payoutRate));
  assert.throws(() => { record.status = 'x'; }, TypeError);
});

test('link honours an explicit status and id', () => {
  const dsp = manager();
  const record = dsp.link('drv_1', linkInput(), { status: 'pending', id: 'custom_1' });
  assert.equal(record.id, 'custom_1');
  assert.equal(record.status, 'pending');
  assert.throws(() => dsp.link('drv_1', linkInput({ partner: 'uber_eats' }), { status: 'bogus' }), (e) => e.code === 'DSP_STATUS');
});

test('link rejects duplicate partners unless the prior link was unlinked', () => {
  const dsp = manager();
  const first = dsp.link('drv_1', linkInput());
  assert.throws(() => dsp.link('drv_1', linkInput()), (e) => e.code === 'DSP_DUPLICATE');

  dsp.unlink('drv_1', first.id);
  const relinked = dsp.link('drv_1', linkInput());
  assert.equal(relinked.partner.id, 'doordash');
  assert.equal(relinked.status, 'active');
});

test('link requires a driverId', () => {
  const dsp = manager();
  assert.throws(() => dsp.link('', linkInput()), (e) => e.code === 'DSP_DRIVER');
});

// --- manager: get / list -------------------------------------------------

test('list returns links oldest-first and filters by status/category', () => {
  const dsp = manager();
  dsp.link('drv_1', linkInput({ partner: 'doordash' }));            // food
  dsp.link('drv_1', linkInput({ partner: 'instacart' }));           // grocery
  const flex = dsp.link('drv_1', linkInput({ partner: 'amazon_flex' })); // parcel
  dsp.suspend('drv_1', flex.id);

  assert.deepEqual(dsp.list('drv_1').map((l) => l.partner.id), ['doordash', 'instacart', 'amazon_flex']);
  assert.deepEqual(dsp.listActive('drv_1').map((l) => l.partner.id), ['doordash', 'instacart']);
  assert.deepEqual(dsp.list('drv_1', { category: 'grocery' }).map((l) => l.partner.id), ['instacart']);
  assert.deepEqual(dsp.list('drv_1', { status: 'suspended' }).map((l) => l.partner.id), ['amazon_flex']);
  assert.deepEqual(dsp.list('drv_unknown'), []);
  assert.throws(() => dsp.list('drv_1', { status: 'bogus' }), (e) => e.code === 'DSP_STATUS');
});

test('get throws for an unknown link', () => {
  const dsp = manager();
  assert.throws(() => dsp.get('drv_1', 'missing'), (e) => e.code === 'DSP_NOT_FOUND');
});

// --- manager: update / updateRate ---------------------------------------

test('updateRate replaces the variable payout card', () => {
  const dsp = manager();
  const record = dsp.link('drv_1', linkInput());
  const updated = dsp.updateRate('drv_1', record.id, {
    components: [{ type: 'per_hour', rate: 20 }],
    peakMultiplier: 2,
  });
  assert.equal(updated.payoutRate.components[0].type, 'per_hour');
  assert.equal(updated.payoutRate.peakMultiplier, 2);
  assert.throws(() => dsp.updateRate('drv_1', record.id, { components: [] }), (e) => e.code === 'DSP_RATE');
});

test('update changes descriptive fields but not the partner', () => {
  const dsp = manager();
  const record = dsp.link('drv_1', linkInput());
  const updated = dsp.update('drv_1', record.id, { label: 'Evenings', externalAccountId: 'dd-acct-999' });
  assert.equal(updated.label, 'Evenings');
  assert.equal(updated.displayName, 'Evenings');
  assert.equal(updated.externalAccountId, 'dd-acct-999');
  assert.equal(updated.partner.id, 'doordash');
  assert.throws(() => dsp.update('drv_1', record.id, { partner: 'uber_eats' }), (e) => e.code === 'DSP_FIELD');
});

// --- manager: lifecycle --------------------------------------------------

test('activate / suspend / unlink move a link through its lifecycle', () => {
  const dsp = manager();
  const record = dsp.link('drv_1', linkInput(), { status: 'pending' });
  assert.equal(dsp.activate('drv_1', record.id).status, 'active');
  assert.equal(dsp.suspend('drv_1', record.id).status, 'suspended');
  assert.equal(dsp.unlink('drv_1', record.id).status, 'unlinked');
  assert.ok(LINK_STATUSES.includes('active'));
  assert.throws(() => dsp.setStatus('drv_1', record.id, 'bogus'), (e) => e.code === 'DSP_STATUS');
});

// --- manager: estimatePayout / remove -----------------------------------

test('estimatePayout computes from the stored variable rate card', () => {
  const dsp = manager();
  const record = dsp.link('drv_1', linkInput({
    payoutRate: rateCard({
      components: [{ type: 'per_delivery', rate: 4 }, { type: 'per_mile', rate: 0.6 }],
      peakMultiplier: 2,
    }),
  }));
  const normal = dsp.estimatePayout('drv_1', record.id, { deliveries: 5, miles: 20 });
  assert.equal(normal.total, 32); // 5*4 + 20*0.6 = 32
  const peak = dsp.estimatePayout('drv_1', record.id, { deliveries: 5, miles: 20 }, { peak: true });
  assert.equal(peak.total, 64); // 32 * 2
  assert.throws(() => dsp.estimatePayout('drv_1', 'missing', {}), (e) => e.code === 'DSP_NOT_FOUND');
});

test('remove deletes a link and reports whether it existed', () => {
  const dsp = manager();
  const record = dsp.link('drv_1', linkInput());
  assert.equal(dsp.remove('drv_1', record.id), true);
  assert.equal(dsp.remove('drv_1', record.id), false);
  assert.equal(dsp.list('drv_1').length, 0);
});

// --- config --------------------------------------------------------------

test('createDspConnectionManager validates its config', () => {
  assert.throws(() => createDspConnectionManager({ partners: [] }), (e) => e.code === 'DSP_CONFIG');
  assert.throws(() => createDspConnectionManager({ rateTypes: [] }), (e) => e.code === 'DSP_CONFIG');
});

test('catalogues are shaped as expected', () => {
  assert.ok(DSP_PARTNERS.every((p) => p.id && p.label && p.category));
  assert.ok(PAYOUT_RATE_TYPES.every((t) => t.id && t.basis && t.unit));
  assert.ok(DspError.prototype instanceof Error);
});
