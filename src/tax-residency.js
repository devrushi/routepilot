// HMRC / IRS tax residency declaration for RoutePilot onboarding.
//
// Before a driver's financial profile can be created they must declare where
// they are tax-resident and provide the matching taxpayer identification
// number (TIN). This module is the dependency-free validation core for that
// declaration: it knows the two jurisdictions RoutePilot files with — the US
// (IRS) and the UK (HMRC) — the kinds of TIN each accepts, and how to validate
// and normalize each one *immediately*, so a driver gets specific feedback the
// moment they submit rather than after a downstream tax filing bounces.
//
//   IRS  — SSN (individuals), ITIN (individuals without an SSN), EIN (businesses)
//   HMRC — UTR (Self Assessment, with a modulus-11 check digit), NINO (individuals)
//
// The orchestration (collecting the declaration as an ordered onboarding step,
// storing it on the driver profile) lives in onboarding.js, which wires the
// step produced by `createTaxResidencyStep` into the profile wizard.

export class TaxResidencyError extends Error {
  constructor(message, code = 'TAX_INVALID') {
    super(message);
    this.name = 'TaxResidencyError';
    this.code = code;
  }
}

// Metadata for every TIN type we validate, keyed by its canonical id. `holder`
// records who the number identifies (an individual vs a business), used to
// explain choices in the UI; `example` is a well-formed sample for placeholders.
export const TAX_ID_TYPES = {
  ssn: {
    id: 'ssn',
    label: 'Social Security Number (SSN)',
    jurisdiction: 'US',
    holder: 'individual',
    example: '123-45-6789',
  },
  itin: {
    id: 'itin',
    label: 'Individual Taxpayer Identification Number (ITIN)',
    jurisdiction: 'US',
    holder: 'individual',
    example: '900-70-1234',
  },
  ein: {
    id: 'ein',
    label: 'Employer Identification Number (EIN)',
    jurisdiction: 'US',
    holder: 'business',
    example: '12-3456789',
  },
  utr: {
    id: 'utr',
    label: 'Unique Taxpayer Reference (UTR)',
    jurisdiction: 'GB',
    holder: 'any',
    example: '1123456789',
  },
  nino: {
    id: 'nino',
    label: 'National Insurance Number (NINO)',
    jurisdiction: 'GB',
    holder: 'individual',
    example: 'AB123456C',
  },
};

/**
 * Tax jurisdictions RoutePilot can file for. `authority` is the collecting body
 * (IRS / HMRC) and `taxIdTypes` lists the accepted TIN ids in the order they are
 * tried during type auto-detection (see {@link validateTaxId}).
 */
export const TAX_JURISDICTIONS = [
  { id: 'US', label: 'United States', country: 'US', authority: 'IRS', taxIdTypes: ['ssn', 'itin', 'ein'] },
  { id: 'GB', label: 'United Kingdom', country: 'GB', authority: 'HMRC', taxIdTypes: ['utr', 'nino'] },
];

// Valid IRS EIN campus prefixes (the first two digits of an EIN). Anything
// outside this set was never assigned by the IRS.
const VALID_EIN_PREFIXES = new Set([
  '01', '02', '03', '04', '05', '06', '10', '11', '12', '13', '14', '15', '16',
  '20', '21', '22', '23', '24', '25', '26', '27', '30', '31', '32', '33', '34',
  '35', '36', '37', '38', '39', '40', '41', '42', '43', '44', '45', '46', '47',
  '48', '50', '51', '52', '53', '54', '55', '56', '57', '58', '59', '60', '61',
  '62', '63', '64', '65', '66', '67', '68', '71', '72', '73', '74', '75', '76',
  '77', '80', '81', '82', '83', '84', '85', '86', '87', '88', '90', '91', '92',
  '93', '94', '95', '98', '99',
]);

const ok = (normalized, formatted) => ({ ok: true, normalized, formatted });
const fail = (code, message) => ({ ok: false, code, message });

// --- Per-TIN validators --------------------------------------------------
//
// Each `check*` returns a result object ({ ok, normalized, formatted } on
// success, { ok:false, code, message } on failure) so they compose during
// auto-detection without throwing. The exported `validate*` wrappers throw a
// TaxResidencyError instead, for callers that want the specific reason.

