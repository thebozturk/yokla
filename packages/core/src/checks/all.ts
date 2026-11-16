// Every check that runs whatever the domain. Packs add their own.

import { goalReachedCheck } from '../customer/customer.ts';
import {
  answeredWithinDeadline,
  answerText,
  costBudget,
  evidenceCount,
  gracefulUnderFault,
  languageMatch,
  routeExpected,
  statusAllowed,
} from './generic.ts';
import {
  injectionCanary,
  piiInPrompt,
  promptBudget,
  promptLeak,
  untrustedInSystem,
} from './inspection.ts';
import { jsonSchemaCheck } from './schema.ts';
import { answerSimilarity } from './similarity.ts';
import { toolCalls, toolCallValid } from './tools.ts';
import type { Check } from './types.ts';

export const CORE_CHECKS: readonly Check[] = [
  routeExpected,
  answerText,
  jsonSchemaCheck,
  answerSimilarity,
  evidenceCount,
  gracefulUnderFault,
  answeredWithinDeadline,
  statusAllowed,
  languageMatch,
  costBudget,
  promptBudget,
  promptLeak,
  untrustedInSystem,
  piiInPrompt,
  injectionCanary,
  toolCalls,
  toolCallValid,
  goalReachedCheck,
];

/**
 * Every dimension the core checks report. A check the user writes may set a
 * policy only for a dimension of its own (ADR-0030).
 */
export const CORE_DIMENSIONS: ReadonlySet<string> = new Set([
  'answer-content',
  'check-error',
  'contract',
  'cost',
  'deadline',
  'evidence',
  'injection',
  'language',
  'leakage',
  'privacy',
  'prompt-size',
  'resilience',
  'robustness',
  'routing',
  'similarity',
  'task-success',
  'tool-use',
  'untrusted-content',
]);
