// What of a call's prompt is written to files (ADR-0015). The profile's
// `prompts.store` decides:
// - sizes: each message's role and length;
// - hashed: plus the SHA-256 of its text;
// - redacted: plus its text with the profile's patterns replaced, and no hash,
//   since next to the rest of the text a hash would let the removed values be
//   guessed back;
// - full: plus the hash and the text.
// Core is pure, so the caller supplies the hash function.

import type { ModelProxyConfig } from '../schema/profile.ts';
import type { ModelOutput, PromptMessage, ToolCall } from '../schema/proxy.ts';

export type PromptStorage = ModelProxyConfig['prompts'];

export const REDACTED = '[redacted]';

/** The text with every match of the patterns (Unicode mode) replaced, in order. */
export function redact(text: string, patterns: readonly string[]): string {
  let out = text;
  for (const source of patterns) out = out.replace(new RegExp(source, 'gu'), REDACTED);
  return out;
}

/** A prompt as `storage` keeps it; a message the proxy gave without text keeps its size only. */
export function storePrompt(
  prompt: readonly PromptMessage[] | null,
  storage: PromptStorage,
  sha256: (text: string) => string,
): PromptMessage[] | null {
  if (prompt === null) return null;
  return prompt.map(({ role, chars, text, tool }) => {
    // The tool a result answers is a name, not content: always kept (ADR-0026).
    const sized = { role, chars, ...(tool === undefined ? {} : { tool }) };
    if (text === undefined) return sized;
    switch (storage.store) {
      case 'sizes':
        return sized;
      case 'hashed':
        return { ...sized, sha256: sha256(text) };
      case 'redacted':
        return { ...sized, text: redact(text, storage.redact ?? []) };
      case 'full':
        return { ...sized, sha256: sha256(text), text };
    }
  });
}

/** Tool calls as `storage` keeps their arguments, as it keeps prompt text (ADR-0025). */
export function storeToolCalls(
  calls: readonly ToolCall[] | null,
  storage: PromptStorage,
  sha256: (text: string) => string,
): ToolCall[] | null {
  if (calls === null) return null;
  return calls.map(({ name, chars, arguments: text }) => {
    const sized = { name, chars };
    if (text === undefined) return sized;
    switch (storage.store) {
      case 'sizes':
        return sized;
      case 'hashed':
        return { ...sized, sha256: sha256(text) };
      case 'redacted':
        return { ...sized, arguments: redact(text, storage.redact ?? []) };
      case 'full':
        return { ...sized, sha256: sha256(text), arguments: text };
    }
  });
}

/** A model's answer text as `storage` keeps it, as it keeps prompt text (ADR-0033). */
export function storeOutput(
  output: ModelOutput | null,
  storage: PromptStorage,
  sha256: (text: string) => string,
): ModelOutput | null {
  if (output === null) return null;
  const { chars, text } = output;
  const sized = { chars };
  if (text === undefined) return sized;
  switch (storage.store) {
    case 'sizes':
      return sized;
    case 'hashed':
      return { ...sized, sha256: sha256(text) };
    case 'redacted':
      return { ...sized, text: redact(text, storage.redact ?? []) };
    case 'full':
      return { ...sized, sha256: sha256(text), text };
  }
}