// IRS SSN: nine digits AAA-GG-SSSS. The area cannot be 000, 666 or 900-999
// (900+ is reserved for ITINs), the group cannot be 00, the serial cannot be 0000.
function checkSsn(raw) {
  if (typeof raw !== 'string') return fail('TAX_ID_FORMAT', 'SSN must be a string');
  const trimmed = raw.trim();
  if (!/^\d{3}[-\s]?\d{2}[-\s]?\d{4}$/.test(trimmed)) {
    return fail('TAX_ID_FORMAT', 'SSN must be nine digits in the form AAA-GG-SSSS');
  }
  const digits = trimmed.replace(/[-\s]/g, '');
  const area = digits.slice(0, 3);
  const group = digits.slice(3, 5);
  const serial = digits.slice(5);
  if (area === '000' || area === '666' || Number(area) >= 900) {
    return fail('TAX_ID_INVALID', `SSN area number "${area}" is not an issued range`);
  }
  if (group === '00') return fail('TAX_ID_INVALID', 'SSN group number cannot be 00');
  if (serial === '0000') return fail('TAX_ID_INVALID', 'SSN serial number cannot be 0000');
  return ok(digits, `${area}-${group}-${serial}`);
}

// IRS ITIN: nine digits beginning with 9, with the group digits in one of the
// ranges the IRS actually issues, and a non-zero serial.
function checkItin(raw) {
  if (typeof raw !== 'string') return fail('TAX_ID_FORMAT', 'ITIN must be a string');
  const trimmed = raw.trim();
  if (!/^\d{3}[-\s]?\d{2}[-\s]?\d{4}$/.test(trimmed)) {
    return fail('TAX_ID_FORMAT', 'ITIN must be nine digits in the form 9XX-GG-SSSS');
  }
  const digits = trimmed.replace(/[-\s]/g, '');
  if (digits[0] !== '9') return fail('TAX_ID_INVALID', 'ITIN must begin with a 9');
  const group = Number(digits.slice(3, 5));
  const inRange =
    (group >= 50 && group <= 65) ||
    (group >= 70 && group <= 88) ||
    (group >= 90 && group <= 92) ||
    (group >= 94 && group <= 99);
  if (!inRange) {
    return fail('TAX_ID_INVALID', `ITIN group "${digits.slice(3, 5)}" is outside the ranges the IRS issues`);
  }
  if (digits.slice(5) === '0000') return fail('TAX_ID_INVALID', 'ITIN serial number cannot be 0000');
  return ok(digits, `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`);
}

// IRS EIN: nine digits NN-NNNNNNN whose prefix is a valid IRS campus prefix.
function checkEin(raw) {
  if (typeof raw !== 'string') return fail('TAX_ID_FORMAT', 'EIN must be a string');
  const trimmed = raw.trim();
  if (!/^\d{2}-?\d{7}$/.test(trimmed)) {
    return fail('TAX_ID_FORMAT', 'EIN must be nine digits in the form NN-NNNNNNN');
  }
  const digits = trimmed.replace(/-/g, '');
  const prefix = digits.slice(0, 2);
  if (!VALID_EIN_PREFIXES.has(prefix)) {
    return fail('TAX_ID_INVALID', `EIN prefix "${prefix}" is not an IRS-assigned campus prefix`);
  }
  return ok(digits, `${prefix}-${digits.slice(2)}`);
}

/**
 * Compute the HMRC UTR check digit for the nine trailing digits (positions
 * 2-10) using the standard modulus-11 weighting. Returns the check digit
 * (0-9), or `null` when those nine digits can form no valid UTR (a remainder
 * of 1 leaves an out-of-range check digit).
 * @param {string} nine Nine trailing digits.
 * @returns {number|null}
 */
export function computeUtrCheckDigit(nine) {
  const digits = String(nine).replace(/\s/g, '');
  if (!/^\d{9}$/.test(digits)) {
    throw new TaxResidencyError('A UTR body must be nine digits', 'TAX_ID_FORMAT');
  }
  const weights = [6, 7, 8, 9, 10, 5, 4, 3, 2];
  let sum = 0;
  for (let i = 0; i < 9; i += 1) sum += weights[i] * Number(digits[i]);
  const cd = 11 - (sum % 11);
  if (cd === 11) return 0; // sum divisible by 11
  if (cd === 10) return null; // no single-digit check digit exists
  return cd;
}

// HMRC UTR: ten digits whose leading digit is the modulus-11 check digit of the
// other nine. An optional trailing "K" (used when quoting a UTR as a payment
// reference) is tolerated.
function checkUtr(raw) {
  if (typeof raw !== 'string') return fail('TAX_ID_FORMAT', 'UTR must be a string');
  let s = raw.trim().toUpperCase().replace(/\s/g, '');
  if (s.endsWith('K')) s = s.slice(0, -1);
  if (!/^\d{10}$/.test(s)) return fail('TAX_ID_FORMAT', 'UTR must be ten digits');
  const expected = computeUtrCheckDigit(s.slice(1));
  if (expected === null || expected !== Number(s[0])) {
    return fail('TAX_ID_INVALID', 'UTR check digit does not match the rest of the reference');
  }
  return ok(s, `${s.slice(0, 5)} ${s.slice(5)}`);
}

