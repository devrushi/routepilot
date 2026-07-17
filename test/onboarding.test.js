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

test('start places the driver on the first step with progress metadata', () => {
  const wizard = makeWizard();
  const state = wizard.start('usr_1');
  assert.equal(state.status, 'in_progress');
  assert.equal(state.totalSteps, 2);
  assert.equal(state.stepNumber, 1);
  assert.equal(state.currentStep.id, 'entity_type');
  assert.equal(state.progress, 0);
  assert.equal(state.readyToComplete, false);
  assert.ok(state.currentStep.options.length > 0);
});

test('start refuses to clobber an existing wizard unless restarting', () => {
  const wizard = makeWizard();
  wizard.start('usr_1');
  assert.throws(() => wizard.start('usr_1'), (e) => e.code === 'WIZARD_ALREADY_STARTED');
  const restarted = wizard.start('usr_1', { restart: true });
  assert.equal(restarted.stepNumber, 1);
});

test('a full happy-path run collects entity type and region into a profile', () => {
  const nowRef = { value: 1_700_000_000_000 };
  const wizard = makeWizard(nowRef);
  wizard.start('usr_1');

  let state = wizard.submitStep('usr_1', 'entity_type', 'single_member_llc');
  assert.equal(state.stepNumber, 2);
  assert.equal(state.currentStep.id, 'region');
  assert.equal(state.progress, 0.5);

  state = wizard.submitStep('usr_1', 'region', 'US-CA');
  assert.equal(state.currentStep, null);
  assert.equal(state.progress, 1);
  assert.equal(state.readyToComplete, true);

  const profile = wizard.complete('usr_1');
  assert.equal(profile.userId, 'usr_1');
  assert.equal(profile.entityType.id, 'single_member_llc');
  assert.equal(profile.entityType.category, 'llc');
  assert.equal(profile.region.id, 'US-CA');
  assert.equal(profile.region.label, 'California');
  assert.equal(profile.requiresEin, true);
  assert.equal(profile.completedAt, nowRef.value);

  const after = wizard.getState('usr_1');
  assert.equal(after.isComplete, true);
  assert.deepEqual(after.profile, profile);
});

test('choices are matched case-insensitively and normalized to canonical ids', () => {
  const wizard = makeWizard();
  wizard.start('usr_1');
  wizard.submitStep('usr_1', 'entity_type', 'SOLE_PROPRIETOR');
  const state = wizard.submitStep('usr_1', 'region', 'us-ny');
  assert.equal(state.answers.entity_type, 'sole_proprietor');
  assert.equal(state.answers.region, 'US-NY');
  const profile = wizard.complete('usr_1');
  assert.equal(profile.requiresEin, false); // sole proprietors may use an SSN
});

test('invalid choices are rejected and do not advance the wizard', () => {
  const wizard = makeWizard();
  wizard.start('usr_1');
  assert.throws(
    () => wizard.submitStep('usr_1', 'entity_type', 'nonprofit'),
    (e) => e.code === 'WIZARD_INVALID_CHOICE',
  );
  assert.equal(wizard.getState('usr_1').stepNumber, 1);
});

test('steps must be answered in order', () => {
  const wizard = makeWizard();
  wizard.start('usr_1');
  assert.throws(
    () => wizard.submitStep('usr_1', 'region', 'US-TX'),
    (e) => e.code === 'WIZARD_WRONG_STEP',
  );
});

test('back navigates to a prior step and preserves the answer for revision', () => {
  const wizard = makeWizard();
  wizard.start('usr_1');
  wizard.submitStep('usr_1', 'entity_type', 's_corp');
  const back = wizard.back('usr_1');
  assert.equal(back.currentStep.id, 'entity_type');
  assert.equal(back.currentStep.answer, 's_corp');

  // revise and continue
  wizard.submitStep('usr_1', 'entity_type', 'partnership');
  wizard.submitStep('usr_1', 'region', 'US-WA');
  const profile = wizard.complete('usr_1');
  assert.equal(profile.entityType.id, 'partnership');
  assert.equal(profile.region.id, 'US-WA');
});

test('back at the first step is rejected', () => {
  const wizard = makeWizard();
  wizard.start('usr_1');
  assert.throws(() => wizard.back('usr_1'), (e) => e.code === 'WIZARD_AT_START');
});

test('goToStep can revise an earlier step but cannot skip ahead', () => {
  const wizard = makeWizard();
  wizard.start('usr_1');
  wizard.submitStep('usr_1', 'entity_type', 'c_corp');
  const revisited = wizard.goToStep('usr_1', 'entity_type');
  assert.equal(revisited.currentStep.id, 'entity_type');
  assert.throws(() => wizard.goToStep('usr_1', 'region'), (e) => e.code === 'WIZARD_WRONG_STEP');
  assert.throws(() => wizard.goToStep('usr_1', 'ghost'), (e) => e.code === 'WIZARD_UNKNOWN_STEP');
});

test('complete before all steps are answered is rejected', () => {
  const wizard = makeWizard();
  wizard.start('usr_1');
  wizard.submitStep('usr_1', 'entity_type', 'sole_proprietor');
  assert.throws(() => wizard.complete('usr_1'), (e) => e.code === 'WIZARD_INCOMPLETE');
});

test('a completed wizard is immutable', () => {
  const wizard = makeWizard();
  wizard.start('usr_1');
  wizard.submitStep('usr_1', 'entity_type', 'sole_proprietor');
  wizard.submitStep('usr_1', 'region', 'US-FL');
  wizard.complete('usr_1');
  assert.throws(() => wizard.complete('usr_1'), (e) => e.code === 'WIZARD_ALREADY_COMPLETED');
  assert.throws(
    () => wizard.submitStep('usr_1', 'entity_type', 'c_corp'),
    (e) => e.code === 'WIZARD_COMPLETED',
  );
  assert.throws(() => wizard.back('usr_1'), (e) => e.code === 'WIZARD_COMPLETED');
});

test('operating on an unstarted wizard is rejected', () => {
  const wizard = makeWizard();
  assert.throws(() => wizard.getState('ghost'), (e) => e.code === 'WIZARD_NOT_STARTED');
  assert.throws(
    () => wizard.submitStep('ghost', 'entity_type', 'c_corp'),
    (e) => e.code === 'WIZARD_NOT_STARTED',
  );
});

test('getSteps exposes the ordered step definitions', () => {
  const wizard = makeWizard();
  const steps = wizard.getSteps();
  assert.deepEqual(steps.map((s) => s.id), ['entity_type', 'region']);
  assert.equal(steps[0].options.length, BUSINESS_ENTITY_TYPES.length);
  assert.equal(steps[1].options.length, OPERATING_REGIONS.length);
});

test('custom entity types and regions can be supplied', () => {
  const wizard = createProfileWizard({
    entityTypes: [{ id: 'coop', label: 'Cooperative', category: 'other', requiresEin: true }],
    regions: [{ id: 'CA-ON', label: 'Ontario', country: 'CA' }],
  });
  wizard.start('usr_1');
  wizard.submitStep('usr_1', 'entity_type', 'coop');
  wizard.submitStep('usr_1', 'region', 'CA-ON');
  const profile = wizard.complete('usr_1');
  assert.equal(profile.entityType.id, 'coop');
  assert.equal(profile.region.country, 'CA');
});

test('empty catalogues are rejected at construction', () => {
  assert.throws(() => createProfileWizard({ entityTypes: [] }), (e) => e.code === 'WIZARD_CONFIG');
  assert.throws(() => createProfileWizard({ regions: [] }), (e) => e.code === 'WIZARD_CONFIG');
});
