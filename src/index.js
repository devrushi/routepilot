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

export { createSessionManager, SessionError } from './session.js';

export {
  createAuthService,
  createInMemoryUserStore,
  AuthError,
} from './auth.js';

export {
  verifyBiometricSignature,
  importPublicKey,
  normalizePublicKey,
  isSupportedBiometricAlgorithm,
  SUPPORTED_BIOMETRIC_ALGORITHMS,
  BiometricError,
} from './biometrics.js';

export {
  createProfileWizard,
  BUSINESS_ENTITY_TYPES,
  OPERATING_REGIONS,
  WizardError,
} from './onboarding.js';

export {
  createTaxResidencyStep,
  declareTaxResidency,
  validateTaxId,
  validateSsn,
  validateItin,
  validateEin,
  validateUtr,
  validateNino,
  computeUtrCheckDigit,
  TAX_JURISDICTIONS,
  TAX_ID_TYPES,
  TaxResidencyError,
} from './tax-residency.js';

export {
  createVehicleRegistry,
  validateVehicle,
  validateVin,
  computeVinCheckDigit,
  FUEL_TYPES,
  EV_CONNECTOR_TYPES,
  VEHICLE_STATUSES,
  VehicleError,
} from './vehicles.js';

export {
  createVehicleLookup,
  normalizeRegistration,
  normalizeSpecification,
  resolveFuelDescription,
  VehicleLookupError,
} from './vehicle-lookup.js';

export {
  createDspConnectionManager,
  validateDspLink,
  validatePayoutRate,
  computePayout,
  DSP_PARTNERS,
  PAYOUT_RATE_TYPES,
  LINK_STATUSES,
  DspError,
} from './dsp.js';

export {
  createRouteHistorySyncWorker,
  normalizeRoute,
  normalizeStatus,
  ROUTE_STATUSES,
  RouteSyncError,
} from './route-sync.js';
