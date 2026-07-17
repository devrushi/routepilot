import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as cryptoSign, randomUUID } from 'node:crypto';
import { createSessionManager } from '../src/session.js';
import { createAuthService } from '../src/auth.js';
import { generateTOTP } from '../src/totp.js';
import {
  verifyBiometricSignature,
  importPublicKey,
  isSupportedBiometricAlgorithm,
  SUPPORTED_BIOMETRIC_ALGORITHMS,
  BiometricError,
} from '../src/biometrics.js';
import { base64UrlEncode } from '../src/encoding.js';

// Simulate a mobile device's hardware-backed key pair: only the public key
// leaves the "device"; signing happens with the private key held here.
function makeDevice(algorithm = 'ES256', { format = 'pem' } = {}) {
  const keyPair =
    algorithm === 'Ed25519'
      ? generateKeyPairSync('ed25519')
      : generateKeyPairSync('ec', {
          namedCurve: algorithm === 'ES384' ? 'secp384r1' : 'prime256v1',
        });
  const digest = algorithm === 'Ed25519' ? null : algorithm === 'ES384' ? 'sha384' : 'sha256';
  const publicKey =
    format === 'der'
      ? base64UrlEncode(keyPair.publicKey.export({ type: 'spki', format: 'der' }))
      : keyPair.publicKey.export({ type: 'spki', format: 'pem' });
  return {
    credentialId: `cred_${randomUUID()}`,
    algorithm,
    publicKey,
    sign: (challenge) =>
      base64UrlEncode(cryptoSign(digest, Buffer.from(challenge, 'utf8'), keyPair.privateKey)),
  };
}

function makeService(nowRef) {
  const sessionManager = createSessionManager({
    accessSecret: 'access-secret',
    refreshSecret: 'refresh-secret',
    now: () => nowRef.value,
  });
  const auth = createAuthService({
    sessionManager,
    challengeSecret: 'challenge-secret',
    now: () => nowRef.value,
  });
  return { auth, sessionManager };
}

async function enroll(auth, userId, device) {
  const { challenge } = await auth.beginBiometricEnrollment(userId);
  return auth.confirmBiometricEnrollment(userId, {
    challenge,
    credentialId: device.credentialId,
    publicKey: device.publicKey,
    algorithm: device.algorithm,
    signature: device.sign(challenge),
    label: 'iPhone 15',
  });
}

// ---------------------------------------------------------------------------
// Crypto core
// ---------------------------------------------------------------------------

test('verifyBiometricSignature accepts a valid signature and rejects tampering', () => {
  for (const algorithm of SUPPORTED_BIOMETRIC_ALGORITHMS) {
    const device = makeDevice(algorithm);
    const data = 'challenge-payload';
    const signature = device.sign(data);
    assert.equal(
      verifyBiometricSignature({ publicKey: device.publicKey, algorithm, data, signature }),
      true,
      `${algorithm} valid signature`,
    );
    assert.equal(
      verifyBiometricSignature({ publicKey: device.publicKey, algorithm, data: 'other', signature }),
      false,
      `${algorithm} tampered data`,
    );
  }
});

test('verifyBiometricSignature accepts a base64url-DER public key', () => {
  const device = makeDevice('ES256', { format: 'der' });
  const data = 'from-a-keystore-export';
  assert.equal(
    verifyBiometricSignature({
      publicKey: device.publicKey,
      algorithm: 'ES256',
      data,
      signature: device.sign(data),
    }),
    true,
  );
});

test('verifyBiometricSignature returns false (not throws) on a malformed signature', () => {
  const device = makeDevice('ES256');
  assert.equal(
    verifyBiometricSignature({
      publicKey: device.publicKey,
      algorithm: 'ES256',
      data: 'x',
      signature: '',
    }),
    false,
  );
  assert.equal(
    verifyBiometricSignature({
      publicKey: device.publicKey,
      algorithm: 'ES256',
      data: 'x',
      signature: 'not-a-real-signature',
    }),
    false,
  );
});

test('verifyBiometricSignature rejects an unsupported algorithm', () => {
  const device = makeDevice('ES256');
  assert.throws(
    () =>
      verifyBiometricSignature({
        publicKey: device.publicKey,
        algorithm: 'RS256',
        data: 'x',
        signature: device.sign('x'),
      }),
    (e) => e instanceof BiometricError && e.code === 'BIOMETRIC_ALG',
  );
});

test('importPublicKey rejects a key that does not match the algorithm', () => {
  const ed = makeDevice('Ed25519');
  assert.throws(
    () => importPublicKey(ed.publicKey, 'ES256'),
    (e) => e instanceof BiometricError && e.code === 'BIOMETRIC_KEY',
  );
  assert.equal(isSupportedBiometricAlgorithm('ES256'), true);
  assert.equal(isSupportedBiometricAlgorithm('nope'), false);
});

