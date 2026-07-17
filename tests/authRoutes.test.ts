import request from 'supertest';
import { loadAuthConfig } from '../src/config';
import { generateTotp } from '../src/auth/totp';
import { createApp } from '../src/http/app';
import { extractBearerToken } from '../src/http/authMiddleware';

function buildApp() {
  const config = loadAuthConfig({ AUTH_JWT_SECRET: 'route-test-secret' } as NodeJS.ProcessEnv);
  return createApp({ config }).app;
}

const EMAIL = 'driver@example.com';
const PASSWORD = 'supersecret123';

describe('extractBearerToken', () => {
  it('parses a bearer header case-insensitively', () => {
    expect(extractBearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(extractBearerToken('bearer   abc')).toBe('abc');
    expect(extractBearerToken('Basic abc')).toBeUndefined();
    expect(extractBearerToken(undefined)).toBeUndefined();
  });
});

describe('health', () => {
  it('reports ok', async () => {
    const res = await request(buildApp()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});

describe('auth routes — registration & login', () => {
  it('registers a driver', async () => {
    const res = await request(buildApp())
      .post('/auth/register')
      .send({ email: EMAIL, password: PASSWORD });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('authenticated');
    expect(res.body.tokens.accessToken).toBeTruthy();
  });

  it('rejects weak passwords with a 400 and a code', async () => {
    const res = await request(buildApp())
      .post('/auth/register')
      .send({ email: EMAIL, password: 'x' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('weak_password');
  });

  it('logs in and reaches a protected route', async () => {
    const app = buildApp();
    await request(app).post('/auth/register').send({ email: EMAIL, password: PASSWORD });

    const login = await request(app)
      .post('/auth/login')
      .send({ email: EMAIL, password: PASSWORD });
    expect(login.status).toBe(200);

    const me = await request(app)
      .get('/auth/me')
      .set('Authorization', `Bearer ${login.body.tokens.accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(EMAIL);
  });

  it('rejects bad credentials with 401', async () => {
    const app = buildApp();
    await request(app).post('/auth/register').send({ email: EMAIL, password: PASSWORD });
    const res = await request(app)
      .post('/auth/login')
      .send({ email: EMAIL, password: 'nope' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('invalid_credentials');
  });

  it('protects /auth/me without a token', async () => {
    const res = await request(buildApp()).get('/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('missing_token');
  });
});

describe('auth routes — refresh', () => {
  it('exchanges a refresh token for new tokens', async () => {
    const app = buildApp();
    const reg = await request(app)
      .post('/auth/register')
      .send({ email: EMAIL, password: PASSWORD });

    const res = await request(app)
      .post('/auth/refresh')
      .send({ refreshToken: reg.body.tokens.refreshToken });

    expect(res.status).toBe(200);
    expect(res.body.tokens.accessToken).toBeTruthy();
  });
});

describe('auth routes — full MFA flow', () => {
  it('enrolls, activates, then enforces MFA at login', async () => {
    const app = buildApp();
    const reg = await request(app)
      .post('/auth/register')
      .send({ email: EMAIL, password: PASSWORD });
    const accessToken = reg.body.tokens.accessToken;

    // Enrollment.
    const setup = await request(app)
      .post('/auth/mfa/setup')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(setup.status).toBe(200);
    const secret: string = setup.body.secret;
    expect(secret).toBeTruthy();

    // Activation.
    const activate = await request(app)
      .post('/auth/mfa/activate')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ code: generateTotp(secret) });
    expect(activate.status).toBe(200);
    expect(activate.body.user.mfaEnabled).toBe(true);

    // Login now requires MFA.
    const login = await request(app)
      .post('/auth/login')
      .send({ email: EMAIL, password: PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.status).toBe('mfa_required');
    expect(login.body.mfaToken).toBeTruthy();

    // Completing MFA yields real tokens.
    const verify = await request(app)
      .post('/auth/mfa/verify')
      .send({ mfaToken: login.body.mfaToken, code: generateTotp(secret) });
    expect(verify.status).toBe(200);
    expect(verify.body.status).toBe('authenticated');
    expect(verify.body.tokens.accessToken).toBeTruthy();
  });

  it('rejects MFA verification with a bad code', async () => {
    const app = buildApp();
    const reg = await request(app)
      .post('/auth/register')
      .send({ email: EMAIL, password: PASSWORD });
    const accessToken = reg.body.tokens.accessToken;

    const setup = await request(app)
      .post('/auth/mfa/setup')
      .set('Authorization', `Bearer ${accessToken}`);
    await request(app)
      .post('/auth/mfa/activate')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ code: generateTotp(setup.body.secret) });

    const login = await request(app)
      .post('/auth/login')
      .send({ email: EMAIL, password: PASSWORD });

    const verify = await request(app)
      .post('/auth/mfa/verify')
      .send({ mfaToken: login.body.mfaToken, code: '000000' });
    expect(verify.status).toBe(401);
    expect(verify.body.error.code).toBe('invalid_mfa_code');
  });
});
