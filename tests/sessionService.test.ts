import { loadAuthConfig } from '../src/config';
import { generateTotp } from '../src/auth/totp';
import { AuthError, SessionService } from '../src/session/sessionService';
import { InMemoryUserStore } from '../src/session/userStore';
import { AuthenticatedResult, MfaRequiredResult } from '../src/session/types';

function makeService() {
  const config = loadAuthConfig({ AUTH_JWT_SECRET: 'session-test-secret' } as NodeJS.ProcessEnv);
  const store = new InMemoryUserStore();
  return { service: new SessionService(store, config), store, config };
}

const EMAIL = 'driver@example.com';
const PASSWORD = 'supersecret123';

describe('registration', () => {
  it('registers a driver and issues a token pair', async () => {
    const { service } = makeService();
    const result = await service.register(EMAIL, PASSWORD);

    expect(result.status).toBe('authenticated');
    expect(result.tokens.accessToken).toBeTruthy();
    expect(result.tokens.refreshToken).toBeTruthy();
    expect(result.tokens.tokenType).toBe('Bearer');
    expect(result.user.email).toBe(EMAIL);
    expect(result.user.mfaEnabled).toBe(false);
  });

  it('normalizes the email', async () => {
    const { service } = makeService();
    const result = await service.register('  Driver@Example.COM ', PASSWORD);
    expect(result.user.email).toBe(EMAIL);
  });

  it('rejects invalid emails', async () => {
    const { service } = makeService();
    await expect(service.register('nope', PASSWORD)).rejects.toMatchObject({
      code: 'invalid_email',
    });
  });

  it('rejects weak passwords', async () => {
    const { service } = makeService();
    await expect(service.register(EMAIL, 'short')).rejects.toMatchObject({
      code: 'weak_password',
    });
  });

  it('rejects duplicate emails', async () => {
    const { service } = makeService();
    await service.register(EMAIL, PASSWORD);
    await expect(service.register(EMAIL, PASSWORD)).rejects.toMatchObject({
      code: 'email_taken',
    });
  });
});

describe('login without MFA', () => {
  it('authenticates with correct credentials', async () => {
    const { service } = makeService();
    await service.register(EMAIL, PASSWORD);
    const result = await service.login(EMAIL, PASSWORD);
    expect(result.status).toBe('authenticated');
  });

  it('rejects a wrong password', async () => {
    const { service } = makeService();
    await service.register(EMAIL, PASSWORD);
    await expect(service.login(EMAIL, 'wrong')).rejects.toMatchObject({
      code: 'invalid_credentials',
    });
  });

  it('rejects an unknown user with the same generic error', async () => {
    const { service } = makeService();
    await expect(service.login('ghost@example.com', PASSWORD)).rejects.toMatchObject({
      code: 'invalid_credentials',
    });
  });
});

describe('token lifecycle', () => {
  it('authenticates using an issued access token', async () => {
    const { service } = makeService();
    const reg = await service.register(EMAIL, PASSWORD);
    const user = await service.authenticate(reg.tokens.accessToken);
    expect(user.email).toBe(EMAIL);
  });

  it('refreshes a session from a refresh token', async () => {
    const { service } = makeService();
    const reg = await service.register(EMAIL, PASSWORD);
    const pair = await service.refresh(reg.tokens.refreshToken);
    expect(pair.accessToken).toBeTruthy();
    const user = await service.authenticate(pair.accessToken);
    expect(user.email).toBe(EMAIL);
  });

  it('does not accept a refresh token where an access token is required', async () => {
    const { service } = makeService();
    const reg = await service.register(EMAIL, PASSWORD);
    await expect(service.authenticate(reg.tokens.refreshToken)).rejects.toMatchObject({
      code: 'invalid_token',
    });
  });

  it('does not accept an access token to refresh', async () => {
    const { service } = makeService();
    const reg = await service.register(EMAIL, PASSWORD);
    await expect(service.refresh(reg.tokens.accessToken)).rejects.toMatchObject({
      code: 'invalid_token',
    });
  });

  it('rejects a garbage token', async () => {
    const { service } = makeService();
    await expect(service.authenticate('garbage')).rejects.toBeInstanceOf(AuthError);
  });
});

