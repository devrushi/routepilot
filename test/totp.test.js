import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateHOTP,
  generateTOTP,
  verifyTOTP,
  generateSecret,
  keyUri,
} from '../src/totp.js';
import { base32Encode, base32Decode } from '../src/encoding.js';

// RFC 4226 / 6238 reference secret is the ASCII string "12345678901234567890".
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'utf8'));

test('HOTP matches RFC 4226 Appendix D vectors', () => {
  const expected = [
    '755224', '287082', '359152', '969429', '338314',
    '254676', '287922', '162583', '399871', '520489',
  ];
  expected.forEach((code, counter) => {
    assert.equal(generateHOTP(RFC_SECRET, counter), code, `counter ${counter}`);
  });
});

test('TOTP matches RFC 6238 Appendix B SHA1 vectors', () => {
  const vectors = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];
  for (const [seconds, code] of vectors) {
    assert.equal(
      generateTOTP(RFC_SECRET, { now: seconds * 1000, digits: 8 }),
      code,
      `t=${seconds}`,
    );
  }
});

test('verifyTOTP accepts the current code and reports delta 0', () => {
  const now = 1_700_000_000_000;
  const code = generateTOTP(RFC_SECRET, { now });
  assert.deepEqual(verifyTOTP(RFC_SECRET, code, { now }), { valid: true, delta: 0 });
});

test('verifyTOTP tolerates drift within the window', () => {
  const now = 1_700_000_000_000;
  const previous = generateTOTP(RFC_SECRET, { now: now - 30_000 });
  assert.equal(verifyTOTP(RFC_SECRET, previous, { now, window: 1 }).valid, true);
  assert.equal(verifyTOTP(RFC_SECRET, previous, { now, window: 0 }).valid, false);
});

test('verifyTOTP rejects wrong and malformed codes', () => {
  const now = 1_700_000_000_000;
  assert.equal(verifyTOTP(RFC_SECRET, '000000', { now }).valid, false);
  assert.equal(verifyTOTP(RFC_SECRET, 'abcdef', { now }).valid, false);
  assert.equal(verifyTOTP(RFC_SECRET, '', { now }).valid, false);
  assert.equal(verifyTOTP(RFC_SECRET, '12345', { now }).valid, false); // wrong length
});

test('generateSecret produces decodable base32 of expected size', () => {
  const secret = generateSecret();
  assert.match(secret, /^[A-Z2-7]+$/);
  assert.equal(base32Decode(secret).length, 20);
  assert.notEqual(generateSecret(), generateSecret());
});

test('keyUri builds a valid otpauth URI', () => {
  const uri = keyUri({ secret: RFC_SECRET, accountName: 'driver@example.com', issuer: 'RoutePilot' });
  assert.ok(uri.startsWith('otpauth://totp/RoutePilot:driver%40example.com?'));
  const params = new URL(uri).searchParams;
  assert.equal(params.get('secret'), RFC_SECRET);
  assert.equal(params.get('issuer'), 'RoutePilot');
  assert.equal(params.get('algorithm'), 'SHA1');
  assert.equal(params.get('digits'), '6');
  assert.equal(params.get('period'), '30');
});
