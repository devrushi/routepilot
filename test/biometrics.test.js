import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as cryptoSign, constants } from 'node:crypto';
import {
  generateChallenge,
  verifyAssertion,
  importPublicKey,
  deriveCredentialId,
  SUPPORTED_ALGORITHMS,
  BiometricError,
} from '../src/biometrics.js';
import { base64UrlEncode } from '../src/encoding.js';
import { createSessionManager } from '../src/session.js';
import { createAuthService } from '../src/auth.js';

// --- Device simulation -------------------------------------------------------
// Model the native Secure Enclave / Keystore: hold a biometric-gated key pair,
// expose its public key, and sign a server challenge on demand.

function makeDevice(kind = 'ES256') {
  let keyPair;
  let digest;
  let signOpts = {};
  switch (kind) {
    case 'ES256':
      keyPair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
      digest = 'sha256';
      break;
    case 'ES384':
      keyPair = generateKeyPairSync('ec', { namedCurve: 'P-384' });
      digest = 'sha384';
      break;
    case 'RS256':
      keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
      digest = 'sha256';
      break;
    case 'PS256':
      keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
      digest = 'sha256';
      signOpts = { padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST };
      break;
    case 'EdDSA':
      keyPair = generateKeyPairSync('ed25519');
      digest = null;
      break;
    default:
      throw new Error(`unknown device kind ${kind}`);
  }
  return {
    algorithm: kind,
    publicKeyPem: keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    publicKeyJwk: keyPair.publicKey.export({ format: 'jwk' }),
    sign(challenge) {
      const sig = cryptoSign(digest, Buffer.from(challenge, 'utf8'), { key: keyPair.privateKey, ...signOpts });
      return base64UrlEncode(sig);
    },
  };
}

// --- Core primitives ---------------------------------------------------------

test('verifyAssertion accepts a valid signature for every supported algorithm', () => {
  for (const alg of ['ES256', 'ES384', 'RS256', 'PS256', 'EdDSA']) {
    const device = makeDevice(alg);
    const challenge = generateChallenge();
    const signature = device.sign(challenge);
    assert.equal(
      verifyAssertion({ publicKey: device.publicKeyPem, algorithm: alg, challenge, signature }),
      true,
      `${alg} should verify`,
    );
  }
});

test('verifyAssertion rejects a signature over a different challenge', () => {
  const device = makeDevice('ES256');
  const challenge = generateChallenge();
  const signature = device.sign(challenge);
  assert.equal(
    verifyAssertion({ publicKey: device.publicKeyPem, algorithm: 'ES256', challenge: generateChallenge(), signature }),
    false,
  );
});

test('verifyAssertion rejects a signature from a different key', () => {
  const device = makeDevice('ES256');
  const impostor = makeDevice('ES256');
  const challenge = generateChallenge();
  const signature = impostor.sign(challenge);
  assert.equal(
    verifyAssertion({ publicKey: device.publicKeyPem, algorithm: 'ES256', challenge, signature }),
    false,
  );
});

test('verifyAssertion accepts a JWK public key and lowercase algorithm alias', () => {
  const device = makeDevice('ES256');
  const challenge = generateChallenge();
  const signature = device.sign(challenge);
  assert.equal(
    verifyAssertion({ publicKey: device.publicKeyJwk, algorithm: 'es256', challenge, signature }),
    true,
  );
});

test('verifyAssertion supports raw (ieee-p1363) ECDSA signatures', () => {
  const keyPair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const challenge = generateChallenge();
  const raw = cryptoSign('sha256', Buffer.from(challenge, 'utf8'), { key: keyPair.privateKey, dsaEncoding: 'ieee-p1363' });
  const pem = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  assert.equal(verifyAssertion({ publicKey: pem, algorithm: 'ES256', challenge, signature: raw, signatureFormat: 'ieee-p1363' }), true);
  // The same raw signature must NOT verify when interpreted as DER.
  assert.equal(verifyAssertion({ publicKey: pem, algorithm: 'ES256', challenge, signature: raw }), false);
});

test('verifyAssertion returns false (never throws) on malformed/absent signatures', () => {
  const device = makeDevice('ES256');
  const challenge = generateChallenge();
  assert.equal(verifyAssertion({ publicKey: device.publicKeyPem, algorithm: 'ES256', challenge, signature: 'not-a-signature!!' }), false);
  assert.equal(verifyAssertion({ publicKey: device.publicKeyPem, algorithm: 'ES256', challenge, signature: '' }), false);
  assert.equal(verifyAssertion({ publicKey: device.publicKeyPem, algorithm: 'ES256', challenge, signature: null }), false);
});

