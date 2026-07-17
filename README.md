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
| `src/biometrics.js` | device public-key import + signature verification |
| `src/password.js` | scrypt password hashing |
| `src/session.js` | JWT session manager (access + rotating refresh tokens) |
| `src/auth.js` | auth service: password + optional TOTP MFA / biometrics → session |
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

### Biometrics (native mobile clients)

Native apps (iOS Face ID / Touch ID, Android BiometricPrompt) unlock a
hardware-backed key pair living in the Secure Enclave / Keystore. RoutePilot
registers only the **public** key; the device then proves possession by signing
a short-lived, server-issued challenge. The private key never leaves the device,
so this is a genuine possession factor — usable for **passwordless** native
login or as a **step-up MFA factor** in place of a TOTP code.

Supported signature algorithms: `ES256` (ECDSA P-256), `ES384`, and `Ed25519`.
Public keys are accepted as PEM SPKI or base64url-encoded DER SPKI; signatures
are base64url over the exact challenge string.

```js
// Enroll a device: sign the challenge with the freshly generated private key.
const { challenge } = await auth.beginBiometricEnrollment(userId);
await auth.confirmBiometricEnrollment(userId, {
  challenge,
  credentialId,          // stable per-device id
  publicKey,             // PEM or base64url-DER SPKI
  algorithm: 'ES256',
  signature,             // base64url signature over `challenge`
  label: 'iPhone 15',
});

// Passwordless login on a native client.
const { challenge: c } = await auth.beginBiometricAuth('driver.jane');
const { tokens } = await auth.verifyBiometricAssertion({
  challenge: c,
  credentialId,
  signature,             // device signs `c` behind a biometric prompt
});

// Or complete an MFA challenge with biometrics instead of a TOTP code:
const step1 = await auth.login('driver.jane', 'a-strong-password');
if (step1.status === 'mfa_required') {
  await auth.verifyBiometricAssertion({ challenge: step1.mfaToken, credentialId, signature });
}
```

Signed challenges are single-use within their TTL (replay is rejected), and
credentials can be listed (`listBiometricCredentials`) and revoked
(`removeBiometricCredential`) — e.g. for a lost device.

## Tests

```sh
npm test
```

Runs the built-in Node test runner (`node --test`) over `test/**/*.test.js`.
Correctness is anchored on the published RFC 4226/6238 (OTP) and RFC 4648
(base32) test vectors. No install step is required.
