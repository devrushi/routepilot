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
| `src/onboarding.js` | multi-step driver profile wizard (entity type + region + tax residency) |
| `src/tax-residency.js` | HMRC/IRS tax residency declaration with immediate TIN validation |
| `src/vehicles.js` | vehicle registry supporting multiple active vehicles with fuel/EV type fields |
| `src/vehicle-lookup.js` | fetch vehicle specifications by license plate registration number |
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

## Onboarding Flow

`createProfileWizard` is a small stateful wizard that walks a driver through the
profile questions needed before their financial profile can be created
(_Driver Onboarding & Financial Profile › Authentication & Security ›
Onboarding Flow_). It collects, one step at a time, the driver's legal
**business entity type**, the **region** they operate in, and their **tax
residency declaration**.

Steps are answered in order, each answer is validated and normalized against a
known catalogue (`BUSINESS_ENTITY_TYPES`, `OPERATING_REGIONS` — US states + DC
by default, both overridable), and the driver can navigate `back` (or
`goToStep`) to revise an earlier answer. Once every step is answered the wizard
is finalized into an immutable driver profile, with `requiresEin` derived from
the chosen entity type for the downstream financial module.

```js
import { createProfileWizard } from './src/onboarding.js';

const wizard = createProfileWizard();

wizard.start('usr_123');                                  // → step 1 of 3: entity_type
wizard.submitStep('usr_123', 'entity_type', 'single_member_llc'); // → step 2 of 3: region
wizard.submitStep('usr_123', 'region', 'US-CA');          // → step 3 of 3: tax_residency
wizard.submitStep('usr_123', 'tax_residency', {           // → readyToComplete
  jurisdiction: 'US', taxId: '12-3456789', taxIdType: 'ein', confirmed: true,
});

const profile = wizard.complete('usr_123');
// { userId, entityType: { id, label, category }, region: { id, label, country },
//   taxResidency: { jurisdiction: { id, label, country, authority },
//                   taxIdType, taxIdLabel, taxId, taxIdFormatted, confirmed },
//   requiresEin: true, completedAt }
```

Every navigation method returns a serializable view (current step + options,
`stepNumber`/`totalSteps`, `progress`, collected `answers`) suitable for
rendering a progress bar. Invalid choices, out-of-order submissions, and
completing before every step is answered are rejected with a `WizardError`
carrying a `code`.

### Tax residency declaration

The final onboarding step is the driver's tax residency declaration
(_Driver Onboarding & Financial Profile › Authentication & Security ›
Onboarding Flow › Design HMRC/IRS tax residency declaration step with immediate
validation_). `src/tax-residency.js` is the dependency-free validation core: it
knows the two jurisdictions RoutePilot files with — the **US (IRS)** and the
**UK (HMRC)** — and validates the matching taxpayer identification number
**immediately**, so a driver gets a specific, coded error the moment they submit
rather than after a downstream filing bounces.

| Authority | Accepted tax IDs | Validation |
| --- | --- | --- |
| IRS (US) | SSN, ITIN, EIN | area/group/serial rules, ITIN group ranges, IRS-assigned EIN prefixes |
| HMRC (UK) | UTR, NINO | UTR modulus-11 check digit, NINO prefix/suffix allocation rules |

```js
import { declareTaxResidency, validateTaxId } from './src/tax-residency.js';

// Full declaration (the driver must affirm `confirmed: true`).
const declaration = declareTaxResidency({
  jurisdiction: 'GB',          // id / ISO country code / label; "UK" aliases "GB"
  taxId: '11234 56789',        // whitespace and separators are tolerated
  confirmed: true,
});
// → { jurisdiction: { id: 'GB', authority: 'HMRC', ... },
//     taxIdType: 'utr', taxId: '1123456789', taxIdFormatted: '11234 56789', confirmed: true }

// Or just validate a TIN. The type is auto-detected within the jurisdiction;
// pass `taxIdType` to force one (e.g. a sole proprietor's EIN vs SSN).
validateTaxId({ jurisdiction: 'US', taxId: '12-3456789', taxIdType: 'ein' });
```

Every failure throws a `TaxResidencyError` carrying a `code`
(`TAX_JURISDICTION`, `TAX_ID_FORMAT`, `TAX_ID_INVALID`, `TAX_ID_TYPE`,
`TAX_NOT_CONFIRMED`). Inside the wizard these surface as a `WizardError` with the
same code, so the tax step fails in place without advancing.

## Vehicle registry

Once a driver has a business profile they set up the vehicle(s) they earn with
(_Driver Onboarding & Financial Profile › Business & Vehicle Setup › Vehicle
Registry_). A driver is **not** limited to one vehicle — a rideshare/delivery
driver may keep several on the road at once — so `src/vehicles.js` is a registry
that supports **multiple active vehicles** per driver rather than a single
record. It is the dependency-free schema + validation core for a stored vehicle:
it knows the catalogue of **fuel / EV powertrain types** (and the extra fields an
electric or plug-in vehicle carries), validates and normalizes a submitted
vehicle *immediately*, and manages each vehicle's lifecycle.

