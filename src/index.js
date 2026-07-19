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
  createSessionManager,
  createInMemorySessionRepo,
  createPostgresSessionRepo,
  SessionError,
} from './session.js';

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
  createInMemoryOnboardingRepo,
  createPostgresOnboardingRepo,
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
  createInMemoryVehicleRepo,
  createPostgresVehicleRepo,
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
  createInMemoryDspLinkRepo,
  createPostgresDspLinkRepo,
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
  createInMemoryRouteSyncRepo,
  createPostgresRouteSyncRepo,
  normalizeRoute,
  normalizeStatus,
  ROUTE_STATUSES,
  RouteSyncError,
} from './route-sync.js';

export { createServer, createRequestHandler, DEFAULT_PORT } from './server.js';

export { createDbClient } from './db.js';

export { createRouter } from './router.js';

export {
  sendJson,
  readJsonBody,
  bearerToken,
  requireSession,
  registerErrorStatuses,
  handleError,
  BodyError,
} from './http-utils.js';

export {
  createShiftTracker,
  createInMemoryShiftRepo,
  createPostgresShiftRepo,
  ShiftError,
} from './shifts.js';

export {
  createFuelLogger,
  createInMemoryFuelRepo,
  createPostgresFuelRepo,
  convertCurrency,
  convertVolume,
  DEFAULT_EXCHANGE_RATES,
  BASE_CURRENCY,
  FuelError,
} from './fuel.js';

export {
  createReceiptProcessor,
  createInMemoryReceiptRepo,
  createPostgresReceiptRepo,
  createMockOcrProvider,
  extractFields,
  ReceiptError,
} from './receipts.js';

export {
  createExpenseTracker,
  createInMemoryExpenseRepo,
  createPostgresExpenseRepo,
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
  createInMemoryEstimatedPaymentRepo,
  createPostgresEstimatedPaymentRepo,
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
  createInMemoryRouteCostRepo,
  createPostgresRouteCostRepo,
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
