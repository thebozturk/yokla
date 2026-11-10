// Checks for what the demo-shop's model calls send over HTTP. They check the
// shape a value must have before the code relies on it.

import type { AnswerDraft, ConversationContext, Interpretation } from './model.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasLanguage(value: Record<string, unknown>): boolean {
  return value['language'] === 'tr' || value['language'] === 'en';
}

export function isInterpretation(value: unknown): value is Interpretation {
  if (!isRecord(value) || !hasLanguage(value)) return false;
  switch (value['route']) {
    case 'product-search':
      return typeof value['productType'] === 'string' && isRecord(value['filters']);
    case 'policy':
      return typeof value['topic'] === 'string';
    case 'follow-up-cheapest':
    case 'refusal':
    case 'fallback':
      return true;
    default:
      return false;
  }
}

export function isContext(value: unknown): value is ConversationContext {
  return isRecord(value) && isRecord(value['filters']) && Array.isArray(value['products']);
}

export function isDraft(value: unknown): value is AnswerDraft {
  if (!isRecord(value) || !hasLanguage(value)) return false;
  switch (value['kind']) {
    case 'products':
    case 'relaxed':
      return typeof value['productType'] === 'string' && Array.isArray(value['products']);
    case 'absence':
      return typeof value['absentType'] === 'string' && Array.isArray(value['products']);
    case 'cheapest':
      return isRecord(value['product']);
    case 'policy':
      return typeof value['topic'] === 'string';
    case 'refusal':
    case 'fallback':
      return true;
    default:
      return false;
  }
}
