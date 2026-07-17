import { base32Encode } from '../src/crypto/encoding';
import {
  buildOtpAuthUri,
  generateTotp,
  generateTotpSecret,
  hotp,
  verifyTotp,
} from '../src/auth/totp';

// RFC 4226 test seed "12345678901234567890" expressed as a base32 secret.
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));

describe('hotp (RFC 4226 vectors)', () => {
  // Appendix D truncated values for counters 0..9.
  const EXPECTED = [
    '755224', '287082', '359152', '969429', '338314',
    '254676', '287922', '162583', '399871', '520489',
  ];

  it.each(EXPECTED.map((code, counter) => [counter, code]))(
    'counter %i -> %s',
    (counter, code) => {
      expect(hotp(RFC_SECRET, counter as number)).toBe(code);
    },
  );
});

describe('generateTotp (RFC 6238 vector)', () => {
  it('matches the SHA-1 8-digit vector at T=59s', () => {
    // RFC 6238 Appendix B: time 59s -> 94287082 for the SHA-1 test seed.
    expect(generateTotp(RFC_SECRET, { now: 59_000, digits: 8 })).toBe('94287082');
  });
});

describe('verifyTotp', () => {
  const secret = generateTotpSecret();

  it('accepts a freshly generated code', () => {
    const now = 1_700_000_000_000;
    const code = generateTotp(secret, { now });
    expect(verifyTotp(code, secret, { now })).toBe(true);
  });

  it('accepts a code from the previous step within the window', () => {
    const now = 1_700_000_000_000;
    const previousCode = generateTotp(secret, { now: now - 30_000 });
    expect(verifyTotp(previousCode, secret, { now, window: 1 })).toBe(true);
  });

  it('rejects a code outside the window', () => {
    const now = 1_700_000_000_000;
    const staleCode = generateTotp(secret, { now: now - 5 * 30_000 });
    expect(verifyTotp(staleCode, secret, { now, window: 1 })).toBe(false);
  });

  it('rejects garbage and wrong-length input', () => {
    const now = 1_700_000_000_000;
    expect(verifyTotp('000000', secret, { now })).toBe(false);
    expect(verifyTotp('abcdef', secret, { now })).toBe(false);
    expect(verifyTotp('12345', secret, { now })).toBe(false);
  });

  it('ignores spaces in the submitted code', () => {
    const now = 1_700_000_000_000;
    const code = generateTotp(secret, { now });
    const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
    expect(verifyTotp(spaced, secret, { now })).toBe(true);
  });
});

describe('generateTotpSecret', () => {
  it('produces distinct, decodable base32 secrets', () => {
    const a = generateTotpSecret();
    const b = generateTotpSecret();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Z2-7]+$/);
  });
});

describe('buildOtpAuthUri', () => {
  it('builds a spec-compliant provisioning URI', () => {
    const uri = buildOtpAuthUri({
      secret: 'JBSWY3DPEHPK3PXP',
      accountName: 'driver@example.com',
      issuer: 'RoutePilot',
    });
    expect(uri.startsWith('otpauth://totp/')).toBe(true);
    expect(uri).toContain('secret=JBSWY3DPEHPK3PXP');
    expect(uri).toContain('issuer=RoutePilot');
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
    expect(uri).toContain('RoutePilot%3Adriver%40example.com');
  });
});
