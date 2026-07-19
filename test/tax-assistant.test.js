import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTaxAssistant, createMockLlmProvider, assembleContext } from '../src/tax-assistant.js';
import { createExpenseTracker } from '../src/expenses.js';

test('assembleContext resolves the authority and summarizes categorized expenses', async () => {
  const tracker = createExpenseTracker({ now: () => 1_700_000_000_000 });
  const phone = await tracker.categorize('drv_1', { category: 'phone_data', amount: 40, currency: 'USD', jurisdiction: 'US' });
  const fuel = await tracker.categorize('drv_1', { category: 'fuel', amount: 60, currency: 'USD', jurisdiction: 'US' });

  const context = assembleContext({ expenses: [phone, fuel] });
  assert.equal(context.authority, 'IRS');
  assert.equal(context.expenses.length, 2);
  assert.equal(context.expenses[0].bucket, phone.bucket);
  assert.equal(context.totalsByCategory['Phone & data plan'], 40);
  assert.equal(context.totalsByCategory['Fuel'], 60);
});

test('assembleContext falls back to an explicit jurisdiction when there are no expenses yet', () => {
  const context = assembleContext({ expenses: [], jurisdiction: 'GB' });
  assert.equal(context.authority, 'HMRC');
  assert.deepEqual(context.expenses, []);
});

test('answerQuestion assembles context and returns a mocked LLM response', async () => {
  const tracker = createExpenseTracker({ now: () => 1_700_000_000_000 });
  const phone = await tracker.categorize('drv_1', { category: 'phone_data', amount: 40, currency: 'USD', jurisdiction: 'US' });

  const llmProvider = createMockLlmProvider({ reply: 'Yes — the business-use portion of your phone bill is deductible.' });
  const assistant = createTaxAssistant({ llmProvider, expenseTracker: tracker });

  const result = await assistant.answerQuestion({
    driverId: 'drv_1',
    question: 'Can I deduct my phone bill?',
  });

  assert.equal(result.answer, 'Yes — the business-use portion of your phone bill is deductible.');
  assert.equal(result.context.authority, 'IRS');
  assert.equal(result.context.expenses.length, 1);
  assert.equal(result.messages[0].role, 'system');
  assert.match(result.messages[1].content, /Can I deduct my phone bill\?/);
  assert.match(result.messages[1].content, /Phone & data plan/);
  assert.deepEqual((await tracker.list('drv_1')).map((e) => e.id), [phone.id]);
});

test('answerQuestion uses the reply function form for dynamic mocked responses', async () => {
  const llmProvider = createMockLlmProvider({
    reply: (messages) => `Echo: ${messages[messages.length - 1].content.split('\n').pop()}`,
  });
  const assistant = createTaxAssistant({ llmProvider });
  const result = await assistant.answerQuestion({ question: 'Is parking deductible?', expenses: [] });
  assert.match(result.answer, /^Echo: Driver's question: Is parking deductible\?$/);
});

test('answerQuestion rejects a missing question', async () => {
  const assistant = createTaxAssistant();
  await assert.rejects(() => assistant.answerQuestion({ expenses: [] }), (e) => e.code === 'ASSISTANT_QUESTION');
});
