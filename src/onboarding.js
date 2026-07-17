// Multi-step driver profile onboarding wizard for RoutePilot.
//
// Before a driver's financial profile can be created they must tell us how
// they are set up to do business. This module is a small stateful wizard that
// walks a driver through those questions one step at a time: first the legal
// **business entity type** they operate under, then the **region** they
// operate in. Steps are answered in order, each answer is validated and
// normalized against a known catalogue, and a driver can navigate back to
// revise an earlier step. Once every step is answered the wizard is finalized
// into an immutable driver profile (with a few fields derived for the
// downstream financial-profile module, e.g. whether an EIN is required).

import {
  createTaxResidencyStep,
  TAX_JURISDICTIONS,
  TaxResidencyError,
} from './tax-residency.js';

export class WizardError extends Error {
  constructor(message, code = 'WIZARD_INVALID') {
    super(message);
    this.name = 'WizardError';
    this.code = code;
  }
}

/**
 * Business entity types a driver can onboard as. `category` groups them for the
 * financial module and `requiresEin` records whether the IRS requires an
 * Employer Identification Number (a sole proprietor may use their SSN).
 */
export const BUSINESS_ENTITY_TYPES = [
  { id: 'sole_proprietor', label: 'Sole proprietor', category: 'individual', requiresEin: false },
  { id: 'single_member_llc', label: 'Single-member LLC', category: 'llc', requiresEin: true },
  { id: 'multi_member_llc', label: 'Multi-member LLC', category: 'llc', requiresEin: true },
  { id: 'partnership', label: 'Partnership', category: 'partnership', requiresEin: true },
  { id: 's_corp', label: 'S corporation', category: 'corporation', requiresEin: true },
  { id: 'c_corp', label: 'C corporation', category: 'corporation', requiresEin: true },
];

// US states + DC keyed by their postal code. Region ids are ISO 3166-2 style
// (`US-CA`) so they line up with tax jurisdictions used downstream.
const US_STATES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia',
  FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
  IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
  ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan',
  MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
  NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota',
  OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota',
  TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia',
  WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};

/** Regions a driver can operate in (defaults to US states + DC). */
export const OPERATING_REGIONS = Object.entries(US_STATES).map(([code, label]) => ({
  id: `US-${code}`,
  label,
  country: 'US',
}));

const IN_PROGRESS = 'in_progress';
const COMPLETED = 'completed';

// Build the tax residency declaration step and adapt its validation errors to
// the wizard's error contract, preserving the specific code (e.g.
// `TAX_ID_INVALID`) so callers still learn exactly why a declaration bounced.
function taxResidencyStep(jurisdictions) {
  const step = createTaxResidencyStep({ jurisdictions });
  return {
    ...step,
    validate(value) {
      try {
        return step.validate(value);
      } catch (err) {
        if (err instanceof TaxResidencyError) {
          throw new WizardError(err.message, err.code);
        }
        throw err;
      }
    },
  };
}

/**
 * Create a driver profile wizard.
 * @param {object} [config]
 * @param {Map} [config.store] Per-user wizard state store (defaults in-memory).
 * @param {Array} [config.entityTypes] Allowed business entity types.
 * @param {Array} [config.regions] Allowed operating regions.
 * @param {Array} [config.jurisdictions] Allowed tax residency jurisdictions.
 * @param {() => number} [config.now] Clock in ms (injectable for tests).
 */
