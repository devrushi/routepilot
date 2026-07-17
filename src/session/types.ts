/** Domain types for authentication and session handling. */

export interface DriverUser {
  id: string;
  email: string;
  passwordHash: string;
  /**
   * TOTP secret. Present once the driver has started MFA enrollment; MFA is
   * only *enforced* at login when `mfaEnabled` is true.
   */
  totpSecret?: string;
  mfaEnabled: boolean;
  createdAt: string;
}

/** A signed access/refresh token pair plus lifetime metadata. */
export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  /** Seconds until the access token expires. */
  expiresIn: number;
}

/** Result of a successful, fully-authenticated login. */
export interface AuthenticatedResult {
  status: 'authenticated';
  tokens: TokenPair;
  user: PublicUser;
}

/**
 * Result of a login where the password was correct but MFA is required. The
 * client must call `completeMfa` with the returned challenge token and a valid
 * TOTP code to obtain real session tokens.
 */
export interface MfaRequiredResult {
  status: 'mfa_required';
  mfaToken: string;
}

export type LoginResult = AuthenticatedResult | MfaRequiredResult;

/** User fields safe to return to clients (never the hash or secret). */
export interface PublicUser {
  id: string;
  email: string;
  mfaEnabled: boolean;
}

/** Token type discriminator carried in the `typ` claim of our JWTs. */
export type SessionTokenType = 'access' | 'refresh' | 'mfa_challenge';

export function toPublicUser(user: DriverUser): PublicUser {
  return { id: user.id, email: user.email, mfaEnabled: user.mfaEnabled };
}
