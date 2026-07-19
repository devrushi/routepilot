// LLM agent loop answering a driver's natural-language tax write-off
// questions ("can I deduct my phone bill?"), grounded in their own
// categorized expenses and tax jurisdiction.
//
// This is deliberately a thin loop, not a tax authority: context assembly
// (`assembleContext`) reuses expenses.js's categorized expense records and
// resolveAuthority rather than re-deriving jurisdiction/bucket logic, and the
// LLM call is stubbed behind the same kind of swappable provider interface
// as the embeddings ticket — a real model plugs in later without touching
// the context-assembly or response-handling logic here.

import { resolveAuthority } from './expenses.js';

export class TaxAssistantError extends Error {
  constructor(message, code = 'ASSISTANT_INVALID') {
    super(message);
    this.name = 'TaxAssistantError';
    this.code = code;
  }
}

const DEFAULT_SYSTEM_PROMPT =
  'You are a tax assistant for gig/delivery drivers. Answer questions about ' +
  "which of the driver's expenses may be deductible, using only the " +
  'categorized expenses and jurisdiction provided in context. Be concise, ' +
  "and note that this is guidance, not a substitute for a filed return's " +
  'professional review.';

/**
 * LLM provider interface: `{ complete(messages): Promise<string> }`, where
 * `messages` is the common chat-completion shape
 * (`[{ role: 'system'|'user'|'assistant', content: string }, ...]`). Resolves
 * to the assistant's reply text.
 */
export function createMockLlmProvider(config = {}) {
  const { reply = 'This is a stubbed response. Wire in a real LLM provider to get a real answer.' } = config;
  return {
    async complete(messages) {
      return typeof reply === 'function' ? reply(messages) : reply;
    },
  };
}

/**
 * Assemble the context an LLM needs to answer a write-off question: the
 * resolved tax authority and a compact view of the driver's categorized
 * expenses (see expenses.js), plus per-category totals.
 * @param {object} [input]
 * @param {object[]} [input.expenses] Categorized expense records (from `createExpenseTracker().list()`).
 * @param {object|string} [input.jurisdiction] Overrides the authority inferred from `expenses` (see {@link resolveAuthority}).
 * @returns {{authority: string|null, expenses: object[], totalsByCategory: Record<string, number>}}
 */
export function assembleContext(input = {}) {
  const { expenses = [], jurisdiction } = input;
  if (!Array.isArray(expenses)) {
    throw new TaxAssistantError('expenses must be an array of categorized expense records', 'ASSISTANT_EXPENSES');
  }
  const authority = jurisdiction !== undefined
    ? resolveAuthority(jurisdiction)
    : (expenses[0]?.authority ?? null);

  const summarized = expenses.map((e) => ({
    category: e.categoryLabel ?? e.category,
    bucket: e.bucket ?? null,
    amount: e.amount,
    currency: e.currency,
  }));

  const totalsByCategory = summarized.reduce((totals, e) => {
    totals[e.category] = (totals[e.category] ?? 0) + (e.amount ?? 0);
    return totals;
  }, {});

  return { authority, expenses: summarized, totalsByCategory };
}

function buildUserMessage(question, context) {
  const lines = [
    `Jurisdiction/tax authority: ${context.authority ?? 'unknown'}`,
    context.expenses.length > 0 ? 'Categorized expenses on file:' : 'No categorized expenses on file yet.',
    ...context.expenses.map((e) => `- ${e.category} (${e.bucket ?? 'uncategorized bucket'}): ${e.amount} ${e.currency}`),
    '',
    `Driver's question: ${question}`,
  ];
  return lines.join('\n');
}

/**
 * Create the tax write-off Q&A assistant.
 * @param {object} [config]
 * @param {{complete:(messages:object[])=>Promise<string>}} [config.llmProvider]
 * @param {ReturnType<import('./expenses.js').createExpenseTracker>} [config.expenseTracker]
 *   Used to auto-fetch a driver's categorized expenses when `answerQuestion` isn't given an explicit `expenses` array.
 * @param {string} [config.systemPrompt]
 */
export function createTaxAssistant(config = {}) {
  const {
    llmProvider = createMockLlmProvider(),
    expenseTracker = null,
    systemPrompt = DEFAULT_SYSTEM_PROMPT,
  } = config;

  /**
   * Answer a driver's natural-language tax write-off question.
   * @param {object} input
   * @param {string} input.driverId
   * @param {string} input.question
   * @param {object|string} [input.jurisdiction] Forwarded to {@link assembleContext}.
   * @param {object[]} [input.expenses] Explicit categorized expenses; otherwise pulled from `expenseTracker` by `driverId`.
   * @returns {Promise<{question:string, context:object, messages:object[], answer:string}>}
   */
  async function answerQuestion(input = {}) {
    const { driverId, question, jurisdiction } = input;
    if (typeof question !== 'string' || !question.trim()) {
      throw new TaxAssistantError('A question is required', 'ASSISTANT_QUESTION');
    }
    const expenses = input.expenses ?? (expenseTracker && driverId ? await expenseTracker.list(driverId) : []);
    const context = assembleContext({ expenses, jurisdiction });
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: buildUserMessage(question, context) },
    ];
    const answer = await llmProvider.complete(messages);
    return { question, context, messages, answer };
  }

  return { answerQuestion };
}