// HMRC NINO: two prefix letters, six digits, a suffix letter A-D. Several prefix
// letters and whole prefixes are never allocated.
function checkNino(raw) {
  if (typeof raw !== 'string') return fail('TAX_ID_FORMAT', 'NINO must be a string');
  const s = raw.trim().toUpperCase().replace(/\s/g, '');
  if (!/^[A-Z]{2}\d{6}[A-Z]$/.test(s)) {
    return fail('TAX_ID_FORMAT', 'NINO must be two letters, six digits and a final letter');
  }
  const prefix = s.slice(0, 2);
  if ('DFIQUV'.includes(prefix[0]) || 'DFIOQUV'.includes(prefix[1])) {
    return fail('TAX_ID_INVALID', `NINO prefix "${prefix}" uses a disallowed letter`);
  }
  if (new Set(['BG', 'GB', 'KN', 'NK', 'NT', 'TN', 'ZZ']).has(prefix)) {
    return fail('TAX_ID_INVALID', `NINO prefix "${prefix}" is not an allocated prefix`);
  }
  const suffix = s[8];
  if (!'ABCD'.includes(suffix)) {
    return fail('TAX_ID_INVALID', `NINO suffix "${suffix}" must be A, B, C or D`);
  }
  return ok(s, `${prefix} ${s.slice(2, 4)} ${s.slice(4, 6)} ${s.slice(6, 8)} ${suffix}`);
}

const CHECKERS = {
  ssn: checkSsn,
  itin: checkItin,
  ein: checkEin,
  utr: checkUtr,
  nino: checkNino,
};

function makeValidator(type) {
  return (raw) => {
    const result = CHECKERS[type](raw);
    if (!result.ok) throw new TaxResidencyError(result.message, result.code);
    return { type, normalized: result.normalized, formatted: result.formatted };
  };
}

/** Validate a US SSN, returning `{ type, normalized, formatted }` or throwing. */
export const validateSsn = makeValidator('ssn');
/** Validate a US ITIN, returning `{ type, normalized, formatted }` or throwing. */
export const validateItin = makeValidator('itin');
/** Validate a US EIN, returning `{ type, normalized, formatted }` or throwing. */
export const validateEin = makeValidator('ein');
/** Validate a UK UTR, returning `{ type, normalized, formatted }` or throwing. */
export const validateUtr = makeValidator('utr');
/** Validate a UK NINO, returning `{ type, normalized, formatted }` or throwing. */
export const validateNino = makeValidator('nino');

// Match a jurisdiction value case-insensitively by id, ISO country code or
// label. "UK" is accepted as a friendly alias for the ISO code "GB".
function resolveJurisdiction(jurisdictions, value) {
  if (typeof value !== 'string') return null;
  const needle = value.trim().toUpperCase();
  if (!needle) return null;
  const alias = needle === 'UK' ? 'GB' : needle;
  return (
    jurisdictions.find(
      (j) =>
        j.id.toUpperCase() === alias ||
        (j.country && j.country.toUpperCase() === alias) ||
        j.label.toUpperCase() === needle,
    ) ?? null
  );
}

/**
 * Validate a taxpayer identification number for a jurisdiction. When `taxIdType`
 * is given the number is validated strictly against that type; otherwise the
 * jurisdiction's accepted types are tried in order and the first match wins
 * (pass an explicit type to disambiguate, e.g. an SSN-shaped EIN).
 *
 * @param {object} input
 * @param {string} input.jurisdiction Jurisdiction id / country code / label.
 * @param {string} input.taxId The number as entered.
 * @param {string} [input.taxIdType] Force a specific TIN type.
 * @param {object} [opts]
 * @param {Array} [opts.jurisdictions] Jurisdiction catalogue (defaults to {@link TAX_JURISDICTIONS}).
 * @returns {{ jurisdiction: object, type: string, normalized: string, formatted: string }}
 */
