// Public entry point for RoutePilot's authentication & session module.

export {
  base64UrlEncode,
  base64UrlDecode,
  base32Encode,
  base32Decode,
} from './encoding.js';

export { signJwt, verifyJwt, decodeJwt, JwtError } from './jwt.js';

export {
  generateSecret,
  generateHOTP,
  generateTOTP,
  verifyTOTP,
  keyUri,
} from './totp.js';

export { hashPassword, verifyPassword } from './password.js';

export {
  generateChallenge,
  verifyAssertion,
  importPublicKey,
  deriveCredentialId,
  SUPPORTED_ALGORITHMS,
  BiometricError,
} from './biometrics.js';

export { createSessionManager, SessionError } from './session.js';

export {
  createAuthService,
  createInMemoryUserStore,
  AuthError,
} from './auth.js';
