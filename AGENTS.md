# RoutePilot — Agent Notes

RoutePilot is a driver onboarding & financial profile platform for gig/delivery drivers. This file is read automatically by the coding agent before each ticket, and the agent appends to the log below as it learns things — keep it accurate and short; prune stale entries rather than letting this grow forever.

## Stack & conventions

- Plain Node.js, ESM (`"type": "module"` in package.json). No web framework is wired up yet — check `package.json` dependencies before assuming one exists, since a "Basic Platform Setup" ticket may have added one since this was written.
- Tests: Node's built-in test runner (`node --test`), not Jest/Mocha/Vitest. Run with `npm test`. Convention is one `test/<name>.test.js` file per `src/<name>.js` module.
- `src/index.js` is the public entry point — it re-exports the pieces other code is meant to consume. When a ticket adds a new module other code should use, add its exports here too.
- Error handling convention: each module defines its own `<Name>Error` class (e.g. `AuthError`, `WizardError`, `JwtError`, `SessionError`, `BiometricError`) rather than throwing a plain `Error` — follow this pattern for new modules.
- Existing modules (as of when this was written): `auth.js`, `biometrics.js`, `dsp.js`, `encoding.js`, `jwt.js`, `onboarding.js`, `password.js`, `route-sync.js`, `session.js`, `tax-residency.js`, `totp.js`, `vehicle-lookup.js`, `vehicles.js`.

## Decisions & Conventions Log

(Empty so far. Add 1-3 short bullets here only for a genuinely reusable decision — a new shared module, a workaround for a specific issue, a naming convention a future ticket should follow. Skip routine, ticket-specific details. Prune anything below that's no longer true instead of letting it accumulate.)

- HTTP server (`src/server.js`, `createServer()`) is built on Node's built-in `http` module, not Express — the repo had zero dependencies before this, so a hand-rolled router keeps that true. Revisit if routing needs grow (path params, middleware).
- `createServer()` only builds the server; it self-starts (reading `PORT`, default 3000) only when run directly via `node src/server.js` / `npm start`, guarded by an `import.meta.url` check. Import `createServer` from `src/index.js` for tests/composition instead of spawning a real process.
- Route handlers respond with `sendJson(res, status, body)` — keep new routes returning JSON via that helper for consistent headers.
- `createServer(config)` accepts optional `sessionManager`/`authService`/`now` overrides (defaults build an in-memory `createSessionManager` + `createAuthService`, secrets from `SESSION_ACCESS_SECRET`/`SESSION_REFRESH_SECRET`/`AUTH_CHALLENGE_SECRET` env vars with dev fallbacks). Tests inject their own pair for deterministic clocks — see `test/server.test.js`.
- Auth endpoints: `POST /register` → 201 `{ user }`; `POST /login` → 200 `{ status: 'authenticated', user, tokens }` or `{ status: 'mfa_required', mfaToken }`; `POST /login/verify-totp` → 200 `{ status: 'authenticated', user, tokens }`. `AuthError` codes are mapped to HTTP status via the `AUTH_ERROR_STATUS` table in `server.js` (400 default, 401 for bad credentials/MFA, 409 for duplicate username).