| Powertrain (`FUEL_TYPES`) | Category | Combustion | Chargeable (EV fields) |
| --- | --- | --- | --- |
| Gasoline / Diesel | `combustion` | yes | no |
| Hybrid (HEV) | `hybrid` | yes | no |
| Plug-in hybrid (PHEV) | `hybrid` | yes | **yes** |
| Battery electric (BEV) | `electric` | no | **yes** |
| Hydrogen fuel cell (FCEV) | `electric` | no | no |

`chargeable` powertrains (PHEV, BEV) require the EV-only fields — a battery
capacity in kWh and a charge connector (`EV_CONNECTOR_TYPES`: J1772, Type 2, CCS
1/2, CHAdeMO, NACS); supplying those fields for a non-chargeable vehicle is
rejected. VINs are validated with their ISO 3779 modulus-11 check digit
(`computeVinCheckDigit` / `validateVin`), so a mistyped VIN is caught on entry.

```js
import { createVehicleRegistry, validateVehicle } from './src/vehicles.js';

// Validate a vehicle on its own (returns the normalized schema core).
validateVehicle({
  vin: '5YJ3E1EA6KF000000', make: 'Tesla', model: 'Model 3', year: 2019,
  fuelType: 'battery_electric', batteryKwh: 75, connectorType: 'nacs',
});

const registry = createVehicleRegistry();

registry.add('drv_1', { vin: '1HGBH41JXMN109186', make: 'Honda', model: 'Accord', year: 2021, fuelType: 'gasoline' });
registry.add('drv_1', { vin: '5YJ3E1EA6KF000000', make: 'Tesla', model: 'Model 3', year: 2019,
  fuelType: 'battery_electric', batteryKwh: 75, connectorType: 'nacs' });

registry.listActive('drv_1');          // both vehicles, oldest-added first
registry.getPrimary('drv_1');          // the Honda (first active is primary by default)
registry.setPrimary('drv_1', /* id */); // designate a different primary
registry.deactivate('drv_1', /* id */); // temporarily off the road; primary re-assigns
registry.retire('drv_1', /* id */);     // permanent; its VIN may be re-registered later
```

A driver may keep many **active** vehicles; exactly one active vehicle is flagged
`primary` for the downstream financial-profile module, auto-assigned to the first
and re-assigned whenever the current primary is deactivated, retired or removed.
Every method returns frozen record snapshots, and failures throw a `VehicleError`
carrying a `code` (`VEHICLE_VIN_FORMAT`, `VEHICLE_VIN_INVALID`, `VEHICLE_FUEL_TYPE`,
`VEHICLE_CONNECTOR`, `VEHICLE_BATTERY`, `VEHICLE_DUPLICATE`, `VEHICLE_NOT_FOUND`, …).

### Lookup by license plate

Rather than make a driver hand-type every field, `src/vehicle-lookup.js` fetches a
vehicle's **specifications from its license plate registration number** (_Driver
Onboarding & Financial Profile › Business & Vehicle Setup › Vehicle Registry_) so
the registry form can be pre-filled. The network call to the registration
authority (a DVLA Vehicle Enquiry-style service) is an injectable `provider`, so
the endpoint stays dependency-free and fully testable: it normalizes the
registration, resolves the authority's fuel description onto the `FUEL_TYPES`
catalogue, coerces partial provider data into a stable spec, and optionally
caches results.

```js
import { createVehicleLookup } from './src/vehicle-lookup.js';

const lookup = createVehicleLookup({
  // `provider` is where a real deployment calls the authority; return null if unknown.
  provider: async (registration) => fetchFromAuthority(registration),
  cache: new Map(),
  ttlMs: 24 * 60 * 60 * 1000,
});

// Service core — throws a VehicleLookupError on bad input / not found / provider error.
const spec = await lookup.lookup('AB12 CDE');
// { registration: 'AB12CDE', make, model, year, fuel: { id, label, … },
//   fuelDescription, colour, engineCapacityCc, co2Emissions, source, fetchedAt }

// HTTP-shaped adapter for a route like GET /vehicles/specifications?registration=AB12CDE
await lookup.handle({ registration: 'AB12CDE' }); // { status: 200, body: { vehicle } }
await lookup.handle({ registration: 'ZZ' });      // 404 { error: { code: 'VEHICLE_LOOKUP_NOT_FOUND', … } }
```

Failures throw (or, via `handle`, map to a status) a `VehicleLookupError` with a
`code`: `VEHICLE_LOOKUP_PLATE` (400, malformed registration), `VEHICLE_LOOKUP_NOT_FOUND`
(404), `VEHICLE_LOOKUP_PROVIDER` (502, the authority failed or returned garbage),
or `VEHICLE_LOOKUP_CONFIG`.

## Tests

```sh
npm test
```

Runs the built-in Node test runner (`node --test`) over `test/**/*.test.js`.
Correctness is anchored on the published RFC 4226/6238 (OTP) and RFC 4648
(base32) test vectors. No install step is required.
