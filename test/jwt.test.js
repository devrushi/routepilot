import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signJwt, verifyJwt, decodeJwt, JwtError } from '../src/jwt.js';
import { base64UrlEncode } from '../src/encoding.js';

const SECRET = 'super-secret-signing-key';

test('sign then verify round-trips claims', () => {
  const token = signJwt({ sub: 'usr_1', role: 'driver' }, SECRET, { now: 1000 });
  const payload = verifyJwt(token, SECRET, { now: 1000 });
  assert.equal(payload.sub, 'usr_1');
  assert.equal(payload.role, 'driver');
  assert.equal(payload.iat, 1000);
});

test('header pins alg to HS256 and typ JWT', () => {
  const token = signJwt({ sub: 'x' }, SECRET, { now: 0 });
  const { header } = decodeJwt(token);
  assert.deepEqual(header, { alg: 'HS256', typ: 'JWT' });
});

test('tampered payload fails signature verification', () => {
  const token = signJwt({ sub: 'usr_1', role: 'driver' }, SECRET, { now: 0 });
  const [h, , s] = token.split('.');
  const forged = base64UrlEncode(JSON.stringify({ sub: 'usr_1', role: 'admin', iat: 0 }));
  const tampered = `${h}.${forged}.${s}`;
  assert.throws(() => verifyJwt(tampered, SECRET, { now: 0 }), (e) => e.code === 'JWT_SIGNATURE');
});

test('wrong secret is rejected', () => {
  const token = signJwt({ sub: 'x' }, SECRET, { now: 0 });
  assert.throws(() => verifyJwt(token, 'other-secret', { now: 0 }), (e) => e.code === 'JWT_SIGNATURE');
});

test('expired token is rejected, tolerance can allow skew', () => {
  const token = signJwt({ sub: 'x' }, SECRET, { now: 1000, expiresInSeconds: 60 });
  assert.throws(() => verifyJwt(token, SECRET, { now: 1061 }), (e) => e.code === 'JWT_EXPIRED');
  // within tolerance
  assert.doesNotThrow(() => verifyJwt(token, SECRET, { now: 1061, clockToleranceSeconds: 5 }));
});

test('nbf in the future is rejected', () => {
  const token = signJwt({ sub: 'x', nbf: 2000 }, SECRET, { now: 1000 });
  assert.throws(() => verifyJwt(token, SECRET, { now: 1500 }), (e) => e.code === 'JWT_NOT_ACTIVE');
  assert.doesNotThrow(() => verifyJwt(token, SECRET, { now: 2000 }));
});

test('issuer and audience are enforced when requested', () => {
  const token = signJwt({ sub: 'x', iss: 'routepilot', aud: ['web', 'mobile'] }, SECRET, { now: 0 });
  assert.doesNotThrow(() => verifyJwt(token, SECRET, { now: 0, issuer: 'routepilot', audience: 'mobile' }));
  assert.throws(() => verifyJwt(token, SECRET, { now: 0, issuer: 'evil' }), (e) => e.code === 'JWT_ISSUER');
  assert.throws(() => verifyJwt(token, SECRET, { now: 0, audience: 'cli' }), (e) => e.code === 'JWT_AUDIENCE');
});

test('the "none" algorithm is rejected', () => {
  const header = base64UrlEncode(JSON.stringify({ alg: 'none', typ: 'JWT' }));
  const payload = base64UrlEncode(JSON.stringify({ sub: 'x' }));
  assert.throws(() => verifyJwt(`${header}.${payload}.`, SECRET, { now: 0 }), (e) => e.code === 'JWT_ALG');
});

test('malformed tokens are rejected', () => {
  assert.throws(() => verifyJwt('not-a-jwt', SECRET), (e) => e.code === 'JWT_MALFORMED');
  assert.throws(() => verifyJwt('a.b', SECRET), (e) => e.code === 'JWT_MALFORMED');
  assert.throws(() => verifyJwt(123, SECRET), JwtError);
});
