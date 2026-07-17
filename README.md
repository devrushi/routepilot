# routepilot

Driver onboarding & financial profile platform.

## Authentication & Security

This module provides **JWT-based session handling with optional TOTP MFA**
(_Driver Onboarding & Financial Profile › Authentication & Security ›
Multi-Factor Authentication_).

It is implemented in plain Node.js (ESM) with **zero external dependencies** —
JWT (HS256), TOTP/HOTP (RFC 6238 / 4226), base32/base64url, and password
hashing (scrypt) are all built on Node's `crypto`.

### Layout

| Module | Responsibility |
| --- | --- |
| `src/encoding.js` | base64url + base32 helpers |
| `src/jwt.js` | HS256 JWT sign / verify / decode |
| `src/totp.js` | HOTP, TOTP, `otpauth://` key URIs |
| `src/biometrics.js` | public-key challenge–response for native biometric login |
| `src/password.js` | scrypt password hashing |
| `src/session.js` | JWT session manager (access + rotating refresh tokens) |
| `src/auth.js` | auth service: password + optional TOTP MFA + biometrics → session |
| `src/index.js` | public API barrel |

### Session handling

`createSessionManager` issues a short-lived **access token** and a longer-lived
**refresh token**, both signed JWTs with separate secrets. Refresh tokens are
single-use and rotated on every refresh; replaying a rotated refresh token is
detected and revokes the whole session. Access tokens carry a session id (`sid`)
checked against a revocation store, so logout is immediate.

```js
import { createSessionManager } from './src/session.js';

const sessions = createSessionManager({
  accessSecret: process.env.ACCESS_SECRET,
  refreshSecret: process.env.REFRESH_SECRET,
});

const { accessToken, refreshToken } = sessions.issue('usr_123', { role: 'driver' });
const claims = sessions.verifyAccess(accessToken);
const rotated = sessions.refresh(refreshToken);
sessions.revoke(claims.sid); // logout
```

### Optional TOTP MFA

MFA is per-user and **off by default**. Drivers can enroll an authenticator app;
once enabled, login becomes a two-step flow.

```js
import { createAuthService } from './src/auth.js';

const auth = createAuthService({ sessionManager: sessions, challengeSecret: process.env.MFA_SECRET });

await auth.register('driver.jane', 'a-strong-password');

// Enroll MFA (scan otpauthUri in an authenticator app)
const { secret, otpauthUri } = await auth.beginMfaEnrollment(userId);
const { recoveryCodes } = await auth.confirmMfaEnrollment(userId, '123456');

// Login with MFA enabled
const step1 = await auth.login('driver.jane', 'a-strong-password');
if (step1.status === 'mfa_required') {
  const { tokens } = await auth.verifyMfa(step1.mfaToken, '123456'); // or a recovery code
}
```

### Biometrics for native mobile clients

Native apps can log a driver in with **Face ID / Touch ID** (iOS Secure Enclave)
or **Android BiometricPrompt** (Android Keystore) using public-key
challenge–response — the same shape as WebAuthn/FIDO2 assertions. The device
generates a hardware-backed key pair whose private key is released only after a
successful biometric check and **never leaves the handset**; the server stores
only the public key and verifies a signature over a fresh, single-use challenge.
No biometric data is ever transmitted.

Supported signature algorithms cover what the platform Keystore/Secure Enclave
APIs emit: `ES256`/`ES384`/`ES512` (ECDSA — the default on both platforms),
`RS256`/`PS256` (RSA), and `EdDSA` (Ed25519).

```js
import { createAuthService } from './src/auth.js';

const auth = createAuthService({ sessionManager: sessions, challengeSecret: process.env.MFA_SECRET });

// Enroll a device (call from an already-authorized session). The app generates
// a biometric-gated key pair, signs the challenge, and registers its public key.
const { challenge, challengeToken } = await auth.beginBiometricEnrollment(userId);
const signature = signOnDevice(challenge); // native platform biometric prompt
await auth.confirmBiometricEnrollment(userId, {
  challengeToken,
  publicKey,          // PEM, DER (Buffer/base64url) or JWK
  algorithm: 'ES256',
  signature,          // base64url or Buffer
  deviceName: "Jane's iPhone",
});

// Biometric login: the app knows its credentialId from enrollment.
const step = await auth.beginBiometricAssertion(credentialId);
const assertion = signOnDevice(step.challenge);
const { tokens } = await auth.verifyBiometricAssertion(step.challengeToken, assertion);

// Manage enrolled devices
await auth.listBiometricCredentials(userId);
await auth.removeBiometricCredential(userId, credentialId); // e.g. a lost phone
```

ECDSA signatures are expected in ASN.1/DER (what Secure Enclave, Android
Keystore and WebAuthn produce); pass `signatureFormat: 'ieee-p1363'` for raw
`r‖s`. Challenges are single-use and expire after `biometricChallengeTtlSeconds`
(default 120s), so a captured `(challenge, signature)` pair cannot be replayed.

## Tests

```sh
npm test
```

Runs the built-in Node test runner (`node --test`) over `test/**/*.test.js`.
Correctness is anchored on the published RFC 4226/6238 (OTP) and RFC 4648
(base32) test vectors. No install step is required.
