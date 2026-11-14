// Evidence from the tool results the model saw (ADR-0026). The model proxy
// captures each call's messages, and names the tool each result answers. The
// profile maps, per tool, evidence collections in its results, as it maps
// response.evidence. A turn's seen items are those of every mapped result in
// the prompts of its model calls, deduplicated: an app that sends earlier
// results again doesn't make an item seen twice.

import type { ProxyCallView, SeenItem } from '../checks/types.ts';
import type { ModelProxyConfig } from '../schema/profile.ts';
import { extractEvidence } from './response.ts';

export type ToolResultsMapping = NonNullable<ModelProxyConfig['toolResults']>;

/**
 * A tool result read as JSON: its whole text, or else the text from its first
 * `{` to its last `}`, as behind a header line or between fence tags.
 * undefined when neither is JSON.
 */
export function readToolResult(text: string): { readonly value: unknown } | undefined {
  const attempts = [text];
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) attempts.push(text.slice(start, end + 1));
  for (const attempt of attempts) {
    try {
      const value: unknown = JSON.parse(attempt);
      return { value };
    } catch {
      // Not JSON: try the next reading.
    }
  }
  return undefined;
}

export interface Seen {
  readonly seen: Record<string, SeenItem[]>;
  /** Mapped results that couldn't be read, once per tool. */
  readonly issues: string[];
}

export function seenEvidence(
  calls: readonly ProxyCallView[],
  mapping: ToolResultsMapping | undefined,
): Seen {
  const seen: Record<string, SeenItem[]> = {};
  const issues = new Set<string>();
  if (mapping === undefined) return { seen, issues: [] };
  const keys = new Map<string, Set<string>>();
  for (const call of calls) {
    for (const message of call.prompt ?? []) {
      if (message.role !== 'tool' || message.tool === undefined) continue;
      const collections = mapping[message.tool];
      if (collections === undefined) continue;
      const result = readToolResult(message.text);
      if (result === undefined) {
        issues.add(`a result of ${message.tool} isn't JSON, so nothing was read from it`);
        continue;
      }
      // Mapping problems inside a result say nothing the item list doesn't show.
      const evidence = extractEvidence(result.value, collections, []);
      for (const [name, items] of Object.entries(evidence)) {
        const known = keys.get(name) ?? new Set<string>();
        keys.set(name, known);
        for (const item of items) {
          const id = item['id'];
          const key =
            typeof id === 'string' || typeof id === 'number'
              ? `id:${String(id)}`
              : `item:${JSON.stringify(item)}`;
          if (known.has(key)) continue;
          known.add(key);
          (seen[name] ??= []).push({ tool: message.tool, item });
        }
      }
    }
  }
  return { seen, issues: [...issues] };
}
