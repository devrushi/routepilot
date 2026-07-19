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

export { createServer, DEFAULT_PORT } from './server.js';

export { createShiftTracker, ShiftError } from './shifts.js';

export {
  createFuelLogger,
  convertCurrency,
  convertVolume,
  DEFAULT_EXCHANGE_RATES,
  BASE_CURRENCY,
  FuelError,
} from './fuel.js';

export {
  createReceiptProcessor,
  createMockOcrProvider,
  extractFields,
  ReceiptError,
} from './receipts.js';

export {
  createExpenseTracker,
  bucketFor,
  resolveAuthority,
  EXPENSE_CATEGORIES,
  ExpenseError,
} from './expenses.js';

export {
  createTaxEstimator,
  computeProgressiveTax,
  US_FEDERAL_BRACKETS_2024,
  US_STANDARD_DEDUCTION_2024,
  GB_INCOME_TAX_BANDS_2024,
  DEFAULT_JURISDICTION_TAX_CONFIG,
  TaxEstimationError,
} from './tax-estimation.js';

export {
  createEstimatedPaymentTracker,
  getQuarterlyDueDates,
  nextDueDate,
  EstimatedPaymentError,
} from './estimated-payments.js';

export {
  createVectorStore,
  createDriverPatternIndex,
  createMockEmbeddingProvider,
  cosineSimilarity,
  EmbeddingError,
} from './embeddings.js';

export {
  createTaxAssistant,
  createMockLlmProvider,
  assembleContext,
  TaxAssistantError,
} from './tax-assistant.js';

export {
  detectCostAnomaly,
  createRouteCostTracker,
  DEFAULT_ANOMALY_THRESHOLD,
  CostAnomalyError,
} from './cost-anomaly.js';

export {
  createNotificationScheduler,
  createMockPushProvider,
  shiftMissingMileage,
  receiptOverdue,
  DEFAULT_RECEIPT_WINDOW_MS,
  NotificationError,
} from './notifications.js';

export {
  bucketWeeklyProfit,
  renderWeeklyProfitChartSvg,
  AnalyticsError,
} from './analytics.js';

export {
  reconcileRoute,
  createPayoutReconciliationWidget,
  DEFAULT_RECONCILIATION_TOLERANCE,
  PayoutReconciliationError,
} from './payout-reconciliation.js';

export {
  generateExpenseCsv,
  generateMileageCsv,
  generateTaxExportPdf,
  renderPdf,
  ExportError,
} from './exports.js';

export {
  createSignedExportLinkService,
  createScheduledExportEmailWorker,
  createMockEmailProvider,
  ExportLinkError,
} from './export-links.js';
