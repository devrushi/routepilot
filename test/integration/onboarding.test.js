// Run against a real database: set TEST_DATABASE_URL, apply migrations
// with `npm run migrate -- --test`, then `npm run test:integration`.

import assert from 'node:assert/strict';
import { createProfileWizard, createPostgresOnboardingRepo } from '../../src/onboarding.js';
import { integrationTest, resetTables } from './_helpers.js';

const TABLES = ['onboarding_wizard_state'];
const US_DECLARATION = { jurisdiction: 'US', taxIdType: 'ssn', taxId: '123-45-6789', confirmed: true };

integrationTest('a full wizard run persists through Postgres', async (t, sql) => {
  await resetTables(sql, TABLES);
  const nowRef = { value: 1_700_000_000_000 };
  const wizard = createProfileWizard({ now: () => nowRef.value, repo: createPostgresOnboardingRepo(sql) });

  await wizard.start('usr_1');
  await wizard.submitStep('usr_1', 'entity_type', 'single_member_llc');
  await wizard.submitStep('usr_1', 'region', 'US-CA');
  await wizard.submitStep('usr_1', 'tax_residency', US_DECLARATION);
  const profile = await wizard.complete('usr_1');

  assert.equal(profile.entityType.id, 'single_member_llc');
  assert.equal(profile.region.id, 'US-CA');

  const state = await wizard.getState('usr_1');
  assert.equal(state.isComplete, true);
  assert.deepEqual(state.profile, profile);
});
