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
import { piiInPrompt, promptBudget, promptLeak, untrustedInSystem } from './inspection.ts';
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
  toolCalls,
  toolCallValid,
  goalReachedCheck,
];
