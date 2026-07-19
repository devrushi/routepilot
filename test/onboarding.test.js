import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createProfileWizard,
  BUSINESS_ENTITY_TYPES,
  OPERATING_REGIONS,
} from '../src/onboarding.js';

function makeWizard(nowRef = { value: 1_700_000_000_000 }) {
  return createProfileWizard({ now: () => nowRef.value });
}

// A valid tax residency declaration for the default US jurisdiction, used to
// answer the final step wherever a test only cares about reaching completion.
const US_DECLARATION = { jurisdiction: 'US', taxIdType: 'ssn', taxId: '123-45-6789', confirmed: true };

test('start places the driver on the first step with progress metadata', async () => {
  const wizard = makeWizard();
  const state = await wizard.start('usr_1');
  assert.equal(state.status, 'in_progress');
  assert.equal(state.totalSteps, 3);
  assert.equal(state.stepNumber, 1);
  assert.equal(state.currentStep.id, 'entity_type');
  assert.equal(state.progress, 0);
  assert.equal(state.readyToComplete, false);
  assert.ok(state.currentStep.options.length > 0);
});

test('start refuses to clobber an existing wizard unless restarting', async () => {
  const wizard = makeWizard();
  await wizard.start('usr_1');
  await assert.rejects(() => wizard.start('usr_1'), (e) => e.code === 'WIZARD_ALREADY_STARTED');
  const restarted = await wizard.start('usr_1', { restart: true });
  assert.equal(restarted.stepNumber, 1);
});

test('a full happy-path run collects entity type and region into a profile', async () => {
  const nowRef = { value: 1_700_000_000_000 };
  const wizard = makeWizard(nowRef);
  await wizard.start('usr_1');

  let state = await wizard.submitStep('usr_1', 'entity_type', 'single_member_llc');
  assert.equal(state.stepNumber, 2);
  assert.equal(state.currentStep.id, 'region');
  assert.equal(state.progress, 1 / 3);

  state = await wizard.submitStep('usr_1', 'region', 'US-CA');
  assert.equal(state.stepNumber, 3);
  assert.equal(state.currentStep.id, 'tax_residency');
  assert.equal(state.progress, 2 / 3);
  assert.equal(state.readyToComplete, false);

  state = await wizard.submitStep('usr_1', 'tax_residency', US_DECLARATION);
  assert.equal(state.currentStep, null);
  assert.equal(state.progress, 1);
  assert.equal(state.readyToComplete, true);

  const profile = await wizard.complete('usr_1');
  assert.equal(profile.userId, 'usr_1');
  assert.equal(profile.entityType.id, 'single_member_llc');
  assert.equal(profile.entityType.category, 'llc');
  assert.equal(profile.region.id, 'US-CA');
  assert.equal(profile.region.label, 'California');
  assert.equal(profile.taxResidency.jurisdiction.authority, 'IRS');
  assert.equal(profile.taxResidency.taxIdType, 'ssn');
  assert.equal(profile.taxResidency.taxId, '123456789');
  assert.equal(profile.requiresEin, true);
  assert.equal(profile.completedAt, nowRef.value);

  const after = await wizard.getState('usr_1');
  assert.equal(after.isComplete, true);
  assert.deepEqual(after.profile, profile);
});

test('choices are matched case-insensitively and normalized to canonical ids', async () => {
  const wizard = makeWizard();
  await wizard.start('usr_1');
  await wizard.submitStep('usr_1', 'entity_type', 'SOLE_PROPRIETOR');
  const state = await wizard.submitStep('usr_1', 'region', 'us-ny');
  assert.equal(state.answers.entity_type, 'sole_proprietor');
  assert.equal(state.answers.region, 'US-NY');
  await wizard.submitStep('usr_1', 'tax_residency', US_DECLARATION);
  const profile = await wizard.complete('usr_1');
  assert.equal(profile.requiresEin, false); // sole proprietors may use an SSN
});

