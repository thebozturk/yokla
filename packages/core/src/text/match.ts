// Normalisation for finding one text inside another, such as retrieved
// content or seeded values inside a prompt (ADR-0015). Prompts often embed
// content as JSON, so JSON string escapes are decoded first.

const ESCAPE = /\\(u[0-9a-fA-F]{4}|["\\/bfnrt])/gu;
/** Escapes that stand for a control character; any other escaped character stands for itself. */
const CONTROL: Readonly<Record<string, string>> = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

/** The text with JSON string escapes, unicode ones included, decoded; one pass, so an escaped backslash stays one. */
export function decodeJsonEscapes(text: string): string {
  return text.replace(ESCAPE, (_match, code: string) =>
    code.startsWith('u')
      ? String.fromCharCode(Number.parseInt(code.slice(1), 16))
      : (CONTROL[code] ?? code),
  );
}

/** The text with runs of whitespace made one space, trimmed. */
export function collapse(text: string): string {
  return text.replaceAll(/\s+/gu, ' ').trim();
}

/** The text without whitespace, dots, dashes and parentheses, so 0532 111-22-33 is 05321112233. */
export function squeeze(text: string): string {
  return text.replaceAll(/[\s.\-()]/gu, '');
}