test('verifyAssertion throws on an unsupported algorithm or bad public key', () => {
  const device = makeDevice('ES256');
  const challenge = generateChallenge();
  const signature = device.sign(challenge);
  assert.throws(
    () => verifyAssertion({ publicKey: device.publicKeyPem, algorithm: 'HS256', challenge, signature }),
    (e) => e instanceof BiometricError && e.code === 'BIOMETRIC_ALGORITHM',
  );
  assert.throws(
    () => verifyAssertion({ publicKey: 'not a key', algorithm: 'ES256', challenge, signature }),
    (e) => e instanceof BiometricError && e.code === 'BIOMETRIC_PUBLIC_KEY',
  );
});

test('generateChallenge is random, base64url and rejects weak entropy', () => {
  assert.match(generateChallenge(), /^[A-Za-z0-9_-]+$/);
  assert.notEqual(generateChallenge(), generateChallenge());
  assert.throws(() => generateChallenge(8), (e) => e.code === 'BIOMETRIC_CHALLENGE');
});

test('deriveCredentialId is stable per key and unique across keys', () => {
  const a = makeDevice('ES256');
  const b = makeDevice('ES256');
  const { pem } = importPublicKey(a.publicKeyPem);
  assert.equal(deriveCredentialId(pem), deriveCredentialId(a.publicKeyPem));
  assert.notEqual(deriveCredentialId(a.publicKeyPem), deriveCredentialId(b.publicKeyPem));
});

test('importPublicKey rejects a private key', () => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  assert.throws(() => importPublicKey(pem), (e) => e instanceof BiometricError && e.code === 'BIOMETRIC_PUBLIC_KEY');
});

test('SUPPORTED_ALGORITHMS advertises the mobile-relevant set', () => {
  for (const alg of ['ES256', 'RS256', 'PS256', 'EdDSA']) {
    assert.ok(SUPPORTED_ALGORITHMS.includes(alg), `${alg} advertised`);
  }
});

// --- Auth service integration ------------------------------------------------

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

async function enroll(auth, userId, device, deviceName) {
  const { challenge, challengeToken } = await auth.beginBiometricEnrollment(userId);
  return auth.confirmBiometricEnrollment(userId, {
    challengeToken,
    publicKey: device.publicKeyPem,
    algorithm: device.algorithm,
    signature: device.sign(challenge),
    deviceName,
  });
}

test('enroll a biometric device then log in with it', async () => {
  const nowRef = { value: 1_700_000_000_000 };
  const { auth, sessionManager } = makeService(nowRef);
  const user = await auth.register('driver.jane', 'hunter2hunter2');
  const device = makeDevice('ES256');

  const cred = await enroll(auth, user.id, device, "Jane's iPhone");
  assert.equal(cred.algorithm, 'ES256');
  assert.equal(cred.deviceName, "Jane's iPhone");
  assert.ok(cred.id);

  const stored = await auth.userStore.findById(user.id);
  assert.equal(stored.biometrics.credentials.length, 1);
  const sanitizedUser = await auth.login('driver.jane', 'hunter2hunter2');
  assert.equal(sanitizedUser.user.biometricEnrolled, true);

  // Biometric login
  const step = await auth.beginBiometricAssertion(cred.id);
  const result = await auth.verifyBiometricAssertion(step.challengeToken, device.sign(step.challenge));
  assert.equal(result.status, 'authenticated');
  assert.equal(sessionManager.verifyAccess(result.tokens.accessToken).sub, user.id);
});

test('enrollment fails if the device cannot prove key possession', async () => {
  const nowRef = { value: 1_700_000_000_000 };
  const { auth } = makeService(nowRef);
  const user = await auth.register('driver.jane', 'hunter2hunter2');
  const device = makeDevice('ES256');
  const impostor = makeDevice('ES256');

  const { challenge, challengeToken } = await auth.beginBiometricEnrollment(user.id);
  await assert.rejects(
    () => auth.confirmBiometricEnrollment(user.id, {
      challengeToken,
      publicKey: device.publicKeyPem,
      algorithm: 'ES256',
      signature: impostor.sign(challenge), // signed by the wrong key
    }),
    (e) => e.code === 'AUTH_BIOMETRIC_INVALID_SIGNATURE',
  );
});

test('a biometric assertion signature must match the challenge', async () => {
  const nowRef = { value: 1_700_000_000_000 };
  const { auth } = makeService(nowRef);
  const user = await auth.register('driver.jane', 'hunter2hunter2');
  const device = makeDevice('ES256');
  const cred = await enroll(auth, user.id, device);

  const step = await auth.beginBiometricAssertion(cred.id);
  // Sign a different challenge value.
  await assert.rejects(
    () => auth.verifyBiometricAssertion(step.challengeToken, device.sign(generateChallenge())),
    (e) => e.code === 'AUTH_BIOMETRIC_INVALID_SIGNATURE',
  );
});