test('invalid choices are rejected and do not advance the wizard', async () => {
  const wizard = makeWizard();
  await wizard.start('usr_1');
  await assert.rejects(
    () => wizard.submitStep('usr_1', 'entity_type', 'nonprofit'),
    (e) => e.code === 'WIZARD_INVALID_CHOICE',
  );
  assert.equal((await wizard.getState('usr_1')).stepNumber, 1);
});

test('steps must be answered in order', async () => {
  const wizard = makeWizard();
  await wizard.start('usr_1');
  await assert.rejects(
    () => wizard.submitStep('usr_1', 'region', 'US-TX'),
    (e) => e.code === 'WIZARD_WRONG_STEP',
  );
});

test('back navigates to a prior step and preserves the answer for revision', async () => {
  const wizard = makeWizard();
  await wizard.start('usr_1');
  await wizard.submitStep('usr_1', 'entity_type', 's_corp');
  const back = await wizard.back('usr_1');
  assert.equal(back.currentStep.id, 'entity_type');
  assert.equal(back.currentStep.answer, 's_corp');

  // revise and continue
  await wizard.submitStep('usr_1', 'entity_type', 'partnership');
  await wizard.submitStep('usr_1', 'region', 'US-WA');
  await wizard.submitStep('usr_1', 'tax_residency', US_DECLARATION);
  const profile = await wizard.complete('usr_1');
  assert.equal(profile.entityType.id, 'partnership');
  assert.equal(profile.region.id, 'US-WA');
});

test('back at the first step is rejected', async () => {
  const wizard = makeWizard();
  await wizard.start('usr_1');
  await assert.rejects(() => wizard.back('usr_1'), (e) => e.code === 'WIZARD_AT_START');
});

test('goToStep can revise an earlier step but cannot skip ahead', async () => {
  const wizard = makeWizard();
  await wizard.start('usr_1');
  await wizard.submitStep('usr_1', 'entity_type', 'c_corp');
  const revisited = await wizard.goToStep('usr_1', 'entity_type');
  assert.equal(revisited.currentStep.id, 'entity_type');
  await assert.rejects(() => wizard.goToStep('usr_1', 'region'), (e) => e.code === 'WIZARD_WRONG_STEP');
  await assert.rejects(() => wizard.goToStep('usr_1', 'ghost'), (e) => e.code === 'WIZARD_UNKNOWN_STEP');
});

test('complete before all steps are answered is rejected', async () => {
  const wizard = makeWizard();
  await wizard.start('usr_1');
  await wizard.submitStep('usr_1', 'entity_type', 'sole_proprietor');
  await assert.rejects(() => wizard.complete('usr_1'), (e) => e.code === 'WIZARD_INCOMPLETE');
});

test('a completed wizard is immutable', async () => {
  const wizard = makeWizard();
  await wizard.start('usr_1');
  await wizard.submitStep('usr_1', 'entity_type', 'sole_proprietor');
  await wizard.submitStep('usr_1', 'region', 'US-FL');
  await wizard.submitStep('usr_1', 'tax_residency', US_DECLARATION);
  await wizard.complete('usr_1');
  await assert.rejects(() => wizard.complete('usr_1'), (e) => e.code === 'WIZARD_ALREADY_COMPLETED');
  await assert.rejects(
    () => wizard.submitStep('usr_1', 'entity_type', 'c_corp'),
    (e) => e.code === 'WIZARD_COMPLETED',
  );
  await assert.rejects(() => wizard.back('usr_1'), (e) => e.code === 'WIZARD_COMPLETED');
});

test('operating on an unstarted wizard is rejected', async () => {
  const wizard = makeWizard();
  await assert.rejects(() => wizard.getState('ghost'), (e) => e.code === 'WIZARD_NOT_STARTED');
  await assert.rejects(
    () => wizard.submitStep('ghost', 'entity_type', 'c_corp'),
    (e) => e.code === 'WIZARD_NOT_STARTED',
  );
});

