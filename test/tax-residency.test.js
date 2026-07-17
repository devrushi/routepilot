import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  declareTaxResidency,
  validateTaxId,
  validateSsn,
  validateItin,
  validateEin,
  validateUtr,
  validateNino,
  computeUtrCheckDigit,
  createTaxResidencyStep,
  TAX_JURISDICTIONS,
  TAX_ID_TYPES,
  TaxResidencyError,
} from '../src/tax-residency.js';

// --- SSN -----------------------------------------------------------------

test('a valid SSN is normalized and formatted', () => {
  const r = validateSsn('123-45-6789');
  assert.equal(r.type, 'ssn');
  assert.equal(r.normalized, '123456789');
  assert.equal(r.formatted, '123-45-6789');
  assert.equal(validateSsn('123456789').normalized, '123456789'); // dashes optional
});

test('SSNs with reserved areas, groups or serials are rejected', () => {
  for (const bad of ['000-12-3456', '666-12-3456', '900-12-3456', '123-00-4567', '123-45-0000']) {
    assert.throws(() => validateSsn(bad), (e) => e instanceof TaxResidencyError && e.code === 'TAX_ID_INVALID', bad);
  }
});

test('malformed SSNs are a format error', () => {
  for (const bad of ['12-345-6789', '1234567', 'abc-de-fghi', '']) {
    assert.throws(() => validateSsn(bad), (e) => e.code === 'TAX_ID_FORMAT', bad);
  }
});

// --- ITIN ----------------------------------------------------------------

test('a valid ITIN begins with 9 and has an issued group', () => {
  const r = validateItin('900-70-1234');
  assert.equal(r.type, 'itin');
  assert.equal(r.normalized, '900701234');
  assert.equal(r.formatted, '900-70-1234');
});

test('ITINs not starting with 9 or with an unissued group are rejected', () => {
  assert.throws(() => validateItin('123-70-1234'), (e) => e.code === 'TAX_ID_INVALID'); // not a 9
  assert.throws(() => validateItin('900-69-1234'), (e) => e.code === 'TAX_ID_INVALID'); // group out of range
  assert.throws(() => validateItin('900-93-1234'), (e) => e.code === 'TAX_ID_INVALID'); // group 93 excluded
});

// --- EIN -----------------------------------------------------------------

test('a valid EIN has an IRS-assigned prefix', () => {
  const r = validateEin('12-3456789');
  assert.equal(r.type, 'ein');
  assert.equal(r.normalized, '123456789');
  assert.equal(r.formatted, '12-3456789');
});

test('EINs with an unassigned prefix are rejected', () => {
  assert.throws(() => validateEin('07-1234567'), (e) => e.code === 'TAX_ID_INVALID');
  assert.throws(() => validateEin('123-45-6789'), (e) => e.code === 'TAX_ID_FORMAT'); // SSN shape
});

// --- UTR -----------------------------------------------------------------

test('the UTR check digit matches the documented modulus-11 algorithm', () => {
  assert.equal(computeUtrCheckDigit('123456789'), 1);
  const r = validateUtr('1123456789');
  assert.equal(r.type, 'utr');
  assert.equal(r.normalized, '1123456789');
  assert.equal(r.formatted, '11234 56789');
});

test('a UTR with a wrong check digit is rejected but a trailing K is tolerated', () => {
  assert.throws(() => validateUtr('2123456789'), (e) => e.code === 'TAX_ID_INVALID');
  assert.equal(validateUtr('1123456789K').normalized, '1123456789');
  assert.throws(() => validateUtr('12345'), (e) => e.code === 'TAX_ID_FORMAT');
});

test('every check digit computed by computeUtrCheckDigit round-trips through validateUtr', () => {
  let checked = 0;
  for (const body of ['000000000', '111111111', '234567890', '987654321', '555000111']) {
    const cd = computeUtrCheckDigit(body);
    if (cd === null) continue;
    assert.equal(validateUtr(`${cd}${body}`).normalized, `${cd}${body}`);
    checked += 1;
  }
  assert.ok(checked > 0);
});

// --- NINO ----------------------------------------------------------------

test('a valid NINO is normalized and spaced-formatted', () => {
  const r = validateNino('ab 12 34 56 c');
  assert.equal(r.type, 'nino');
  assert.equal(r.normalized, 'AB123456C');
  assert.equal(r.formatted, 'AB 12 34 56 C');
});

test('NINOs with disallowed prefixes or suffixes are rejected', () => {
  assert.throws(() => validateNino('DA123456A'), (e) => e.code === 'TAX_ID_INVALID'); // D disallowed first letter
  assert.throws(() => validateNino('GB123456A'), (e) => e.code === 'TAX_ID_INVALID'); // GB disallowed prefix
  assert.throws(() => validateNino('AB123456E'), (e) => e.code === 'TAX_ID_INVALID'); // suffix must be A-D
  assert.throws(() => validateNino('A1234567A'), (e) => e.code === 'TAX_ID_FORMAT');
});

// --- validateTaxId (jurisdiction + auto-detect) --------------------------