test('a biometric challenge is single-use (replay is rejected)', async () => {
  const nowRef = { value: 1_700_000_000_000 };
  const { auth } = makeService(nowRef);
  const user = await auth.register('driver.jane', 'hunter2hunter2');
  const device = makeDevice('ES256');
  const cred = await enroll(auth, user.id, device);

  const step = await auth.beginBiometricAssertion(cred.id);
  const signature = device.sign(step.challenge);
  await auth.verifyBiometricAssertion(step.challengeToken, signature);
  // Replaying the exact same (challenge, signature) pair must fail.
  await assert.rejects(
    () => auth.verifyBiometricAssertion(step.challengeToken, signature),
    (e) => e.code === 'AUTH_BIOMETRIC_CHALLENGE_INVALID',
  );
});

test('an expired biometric challenge is rejected', async () => {
  const nowRef = { value: 1_700_000_000_000 };
  const { auth } = makeService(nowRef);
  const user = await auth.register('driver.jane', 'hunter2hunter2');
  const device = makeDevice('ES256');
  const cred = await enroll(auth, user.id, device);

  const step = await auth.beginBiometricAssertion(cred.id);
  nowRef.value += 3 * 60 * 1000; // past the 120s challenge TTL
  await assert.rejects(
    () => auth.verifyBiometricAssertion(step.challengeToken, device.sign(step.challenge)),
    (e) => e.code === 'AUTH_BIOMETRIC_CHALLENGE_INVALID',
  );
});

test('an enrollment challenge cannot be used to log in (wrong typ)', async () => {
  const nowRef = { value: 1_700_000_000_000 };
  const { auth } = makeService(nowRef);
  const user = await auth.register('driver.jane', 'hunter2hunter2');
  const device = makeDevice('ES256');
  await enroll(auth, user.id, device);

  const { challenge, challengeToken } = await auth.beginBiometricEnrollment(user.id);
  await assert.rejects(
    () => auth.verifyBiometricAssertion(challengeToken, device.sign(challenge)),
    (e) => e.code === 'AUTH_BIOMETRIC_CHALLENGE_INVALID',
  );
});

test('beginBiometricAssertion rejects an unknown credential', async () => {
  const nowRef = { value: 1_700_000_000_000 };
  const { auth } = makeService(nowRef);
  await auth.register('driver.jane', 'hunter2hunter2');
  await assert.rejects(
    () => auth.beginBiometricAssertion('nope'),
    (e) => e.code === 'AUTH_BIOMETRIC_UNKNOWN',
  );
});

test('a duplicate device enrollment is rejected', async () => {
  const nowRef = { value: 1_700_000_000_000 };
  const { auth } = makeService(nowRef);
  const user = await auth.register('driver.jane', 'hunter2hunter2');
  const device = makeDevice('ES256');
  await enroll(auth, user.id, device);
  await assert.rejects(() => enroll(auth, user.id, device), (e) => e.code === 'AUTH_BIOMETRIC_EXISTS');
});

test('list and remove biometric credentials', async () => {
  const nowRef = { value: 1_700_000_000_000 };
  const { auth } = makeService(nowRef);
  const user = await auth.register('driver.jane', 'hunter2hunter2');
  const phone = makeDevice('ES256');
  const tablet = makeDevice('EdDSA');
  const c1 = await enroll(auth, user.id, phone, 'phone');
  const c2 = await enroll(auth, user.id, tablet, 'tablet');

  let list = await auth.listBiometricCredentials(user.id);
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((c) => c.deviceName).sort(), ['phone', 'tablet']);

  assert.equal(await auth.removeBiometricCredential(user.id, c1.id), true);
  assert.equal(await auth.removeBiometricCredential(user.id, c1.id), false);
  list = await auth.listBiometricCredentials(user.id);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, c2.id);

  // A removed credential can no longer start an assertion.
  await assert.rejects(() => auth.beginBiometricAssertion(c1.id), (e) => e.code === 'AUTH_BIOMETRIC_UNKNOWN');
});

test('verifyBiometricAssertion updates lastUsedAt', async () => {
  const nowRef = { value: 1_700_000_000_000 };
  const { auth } = makeService(nowRef);
  const user = await auth.register('driver.jane', 'hunter2hunter2');
  const device = makeDevice('ES256');
  const cred = await enroll(auth, user.id, device);
  assert.equal(cred.lastUsedAt, null);

  nowRef.value += 5000;
  const step = await auth.beginBiometricAssertion(cred.id);
  await auth.verifyBiometricAssertion(step.challengeToken, device.sign(step.challenge));

  const [updated] = await auth.listBiometricCredentials(user.id);
  assert.equal(updated.lastUsedAt, nowRef.value);
});