export function validateTaxId(input = {}, opts = {}) {
  const { jurisdictions = TAX_JURISDICTIONS } = opts;
  const { jurisdiction: jurisdictionValue, taxId, taxIdType } = input;

  const jurisdiction = resolveJurisdiction(jurisdictions, jurisdictionValue);
  if (!jurisdiction) {
    throw new TaxResidencyError(
      `Unknown tax jurisdiction: ${jurisdictionValue}`,
      'TAX_JURISDICTION',
    );
  }

  if (taxIdType !== undefined && taxIdType !== null && taxIdType !== '') {
    const type = String(taxIdType).trim().toLowerCase();
    if (!jurisdiction.taxIdTypes.includes(type)) {
      throw new TaxResidencyError(
        `${jurisdiction.authority} does not accept a "${taxIdType}" — expected one of: ${jurisdiction.taxIdTypes.join(', ')}`,
        'TAX_ID_TYPE',
      );
    }
    const result = CHECKERS[type](taxId);
    if (!result.ok) throw new TaxResidencyError(result.message, result.code);
    return { jurisdiction, type, normalized: result.normalized, formatted: result.formatted };
  }

  for (const type of jurisdiction.taxIdTypes) {
    const result = CHECKERS[type](taxId);
    if (result.ok) {
      return { jurisdiction, type, normalized: result.normalized, formatted: result.formatted };
    }
  }
  const accepted = jurisdiction.taxIdTypes
    .map((t) => `${TAX_ID_TYPES[t].label} (e.g. ${TAX_ID_TYPES[t].example})`)
    .join(', ');
  throw new TaxResidencyError(
    `"${taxId}" is not a valid ${jurisdiction.authority} tax ID. Accepted: ${accepted}`,
    'TAX_ID_INVALID',
  );
}

/**
 * Validate a full tax residency declaration and return the normalized record to
 * store on the driver profile. The driver must affirm the declaration
 * (`confirmed === true`) and supply a TIN valid for the declared jurisdiction.
 *
 * @param {object} input
 * @param {string} input.jurisdiction Jurisdiction id / country code / label.
 * @param {string} input.taxId Taxpayer identification number as entered.
 * @param {string} [input.taxIdType] Force a specific TIN type.
 * @param {boolean} input.confirmed The driver's affirmation of the declaration.
 * @param {object} [opts]
 * @param {Array} [opts.jurisdictions] Jurisdiction catalogue.
 * @returns {object} Normalized, immutable declaration.
 */
export function declareTaxResidency(input = {}, opts = {}) {
  const { jurisdictions = TAX_JURISDICTIONS } = opts;
  const { jurisdiction: jurisdictionValue, taxId, taxIdType, confirmed } = input;

  // Resolve the jurisdiction first so an unknown one is reported before we ask
  // the driver to re-affirm a declaration they can't yet make.
  const jurisdiction = resolveJurisdiction(jurisdictions, jurisdictionValue);
  if (!jurisdiction) {
    throw new TaxResidencyError(
      `Unknown tax jurisdiction: ${jurisdictionValue}`,
      'TAX_JURISDICTION',
    );
  }
  if (confirmed !== true) {
    throw new TaxResidencyError(
      `You must confirm you are a tax resident of ${jurisdiction.label}`,
      'TAX_NOT_CONFIRMED',
    );
  }

  const { type, normalized, formatted } = validateTaxId(
    { jurisdiction: jurisdiction.id, taxId, taxIdType },
    { jurisdictions },
  );

  return Object.freeze({
    jurisdiction: Object.freeze({
      id: jurisdiction.id,
      label: jurisdiction.label,
      country: jurisdiction.country,
      authority: jurisdiction.authority,
    }),
    taxIdType: type,
    taxIdLabel: TAX_ID_TYPES[type].label,
    taxId: normalized,
    taxIdFormatted: formatted,
    confirmed: true,
  });
}

/**
 * Build the tax residency declaration step for the onboarding wizard. The step
 * exposes the jurisdictions (and the TIN types each accepts) for rendering, and
 * validates a submitted `{ jurisdiction, taxId, taxIdType?, confirmed }` value
 * immediately, throwing a {@link TaxResidencyError} on any problem.
 *
 * @param {object} [config]
 * @param {Array} [config.jurisdictions] Jurisdiction catalogue.
 * @returns {object} A wizard-compatible step definition.
 */
export function createTaxResidencyStep(config = {}) {
  const { jurisdictions = TAX_JURISDICTIONS } = config;
  if (!Array.isArray(jurisdictions) || jurisdictions.length === 0) {
    throw new TaxResidencyError('At least one tax jurisdiction is required', 'TAX_CONFIG');
  }
  return {
    id: 'tax_residency',
    title: 'Tax residency declaration',
    prompt: 'Declare your country of tax residency and enter the matching tax identification number.',
    kind: 'declaration',
    options: () =>
      jurisdictions.map((j) => ({
        id: j.id,
        label: j.label,
        authority: j.authority,
        taxIdTypes: j.taxIdTypes.map((t) => ({
          id: t,
          label: TAX_ID_TYPES[t] ? TAX_ID_TYPES[t].label : t,
          example: TAX_ID_TYPES[t] ? TAX_ID_TYPES[t].example : undefined,
        })),
      })),
    validate(value) {
      if (value === null || typeof value !== 'object') {
        throw new TaxResidencyError(
          'A tax residency declaration must be an object with { jurisdiction, taxId, confirmed }',
          'TAX_ID_FORMAT',
        );
      }
      return declareTaxResidency(value, { jurisdictions });
    },
  };
}