describe('MFA enrollment and login', () => {
  async function enrollMfa(service: SessionService, userId: string) {
    const enrollment = await service.beginMfaEnrollment(userId);
    const code = generateTotp(enrollment.secret);
    await service.activateMfa(userId, code);
    return enrollment.secret;
  }

  it('begins enrollment with a usable otpauth uri and secret', async () => {
    const { service } = makeService();
    const reg = await service.register(EMAIL, PASSWORD);
    const enrollment = await service.beginMfaEnrollment(reg.user.id);
    expect(enrollment.secret).toMatch(/^[A-Z2-7]+$/);
    expect(enrollment.otpauthUri).toContain('otpauth://totp/');
    expect(enrollment.otpauthUri).toContain(`secret=${enrollment.secret}`);
  });

  it('activates MFA with a valid code', async () => {
    const { service } = makeService();
    const reg = await service.register(EMAIL, PASSWORD);
    await enrollMfa(service, reg.user.id);
    const stored = await service.authenticate(reg.tokens.accessToken);
    expect(stored.mfaEnabled).toBe(true);
  });

  it('refuses to activate with an invalid code', async () => {
    const { service } = makeService();
    const reg = await service.register(EMAIL, PASSWORD);
    await service.beginMfaEnrollment(reg.user.id);
    await expect(service.activateMfa(reg.user.id, '000000')).rejects.toMatchObject({
      code: 'invalid_mfa_code',
    });
  });

  it('refuses to activate before enrollment starts', async () => {
    const { service } = makeService();
    const reg = await service.register(EMAIL, PASSWORD);
    await expect(service.activateMfa(reg.user.id, '000000')).rejects.toMatchObject({
      code: 'mfa_not_initialized',
    });
  });

  it('requires MFA at login once enabled', async () => {
    const { service } = makeService();
    const reg = await service.register(EMAIL, PASSWORD);
    await enrollMfa(service, reg.user.id);

    const result = await service.login(EMAIL, PASSWORD);
    expect(result.status).toBe('mfa_required');
    expect((result as MfaRequiredResult).mfaToken).toBeTruthy();
  });

  it('completes MFA login with a valid code', async () => {
    const { service } = makeService();
    const reg = await service.register(EMAIL, PASSWORD);
    const secret = await enrollMfa(service, reg.user.id);

    const login = (await service.login(EMAIL, PASSWORD)) as MfaRequiredResult;
    const completed = await service.completeMfa(login.mfaToken, generateTotp(secret));
    expect(completed.status).toBe('authenticated');
    expect(completed.tokens.accessToken).toBeTruthy();
  });

  it('rejects MFA completion with a bad code', async () => {
    const { service } = makeService();
    const reg = await service.register(EMAIL, PASSWORD);
    await enrollMfa(service, reg.user.id);

    const login = (await service.login(EMAIL, PASSWORD)) as MfaRequiredResult;
    await expect(service.completeMfa(login.mfaToken, '000000')).rejects.toMatchObject({
      code: 'invalid_mfa_code',
    });
  });

  it('does not accept an access token in place of the MFA challenge token', async () => {
    const { service } = makeService();
    const reg = await service.register(EMAIL, PASSWORD);
    const secret = await enrollMfa(service, reg.user.id);
    await expect(
      service.completeMfa(reg.tokens.accessToken, generateTotp(secret)),
    ).rejects.toMatchObject({ code: 'invalid_token' });
  });

  it('disables MFA with a valid code and reverts to single-factor login', async () => {
    const { service } = makeService();
    const reg = await service.register(EMAIL, PASSWORD);
    const secret = await enrollMfa(service, reg.user.id);

    const updated = await service.disableMfa(reg.user.id, generateTotp(secret));
    expect(updated.mfaEnabled).toBe(false);

    const login = await service.login(EMAIL, PASSWORD);
    expect(login.status).toBe('authenticated');
  });

  it('prevents enrolling twice while already enabled', async () => {
    const { service } = makeService();
    const reg = await service.register(EMAIL, PASSWORD);
    await enrollMfa(service, reg.user.id);
    await expect(service.beginMfaEnrollment(reg.user.id)).rejects.toMatchObject({
      code: 'mfa_already_enabled',
    });
  });
});

// Type-only sanity: AuthenticatedResult remains the register/login happy path.
const _typeCheck: AuthenticatedResult['status'] = 'authenticated';
void _typeCheck;