// ---------------------------------------------------------------------------
// Enrollment
// ---------------------------------------------------------------------------

test('biometric enrollment registers a credential after proof of possession', async () => {
  const nowRef = { value: 1_700_000_000_000 };
  const { auth } = makeService(nowRef);
  const user = await auth.register('driver.jane', 'hunter2hunter2');
  assert.equal(user.biometricEnrolled, false);

  const device = makeDevice('ES256');
  const credential = await enroll(auth, user.id, device);
  assert.equal(credential.credentialId, device.credentialId);
  assert.equal(credential.algorithm, 'ES256');
  assert.equal(credential.label, 'iPhone 15');
  assert.equal(credential.signCount, 0);

  const list = await auth.listBiometricCredentials(user.id);
  assert.equal(list.length, 1);
  const stored = await auth.userStore.findById(user.id);
  assert.equal(stored.biometrics.credentials[0].publicKey.includes('BEGIN PUBLIC KEY'), true);
});

test('enrollment fails when the challenge signature is not from the enrolled key', async () => {
  const nowRef = { value: 1_700_000_000_000 };
  const { auth } = makeService(nowRef);
  const user = await auth.register('driver.jane', 'hunter2hunter2');

  const device = makeDevice('ES256');
  const attacker = makeDevice('ES256');
  const { challenge } = await auth.beginBiometricEnrollment(user.id);
  await assert.rejects(
    () =>
      auth.confirmBiometricEnrollment(user.id, {
        challenge,
        credentialId: device.credentialId,
        publicKey: device.publicKey,
        algorithm: 'ES256',
        signature: attacker.sign(challenge), // wrong private key
      }),
    (e) => e.code === 'AUTH_BIOMETRIC_SIGNATURE',
  );
});

test('enrollment rejects an unsupported algorithm and a duplicate credential', async () => {
  const nowRef = { value: 1_700_000_000_000 };
  const { auth } = makeService(nowRef);
  const user = await auth.register('driver.jane', 'hunter2hunter2');
  const device = makeDevice('ES256');

  const { challenge } = await auth.beginBiometricEnrollment(user.id);
  await assert.rejects(
    () =>
      auth.confirmBiometricEnrollment(user.id, {
        challenge,
        credentialId: device.credentialId,
        publicKey: device.publicKey,
        algorithm: 'RS256',
        signature: device.sign(challenge),
      }),
    (e) => e.code === 'AUTH_BIOMETRIC_ALG',
  );

  await enroll(auth, user.id, device);
  await assert.rejects(() => enroll(auth, user.id, device), (e) => e.code === 'AUTH_BIOMETRIC_EXISTS');
});

test('an expired enrollment challenge is rejected', async () => {
  const nowRef = { value: 1_700_000_000_000 };
  const { auth } = makeService(nowRef);
  const user = await auth.register('driver.jane', 'hunter2hunter2');
  const device = makeDevice('ES256');
  const { challenge } = await auth.beginBiometricEnrollment(user.id);
  nowRef.value += 6 * 60 * 1000; // past the 5-minute challenge TTL
  await assert.rejects(
    () =>
      auth.confirmBiometricEnrollment(user.id, {
        challenge,
        credentialId: device.credentialId,
        publicKey: device.publicKey,
        algorithm: 'ES256',
        signature: device.sign(challenge),
      }),
    (e) => e.code === 'AUTH_CHALLENGE_INVALID',
  );
});

// ---------------------------------------------------------------------------
// Passwordless biometric login
// ---------------------------------------------------------------------------

test('passwordless biometric login yields a session', async () => {
  const nowRef = { value: 1_700_000_000_000 };
  const { auth, sessionManager } = makeService(nowRef);
  const user = await auth.register('driver.jane', 'hunter2hunter2');
  const device = makeDevice('Ed25519');
  await enroll(auth, user.id, device);

  const { challenge, credentialIds } = await auth.beginBiometricAuth('driver.jane');
  assert.deepEqual(credentialIds, [device.credentialId]);

  const result = await auth.verifyBiometricAssertion({
    challenge,
    credentialId: device.credentialId,
    signature: device.sign(challenge),
  });
  assert.equal(result.status, 'authenticated');
  assert.equal(result.usedBiometric, true);
  assert.equal(sessionManager.verifyAccess(result.tokens.accessToken).sub, user.id);

  const stored = await auth.userStore.findById(user.id);
  assert.equal(stored.biometrics.credentials[0].signCount, 1);
  assert.equal(stored.biometrics.credentials[0].lastUsedAt, nowRef.value);
});