test('validateTaxId auto-detects the tax id type within a jurisdiction', () => {
  assert.equal(validateTaxId({ jurisdiction: 'US', taxId: '123-45-6789' }).type, 'ssn');
  assert.equal(validateTaxId({ jurisdiction: 'US', taxId: '900-70-1234' }).type, 'itin');
  assert.equal(validateTaxId({ jurisdiction: 'GB', taxId: 'AB123456C' }).type, 'nino');
  assert.equal(validateTaxId({ jurisdiction: 'GB', taxId: '1123456789' }).type, 'utr');
});

test('validateTaxId accepts UK as an alias for GB and matches jurisdictions case-insensitively', () => {
  assert.equal(validateTaxId({ jurisdiction: 'uk', taxId: 'AB123456C' }).jurisdiction.id, 'GB');
  assert.equal(validateTaxId({ jurisdiction: 'united states', taxId: '123-45-6789' }).jurisdiction.id, 'US');
});

test('validateTaxId honours an explicit type and rejects mismatched types', () => {
  assert.equal(validateTaxId({ jurisdiction: 'US', taxId: '12-3456789', taxIdType: 'ein' }).type, 'ein');
  assert.throws(
    () => validateTaxId({ jurisdiction: 'US', taxId: '123-45-6789', taxIdType: 'utr' }),
    (e) => e.code === 'TAX_ID_TYPE',
  );
});

test('validateTaxId rejects unknown jurisdictions and unrecognisable ids', () => {
  assert.throws(() => validateTaxId({ jurisdiction: 'FR', taxId: '123' }), (e) => e.code === 'TAX_JURISDICTION');
  assert.throws(() => validateTaxId({ jurisdiction: 'US', taxId: 'not-a-tin' }), (e) => e.code === 'TAX_ID_INVALID');
});

// --- declareTaxResidency -------------------------------------------------

test('declareTaxResidency returns a frozen, normalized declaration', () => {
  const decl = declareTaxResidency({ jurisdiction: 'US', taxId: '123-45-6789', confirmed: true });
  assert.deepEqual(decl.jurisdiction, { id: 'US', label: 'United States', country: 'US', authority: 'IRS' });
  assert.equal(decl.taxIdType, 'ssn');
  assert.equal(decl.taxIdLabel, TAX_ID_TYPES.ssn.label);
  assert.equal(decl.taxId, '123456789');
  assert.equal(decl.taxIdFormatted, '123-45-6789');
  assert.equal(decl.confirmed, true);
  assert.ok(Object.isFrozen(decl));
  assert.throws(() => { decl.taxId = 'x'; }, TypeError);
});

test('declareTaxResidency requires an affirmative confirmation', () => {
  assert.throws(
    () => declareTaxResidency({ jurisdiction: 'US', taxId: '123-45-6789' }),
    (e) => e.code === 'TAX_NOT_CONFIRMED',
  );
  assert.throws(
    () => declareTaxResidency({ jurisdiction: 'US', taxId: '123-45-6789', confirmed: 'yes' }),
    (e) => e.code === 'TAX_NOT_CONFIRMED',
  );
});

test('declareTaxResidency reports an unknown jurisdiction before asking to re-confirm', () => {
  assert.throws(
    () => declareTaxResidency({ jurisdiction: 'FR', taxId: '123-45-6789', confirmed: false }),
    (e) => e.code === 'TAX_JURISDICTION',
  );
});

// --- createTaxResidencyStep ----------------------------------------------

test('createTaxResidencyStep produces a declaration step with jurisdiction options', () => {
  const step = createTaxResidencyStep();
  assert.equal(step.id, 'tax_residency');
  assert.equal(step.kind, 'declaration');
  const options = step.options();
  assert.deepEqual(options.map((o) => o.id), TAX_JURISDICTIONS.map((j) => j.id));
  assert.equal(options[0].taxIdTypes[0].id, 'ssn');
  assert.ok(options[0].taxIdTypes[0].example);
});

test('createTaxResidencyStep validate rejects non-object values and honours custom jurisdictions', () => {
  const step = createTaxResidencyStep();
  assert.throws(() => step.validate('US'), (e) => e.code === 'TAX_ID_FORMAT');
  assert.throws(() => step.validate(null), (e) => e.code === 'TAX_ID_FORMAT');

  const gbOnly = createTaxResidencyStep({ jurisdictions: [TAX_JURISDICTIONS[1]] });
  assert.throws(
    () => gbOnly.validate({ jurisdiction: 'US', taxId: '123-45-6789', confirmed: true }),
    (e) => e.code === 'TAX_JURISDICTION',
  );
  assert.equal(
    gbOnly.validate({ jurisdiction: 'GB', taxId: 'AB123456C', confirmed: true }).taxIdType,
    'nino',
  );
});

test('createTaxResidencyStep rejects an empty jurisdiction catalogue', () => {
  assert.throws(() => createTaxResidencyStep({ jurisdictions: [] }), (e) => e.code === 'TAX_CONFIG');
});
