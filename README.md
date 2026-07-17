# RoutePilot

Driver onboarding & financial profile platform.

## Authentication & Security

RoutePilot uses **JWT-based session handling with optional TOTP multi-factor
authentication**. The implementation is self-contained (no third-party JWT or
OTP libraries) and lives under `src/`:

| Area | File |
| --- | --- |
| HS256 JWT sign/verify | `src/auth/jwt.ts` |
| TOTP (RFC 4226 / RFC 6238) | `src/auth/totp.ts` |
| Password hashing (scrypt) | `src/auth/password.ts` |
| Session orchestration | `src/session/sessionService.ts` |
| HTTP API | `src/http/authRoutes.ts` |

### Session model

- **Access token** — short-lived (15 min default) JWT presented as a
  `Bearer` token to reach protected routes.
- **Refresh token** — long-lived (30 day default) JWT exchanged for a fresh
  token pair via `POST /auth/refresh`.
- **MFA challenge token** — short-lived interim JWT issued when a driver with
  MFA enabled logs in; it is exchanged (together with a TOTP code) for real
  session tokens.

Each token carries a `typ` claim (`access` / `refresh` / `mfa_challenge`) that
is checked on verification, so a token cannot be used outside its purpose.

### MFA is optional

MFA is opt-in per driver. A driver enrolls, confirms a code to activate, and
from then on their login returns `mfa_required` until they complete the TOTP
challenge. MFA can be disabled again by confirming a valid code.

### HTTP API

| Method & path | Auth | Purpose |
| --- | --- | --- |
| `POST /auth/register` | — | Create a driver, returns tokens |
| `POST /auth/login` | — | Password login → tokens or `mfa_required` |
| `POST /auth/mfa/verify` | mfaToken | Complete an MFA login |
| `POST /auth/refresh` | refreshToken | Rotate the token pair |
| `GET  /auth/me` | access | Current driver profile |
| `POST /auth/mfa/setup` | access | Begin TOTP enrollment (returns `otpauth://` URI) |
| `POST /auth/mfa/activate` | access | Activate MFA with a TOTP code |
| `POST /auth/mfa/disable` | access | Disable MFA with a TOTP code |

### Configuration

All values have safe defaults; override via environment variables
(`AUTH_JWT_SECRET`, `AUTH_ACCESS_TTL`, `AUTH_REFRESH_TTL`,
`AUTH_MFA_CHALLENGE_TTL`, `AUTH_ISSUER`, `AUTH_TOTP_ISSUER`). **Always set
`AUTH_JWT_SECRET` in production.**

## Development

```bash
npm install
npm test         # run the Jest suite
npm run typecheck
npm run build    # compile to dist/
npm start        # run the compiled service
npm run dev      # run from source with ts-node
```

> Persistence is currently an in-memory store (`InMemoryUserStore`) behind the
> `UserStore` interface, intended to be swapped for a database in a later
> ticket without touching the session logic.