test('beginBiometricAuth is unavailable without an enrolled credential', async () => {
  const nowRef = { value: 1_700_000_000_000 };
  const { auth } = makeService(nowRef);
  await auth.register('driver.jane', 'hunter2hunter2');
  await assert.rejects(
    () => auth.beginBiometricAuth('driver.jane'),
    (e) => e.code === 'AUTH_BIOMETRIC_UNAVAILABLE',
  );
  await assert.rejects(
    () => auth.beginBiometricAuth('ghost'),
    (e) => e.code === 'AUTH_BIOMETRIC_UNAVAILABLE',
  );
});

test('a signed challenge cannot be replayed', async () => {
  const nowRef = { value: 1_700_000_000_000 };
  const { auth } = makeService(nowRef);
  const user = await auth.register('driver.jane', 'hunter2hunter2');
  const device = makeDevice('ES256');
  await enroll(auth, user.id, device);

  const { challenge } = await auth.beginBiometricAuth('driver.jane');
  const signature = device.sign(challenge);
  const first = await auth.verifyBiometricAssertion({ challenge, credentialId: device.credentialId, signature });
  assert.equal(first.status, 'authenticated');
  await assert.rejects(
    () => auth.verifyBiometricAssertion({ challenge, credentialId: device.credentialId, signature }),
    (e) => e.code === 'AUTH_CHALLENGE_REPLAY',
  );
});

test('a bad signature and an unknown credential are rejected', async () => {
  const nowRef = { value: 1_700_000_000_000 };
  const { auth } = makeService(nowRef);
  const user = await auth.register('driver.jane', 'hunter2hunter2');
  const device = makeDevice('ES256');
  await enroll(auth, user.id, device);

  const attacker = makeDevice('ES256');
  const { challenge } = await auth.beginBiometricAuth('driver.jane');
  await assert.rejects(
    () =>
      auth.verifyBiometricAssertion({
        challenge,
        credentialId: device.credentialId,
        signature: attacker.sign(challenge),
      }),
    (e) => e.code === 'AUTH_BIOMETRIC_SIGNATURE',
  );

  const { challenge: challenge2 } = await auth.beginBiometricAuth('driver.jane');
  await assert.rejects(
    () =>
      auth.verifyBiometricAssertion({
        challenge: challenge2,
        credentialId: 'cred_unknown',
        signature: device.sign(challenge2),
      }),
    (e) => e.code === 'AUTH_BIOMETRIC_CREDENTIAL',
  );
});

// ---------------------------------------------------------------------------
// Biometrics as the MFA second factor
// ---------------------------------------------------------------------------

test('biometrics can satisfy the MFA challenge in place of TOTP', async () => {
  const nowRef = { value: 1_700_000_000_000 };
  const { auth, sessionManager } = makeService(nowRef);
  const user = await auth.register('driver.jane', 'hunter2hunter2');

  // Enroll TOTP MFA...
  const { secret } = await auth.beginMfaEnrollment(user.id);
  await auth.confirmMfaEnrollment(user.id, generateTOTP(secret, { now: nowRef.value }));
  // ...and a biometric credential.
  const device = makeDevice('ES256');
  await enroll(auth, user.id, device);

  const step1 = await auth.login('driver.jane', 'hunter2hunter2');
  assert.equal(step1.status, 'mfa_required');

  // Complete the MFA challenge with a biometric assertion instead of a code.
  const step2 = await auth.verifyBiometricAssertion({
    challenge: step1.mfaToken,
    credentialId: device.credentialId,
    signature: device.sign(step1.mfaToken),
  });
  assert.equal(step2.status, 'authenticated');
  assert.equal(sessionManager.verifyAccess(step2.tokens.accessToken).sub, user.id);
});

// ---------------------------------------------------------------------------
// Credential management
// ---------------------------------------------------------------------------

test('a removed credential can no longer authenticate', async () => {
  const nowRef = { value: 1_700_000_000_000 };
  const { auth } = makeService(nowRef);
  const user = await auth.register('driver.jane', 'hunter2hunter2');
  const device = makeDevice('ES256');
  await enroll(auth, user.id, device);

  const after = await auth.removeBiometricCredential(user.id, device.credentialId);
  assert.equal(after.biometricEnrolled, false);
  await assert.rejects(
    () => auth.removeBiometricCredential(user.id, device.credentialId),
    (e) => e.code === 'AUTH_BIOMETRIC_CREDENTIAL',
  );
  await assert.rejects(
    () => auth.beginBiometricAuth('driver.jane'),
    (e) => e.code === 'AUTH_BIOMETRIC_UNAVAILABLE',
  );
});
