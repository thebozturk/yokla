// The analyzer's model step (ADR-0049): the readable files in chunks, the
// estimate before any call, one call per chunk through yokla's own model
// client, replies cached, spend capped, and every value checked against the
// line it quotes before it is proposed.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ANALYZER_PROMPT_VERSION,
  analyzerPrompt,
  chunkFiles,
  estimateExtraction,
  extractSource,
  mergeExtracted,
  readableFiles,
  readReply,
  verifyEntry,
  type Chunk,
  type CustomerPrompt,
  type ExtractionEstimate,
  type OwnModel,
  type SourceFile,
  type UnverifiedEntry,
  type VerifiedEntry,
} from '@yokla/core';
import type { OwnReply } from '@yokla/runtime';
import type { InventoryFile } from './inventory.ts';
import type { ProposedEntry } from './propose.ts';

/** What sends a prompt to the model: yokla's model client, or a stand-in in tests. */
export interface ModelCaller {
  complete(prompt: CustomerPrompt, seed: string): Promise<OwnReply>;
}

export interface ModelPlan {
  readonly chunks: readonly Chunk[];
  readonly sent: readonly string[];
  readonly left: readonly string[];
  readonly estimate: ExtractionEstimate;
}

/** The files the model reads, cut into chunks, and what that will cost at most. */
export function planModelStep(
  dir: string,
  files: readonly InventoryFile[],
  model: OwnModel,
  languages: readonly string[],
  chunkTokens: number,
  maxTokens: number,
): ModelPlan {
  const sources: SourceFile[] = readableFiles(
    files.map((file) => ({ path: file.path, kind: file.kind, text: '' })),
  ).map((file) => ({ ...file, text: readFileSync(join(dir, file.path), 'utf8') }));
  const { chunks, left } = chunkFiles(sources, chunkTokens, maxTokens);
  const sent = [...new Set(chunks.flatMap((chunk) => chunk.parts.map((part) => part.path)))];
  return { chunks, sent, left, estimate: estimateExtraction(chunks, languages, model) };
}

export interface ModelStep {
  readonly entries: readonly ProposedEntry[];
  readonly unverified: readonly UnverifiedEntry[];
  readonly conflicts: readonly { readonly pointer: string; readonly evidence: readonly string[] }[];
  readonly summary: {
    readonly model: string;
    readonly calls: number;
    readonly cached: number;
    readonly inputTokens: number | null;
    readonly outputTokens: number | null;
    readonly costUsd: number | null;
    readonly sent: readonly string[];
    readonly left: readonly string[];
    readonly partial: boolean;
  };
}

interface Cached {
  readonly text: string;
  readonly model: string;
}

function isCached(value: unknown): value is Cached {
  return (
    typeof value === 'object' &&
    value !== null &&
    'text' in value &&
    typeof value.text === 'string' &&
    'model' in value &&
    typeof value.model === 'string'
  );
}

/** A reply's key: the model's settings, the prompt's version, the languages and the chunk. */
function cacheKey(model: OwnModel, languages: readonly string[], chunk: Chunk): string {
  const settings = {
    kind: model.kind,
    url: model.url,
    model: model.model,
    temperature: model.temperature,
    maxTokens: model.maxTokens,
  };
  return createHash('sha256')
    .update(JSON.stringify([settings, ANALYZER_PROMPT_VERSION, languages, chunk.text]))
    .digest('hex');
}

/** A call's cost; null when its tokens or the model's price are unknown. */
function costOf(model: OwnModel, reply: OwnReply): number | null {
  const { input, output } = reply.usage;
  if (model.price === undefined || input === null || output === null) return null;
  return (input * model.price.input + output * model.price.output) / 1_000_000;
}

/**
 * Asks the model about each chunk, from the cache where it can, until the
 * spend reaches `maxCostUsd`. Keeps only the values that pass their check,
 * and none at a pointer the data or the probes already gave.
 */
export async function runModelStep(input: {
  readonly plan: ModelPlan;
  readonly model: OwnModel;
  readonly caller: ModelCaller;
  readonly languages: readonly string[];
  readonly lines: (path: string) => readonly string[];
  readonly maxCostUsd: number;
  readonly cacheDir: string;
  readonly fresh: boolean;
}): Promise<ModelStep> {
  const verified: VerifiedEntry[] = [];
  const unverified: UnverifiedEntry[] = [];
  let calls = 0;
  let cached = 0;
  let inputTokens: number | null = 0;
  let outputTokens: number | null = 0;
  let costUsd: number | null = 0;
  let partial = false;
  for (const chunk of input.plan.chunks) {
    if (costUsd === null || costUsd >= input.maxCostUsd) {
      partial = true;
      break;
    }
    const key = cacheKey(input.model, input.languages, chunk);
    const path = join(input.cacheDir, `${key}.json`);
    let text: string;
    const stored: unknown =
      !input.fresh && existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
    if (isCached(stored)) {
      text = stored.text;
      cached += 1;
    } else {
      const reply = await input.caller.complete(analyzerPrompt(chunk, input.languages), key);
      calls += 1;
      text = reply.text;
      const cost = costOf(input.model, reply);
      costUsd = cost === null || costUsd === null ? null : costUsd + cost;
      inputTokens =
        reply.usage.input === null || inputTokens === null ? null : inputTokens + reply.usage.input;
      outputTokens =
        reply.usage.output === null || outputTokens === null
          ? null
          : outputTokens + reply.usage.output;
      mkdirSync(input.cacheDir, { recursive: true });
      writeFileSync(path, `${JSON.stringify({ text, model: reply.model })}\n`);
    }
    for (const entry of readReply(text)) {
      const checked = verifyEntry(entry, chunk, input.lines, input.languages);
      if (checked.ok) verified.push(checked.entry);
      else unverified.push(checked.problem);
    }
  }
  const merged = mergeExtracted(verified);
  const entries = merged.entries.map((entry): ProposedEntry => ({
    pointer: entry.pointer,
    value: entry.value,
    provenance: {
      source: extractSource(entry.kind),
      evidence: entry.evidence,
      status: 'proposed',
    },
  }));
  return {
    entries,
    unverified,
    conflicts: merged.conflicts,
    summary: {
      model: input.model.model,
      calls,
      cached,
      inputTokens,
      outputTokens,
      costUsd: costUsd === null ? null : Math.round(costUsd * 1e9) / 1e9,
      sent: input.plan.sent,
      left: input.plan.left,
      partial,
    },
  };
}
