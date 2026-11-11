import type { CheckContext } from './types.ts';

/** The text folded by the case's language pack, or lower-cased without one. */
export function fold(context: CheckContext, text: string): string {
  return context.lang === undefined ? text.toLowerCase() : context.lang.fold(text);
}
