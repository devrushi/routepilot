import { signJwt, TokenError, verifyJwt } from '../src/auth/jwt';

const SECRET = 'test-secret';

describe('signJwt / verifyJwt', () => {
  it('signs and verifies a token, preserving custom claims', () => {
    const token = signJwt(
      { sub: 'user-1', typ: 'access', role: 'driver' },
      { secret: SECRET, issuer: 'routepilot', expiresInSeconds: 60, now: 1000 },
    );

    const claims = verifyJwt(token, { secret: SECRET, issuer: 'routepilot', now: 1000 });
    expect(claims.sub).toBe('user-1');
    expect(claims.typ).toBe('access');
    expect(claims.role).toBe('driver');
    expect(claims.iat).toBe(1000);
    expect(claims.exp).toBe(1060);
    expect(claims.iss).toBe('routepilot');
  });

  it('produces a three-segment compact token', () => {
    const token = signJwt({ sub: 'x' }, { secret: SECRET });
    expect(token.split('.')).toHaveLength(3);
  });

  it('rejects a token signed with a different secret', () => {
    const token = signJwt({ sub: 'x' }, { secret: SECRET, expiresInSeconds: 60 });
    expect(() => verifyJwt(token, { secret: 'other' })).toThrow(TokenError);
    try {
      verifyJwt(token, { secret: 'other' });
    } catch (err) {
      expect((err as TokenError).code).toBe('invalid_signature');
    }
  });

  it('rejects a tampered payload', () => {
    const token = signJwt({ sub: 'x', role: 'driver' }, { secret: SECRET });
    const [h, , s] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ sub: 'x', role: 'admin' }))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(() => verifyJwt(`${h}.${forged}.${s}`, { secret: SECRET })).toThrow(
      /Signature/,
    );
  });

  it('rejects an expired token', () => {
    const token = signJwt({ sub: 'x' }, { secret: SECRET, expiresInSeconds: 60, now: 1000 });
    try {
      verifyJwt(token, { secret: SECRET, now: 2000 });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as TokenError).code).toBe('expired');
    }
  });

  it('honours clock tolerance for expiry', () => {
    const token = signJwt({ sub: 'x' }, { secret: SECRET, expiresInSeconds: 60, now: 1000 });
    expect(
      verifyJwt(token, { secret: SECRET, now: 1065, clockToleranceSeconds: 10 }).sub,
    ).toBe('x');
  });

  it('rejects an unexpected issuer', () => {
    const token = signJwt({ sub: 'x' }, { secret: SECRET, issuer: 'routepilot' });
    try {
      verifyJwt(token, { secret: SECRET, issuer: 'someone-else' });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as TokenError).code).toBe('invalid_issuer');
    }
  });

  it('rejects malformed tokens', () => {
    expect(() => verifyJwt('not-a-token', { secret: SECRET })).toThrow(/three segments/);
  });

  it('rejects a not-yet-active token', () => {
    const token = signJwt({ sub: 'x', nbf: 5000 }, { secret: SECRET });
    try {
      verifyJwt(token, { secret: SECRET, now: 1000 });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as TokenError).code).toBe('not_active');
    }
  });

  it('rejects unsupported algorithms', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' }))
      .toString('base64')
      .replace(/=+$/, '');
    const payload = Buffer.from(JSON.stringify({ sub: 'x' }))
      .toString('base64')
      .replace(/=+$/, '');
    try {
      verifyJwt(`${header}.${payload}.`, { secret: SECRET });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as TokenError).code).toBe('unsupported_alg');
    }
  });
});