export function createProfileWizard(config = {}) {
  const {
    store = new Map(),
    entityTypes = BUSINESS_ENTITY_TYPES,
    regions = OPERATING_REGIONS,
    jurisdictions = TAX_JURISDICTIONS,
    now = () => Date.now(),
  } = config;

  if (!Array.isArray(entityTypes) || entityTypes.length === 0) {
    throw new WizardError('At least one business entity type is required', 'WIZARD_CONFIG');
  }
  if (!Array.isArray(regions) || regions.length === 0) {
    throw new WizardError('At least one operating region is required', 'WIZARD_CONFIG');
  }
  if (!Array.isArray(jurisdictions) || jurisdictions.length === 0) {
    throw new WizardError('At least one tax jurisdiction is required', 'WIZARD_CONFIG');
  }

  const entityById = new Map(entityTypes.map((e) => [e.id, e]));
  const regionById = new Map(regions.map((r) => [r.id, r]));

  // Match a choice against a catalogue case-insensitively and return the
  // canonical entry, so `us-ca` and `US-CA` both resolve to the same region.
  function resolve(catalogue, value) {
    if (typeof value !== 'string') return null;
    const needle = value.trim().toLowerCase();
    if (!needle) return null;
    return catalogue.find((entry) => entry.id.toLowerCase() === needle) ?? null;
  }

  // The ordered wizard steps. Each validates its raw input and returns the
  // canonical id to store; adding a step here is all it takes to extend the flow.
  const steps = [
    {
      id: 'entity_type',
      title: 'Business entity type',
      prompt: 'What kind of business do you operate as?',
      kind: 'choice',
      options: () => entityTypes.map((e) => ({ id: e.id, label: e.label })),
      validate(value) {
        const match = resolve(entityTypes, value);
        if (!match) {
          throw new WizardError(`Unknown business entity type: ${value}`, 'WIZARD_INVALID_CHOICE');
        }
        return match.id;
      },
    },
    {
      id: 'region',
      title: 'Operating region',
      prompt: 'Which region will you primarily operate in?',
      kind: 'choice',
      options: () => regions.map((r) => ({ id: r.id, label: r.label })),
      validate(value) {
        const match = resolve(regions, value);
        if (!match) {
          throw new WizardError(`Unknown operating region: ${value}`, 'WIZARD_INVALID_CHOICE');
        }
        return match.id;
      },
    },
    taxResidencyStep(jurisdictions),
  ];

  const stepIndexById = new Map(steps.map((s, i) => [s.id, i]));

  function requireState(userId) {
    const state = store.get(userId);
    if (!state) {
      throw new WizardError('No onboarding is in progress for this user', 'WIZARD_NOT_STARTED');
    }
    return state;
  }

  // A serializable snapshot of the wizard: where the driver is, what they've
  // answered, and how much is left. Returned by every navigation method.
  function view(state) {
    const answeredSteps = steps.filter((s) => state.answers[s.id] !== undefined).map((s) => s.id);
    const atEnd = state.stepIndex >= steps.length;
    const current = atEnd ? null : steps[state.stepIndex];
    return {
      userId: state.userId,
      status: state.status,
      totalSteps: steps.length,
      stepNumber: atEnd ? steps.length : state.stepIndex + 1,
      currentStep: current && {
        id: current.id,
        title: current.title,
        prompt: current.prompt,
        kind: current.kind ?? 'choice',
        options: current.options(),
        answer: state.answers[current.id] ?? null,
      },
      answeredSteps,
      answers: { ...state.answers },
      progress: answeredSteps.length / steps.length,
      readyToComplete: answeredSteps.length === steps.length && state.status !== COMPLETED,
      isComplete: state.status === COMPLETED,
      profile: state.profile ?? null,
    };
  }

  /**
   * Start (or restart) the wizard for a user.
   * @param {string} userId
   * @param {object} [opts]
   * @param {boolean} [opts.restart=false] Discard an existing in-progress wizard.
   * @returns {object} Wizard view positioned on the first step.
   */
  function start(userId, { restart = false } = {}) {
    if (!userId) {
      throw new WizardError('A userId is required to start onboarding', 'WIZARD_USER');
    }
    if (store.has(userId) && !restart) {
      throw new WizardError('Onboarding has already been started', 'WIZARD_ALREADY_STARTED');
    }
    const state = {
      userId,
      status: IN_PROGRESS,
      stepIndex: 0,
      answers: {},
      startedAt: now(),
      updatedAt: now(),
      completedAt: null,
      profile: null,
    };
    store.set(userId, state);
    return view(state);
  }

  /** Get the current wizard view for a user. */
  function getState(userId) {
    return view(requireState(userId));
  }

  /**
   * Answer the current step and advance. `stepId` must match the step the
   * driver is currently on, keeping the flow strictly ordered.
   * @returns {object} The updated wizard view.
   */
  function submitStep(userId, stepId, value) {
    const state = requireState(userId);
    if (state.status === COMPLETED) {
      throw new WizardError('Onboarding is already complete', 'WIZARD_COMPLETED');
    }
    const current = steps[state.stepIndex];
    if (!current) {
      throw new WizardError('All steps are already answered', 'WIZARD_NO_STEP');
    }
    if (stepId !== current.id) {
      throw new WizardError(
        `Expected step "${current.id}" but got "${stepId}"`,
        'WIZARD_WRONG_STEP',
      );
    }
    state.answers[current.id] = current.validate(value);
    state.stepIndex += 1;
    state.updatedAt = now();
    return view(state);
  }

  /**
   * Step back to revise the previous step. The earlier answer is preserved so
   * it can be reviewed and re-submitted.
   * @returns {object} The updated wizard view.
   */
  function back(userId) {
    const state = requireState(userId);
    if (state.status === COMPLETED) {
      throw new WizardError('Onboarding is already complete', 'WIZARD_COMPLETED');
    }
    if (state.stepIndex === 0) {
      throw new WizardError('Already at the first step', 'WIZARD_AT_START');
    }
    state.stepIndex -= 1;
    state.updatedAt = now();
    return view(state);
  }

  /**
   * Jump to a specific step by id (must already be reachable / answered) to
   * revise it. Cannot skip ahead past unanswered steps.
   * @returns {object} The updated wizard view.
   */
  function goToStep(userId, stepId) {
    const state = requireState(userId);
    if (state.status === COMPLETED) {
      throw new WizardError('Onboarding is already complete', 'WIZARD_COMPLETED');
    }
    const target = stepIndexById.get(stepId);
    if (target === undefined) {
      throw new WizardError(`Unknown step: ${stepId}`, 'WIZARD_UNKNOWN_STEP');
    }
    if (target > state.stepIndex) {
      throw new WizardError('Cannot skip ahead to an unanswered step', 'WIZARD_WRONG_STEP');
    }
    state.stepIndex = target;
    state.updatedAt = now();
    return view(state);
  }

  /**
   * Finalize the wizard into an immutable driver profile. Every step must be
   * answered first.
   * @returns {object} The completed driver profile.
   */
  function complete(userId) {
    const state = requireState(userId);
    if (state.status === COMPLETED) {
      throw new WizardError('Onboarding is already complete', 'WIZARD_ALREADY_COMPLETED');
    }
    const missing = steps.find((s) => state.answers[s.id] === undefined);
    if (missing) {
      throw new WizardError(`Step "${missing.id}" has not been answered`, 'WIZARD_INCOMPLETE');
    }

    const entity = entityById.get(state.answers.entity_type);
    const region = regionById.get(state.answers.region);
    const taxResidency = state.answers.tax_residency;
    const profile = {
      userId: state.userId,
      entityType: {
        id: entity.id,
        label: entity.label,
        category: entity.category,
      },
      region: {
        id: region.id,
        label: region.label,
        country: region.country,
      },
      taxResidency,
      requiresEin: entity.requiresEin,
      completedAt: now(),
    };

    state.status = COMPLETED;
    state.completedAt = profile.completedAt;
    state.profile = profile;
    state.updatedAt = profile.completedAt;
    return profile;
  }

  /** The ordered step definitions (for rendering a progress bar, etc.). */
  function getSteps() {
    return steps.map((s) => ({
      id: s.id,
      title: s.title,
      prompt: s.prompt,
      kind: s.kind ?? 'choice',
      options: s.options(),
    }));
  }

  return {
    start,
    getState,
    getSteps,
    submitStep,
    back,
    goToStep,
    complete,
    store,
  };
}