test('getSteps exposes the ordered step definitions', () => {
  const wizard = makeWizard();
  const steps = wizard.getSteps();
  assert.deepEqual(steps.map((s) => s.id), ['entity_type', 'region', 'tax_residency']);
  assert.equal(steps[0].options.length, BUSINESS_ENTITY_TYPES.length);
  assert.equal(steps[1].options.length, OPERATING_REGIONS.length);
  assert.equal(steps[2].kind, 'declaration');
});

test('custom entity types and regions can be supplied', async () => {
  const wizard = createProfileWizard({
    entityTypes: [{ id: 'coop', label: 'Cooperative', category: 'other', requiresEin: true }],
    regions: [{ id: 'CA-ON', label: 'Ontario', country: 'CA' }],
  });
  await wizard.start('usr_1');
  await wizard.submitStep('usr_1', 'entity_type', 'coop');
  await wizard.submitStep('usr_1', 'region', 'CA-ON');
  await wizard.submitStep('usr_1', 'tax_residency', US_DECLARATION);
  const profile = await wizard.complete('usr_1');
  assert.equal(profile.entityType.id, 'coop');
  assert.equal(profile.region.country, 'CA');
});

test('empty catalogues are rejected at construction', () => {
  assert.throws(() => createProfileWizard({ entityTypes: [] }), (e) => e.code === 'WIZARD_CONFIG');
  assert.throws(() => createProfileWizard({ regions: [] }), (e) => e.code === 'WIZARD_CONFIG');
  assert.throws(() => createProfileWizard({ jurisdictions: [] }), (e) => e.code === 'WIZARD_CONFIG');
});

test('the tax residency step exposes jurisdictions and their tax id types', async () => {
  const wizard = makeWizard();
  await wizard.start('usr_1');
  await wizard.submitStep('usr_1', 'entity_type', 'sole_proprietor');
  const state = await wizard.submitStep('usr_1', 'region', 'US-CA');
  assert.equal(state.currentStep.id, 'tax_residency');
  assert.equal(state.currentStep.kind, 'declaration');
  const us = state.currentStep.options.find((o) => o.id === 'US');
  assert.equal(us.authority, 'IRS');
  assert.deepEqual(us.taxIdTypes.map((t) => t.id), ['ssn', 'itin', 'ein']);
});

test('the tax residency step validates the declaration immediately on submit', async () => {
  const wizard = makeWizard();
  await wizard.start('usr_1');
  await wizard.submitStep('usr_1', 'entity_type', 'sole_proprietor');
  await wizard.submitStep('usr_1', 'region', 'US-CA');

  // A malformed SSN is rejected and the wizard does not advance.
  await assert.rejects(
    () => wizard.submitStep('usr_1', 'tax_residency', { jurisdiction: 'US', taxId: '000-12-3456', confirmed: true }),
    (e) => e.code === 'TAX_ID_INVALID',
  );
  assert.equal((await wizard.getState('usr_1')).currentStep.id, 'tax_residency');

  // Failing to affirm the declaration is rejected too.
  await assert.rejects(
    () => wizard.submitStep('usr_1', 'tax_residency', { jurisdiction: 'US', taxId: '123-45-6789', confirmed: false }),
    (e) => e.code === 'TAX_NOT_CONFIRMED',
  );
});

test('a HMRC declaration flows through to the completed profile', async () => {
  const wizard = makeWizard();
  await wizard.start('usr_1');
  await wizard.submitStep('usr_1', 'entity_type', 'sole_proprietor');
  await wizard.submitStep('usr_1', 'region', 'US-CA');
  await wizard.submitStep('usr_1', 'tax_residency', { jurisdiction: 'UK', taxId: 'AB 12 34 56 C', confirmed: true });
  const profile = await wizard.complete('usr_1');
  assert.equal(profile.taxResidency.jurisdiction.id, 'GB');
  assert.equal(profile.taxResidency.jurisdiction.authority, 'HMRC');
  assert.equal(profile.taxResidency.taxIdType, 'nino');
  assert.equal(profile.taxResidency.taxId, 'AB123456C');
});
