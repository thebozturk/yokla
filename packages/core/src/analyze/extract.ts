// The analyzer's model step (ADR-0049): the fields a model may propose, the
// chunks it reads, the prompt it gets, and the deterministic check of every
// value it returns against the line it quotes. A value that fails the check
// never reaches the proposal. Pure.

import type { CustomerPrompt } from '../customer/customer.ts';
import type { JsonValue } from '../extract/response.ts';

/** The version of the prompt template; a cached reply is keyed by it. */
export const ANALYZER_PROMPT_VERSION = 1;

/** The first line of yokla's analyzer prompt, by which a fake provider knows it. */
export const ANALYZER_MARK = 'yokla: analyzer';

/** The fields a model may propose: values that appear word for word in their source. */
export const EXTRACT_FIELDS = [
  'limits.burstPerSecond',
  'limits.perMinute',
  'limits.perHour',
  'cacheBypass.header',
  'refusal',
] as const;
export type ExtractField = (typeof EXTRACT_FIELDS)[number];

/** A file of the repository the model may read, with its inventory kind. */
export interface SourceFile {
  readonly path: string;
  readonly kind: string;
  readonly text: string;
}

/** A stretch of a file's lines in a chunk, numbered from 1. */
export interface ChunkPart {
  readonly path: string;
  readonly kind: string;
  readonly from: number;
  readonly to: number;
}

export interface Chunk {
  readonly parts: readonly ChunkPart[];
  /** The text sent: each part under its path, each line with its number. */
  readonly text: string;
  /** Estimated: one token per two characters (ADR-0051). */
  readonly tokens: number;
}

/**
 * Tokens, estimated: one per two characters, as the budget counts them. Code
 * took one per about 2.5 on the demo-shop, so this stays above most code's
 * count, and well above prose's (ADR-0051).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2);
}

/** A test file: in a test folder, or named as one. Its values are fixtures. */
export function isTestPath(path: string): boolean {
  const parts = path.split('/');
  const name = parts.at(-1) ?? '';
  return (
    parts.slice(0, -1).some((folder) => ['test', 'tests', '__tests__'].includes(folder)) ||
    /\.(?:test|spec)\.[^.]+$/u.test(name) ||
    /_test\.[^.]+$/u.test(name) ||
    /^test_.*\.py$/u.test(name)
  );
}

/** The kinds the model reads, claims first: a budget that runs out leaves code unread. */
export const READ_KINDS = ['doc', 'prompt', 'contract', 'manifest', 'env-example', 'code'] as const;

/** The files the model may read, in the order it reads them: by kind, then by path. */
export function readableFiles(files: readonly SourceFile[]): SourceFile[] {
  return READ_KINDS.flatMap((kind) =>
    files
      .filter((file) => file.kind === kind && !isTestPath(file.path))
      .toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  );
}

/**
 * The files cut into chunks of at most `chunkTokens`, at line breaks, in
 * order, until `maxTokens` would be passed. A line longer than a chunk goes
 * alone. `left` names the files not sent in full.
 */
export function chunkFiles(
  files: readonly SourceFile[],
  chunkTokens: number,
  maxTokens: number,
): { readonly chunks: Chunk[]; readonly left: string[] } {
  const chunks: Chunk[] = [];
  const left: string[] = [];
  let parts: ChunkPart[] = [];
  let lines: string[] = [];
  let used = 0;
  let total = 0;
  let stopped = false;
  const close = (): void => {
    if (parts.length === 0) return;
    const text = lines.join('\n');
    chunks.push({ parts, text, tokens: estimateTokens(text) });
    total += estimateTokens(text);
    parts = [];
    lines = [];
    used = 0;
  };
  for (const file of files) {
    if (stopped) {
      left.push(file.path);
      continue;
    }
    const numbered = file.text
      .split(/\r?\n/u)
      .map((line, index) => `${String(index + 1)}| ${line}`);
    let at = 0;
    while (at < numbered.length) {
      const header = `=== ${file.path}`;
      const room = chunkTokens - used - estimateTokens(header);
      let end = at;
      let size = 0;
      while (end < numbered.length && size + estimateTokens(`${numbered[end] ?? ''}\n`) <= room) {
        size += estimateTokens(`${numbered[end] ?? ''}\n`);
        end += 1;
      }
      // A line that fills a chunk on its own goes alone.
      if (end === at && used === 0) end = at + 1;
      if (end === at) {
        close();
        continue;
      }
      const piece = [header, ...numbered.slice(at, end)];
      if (total + used + estimateTokens(piece.join('\n')) > maxTokens) {
        stopped = true;
        left.push(file.path);
        break;
      }
      parts.push({ path: file.path, kind: file.kind, from: at + 1, to: end });
      lines.push(...piece);
      used += estimateTokens(piece.join('\n'));
      at = end;
      if (at < numbered.length) close();
    }
  }
  close();
  return { chunks, left };
}

const FIELD_HELP = `- limits.burstPerSecond, limits.perMinute, limits.perHour: how many requests the
  assistant's chat endpoint accepts from one client per second, minute or hour.
  The value is a whole number.
- cacheBypass.header: a request header that makes the assistant skip its response
  cache. The value is {"name": "<header name>", "value": "<the value it is sent with>"}.
- refusal: a sentence the assistant answers with when it refuses a request. The value
  is {"language": "<one of the profile's languages>", "sentence": "<the sentence>"}.`;

/** The prompt for one chunk: yokla's own, naming no particular target (P9). */
export function analyzerPrompt(chunk: Chunk, languages: readonly string[]): CustomerPrompt {
  const system = [
    ANALYZER_MARK,
    'You read part of the repository of a conversational assistant: its docs, prompts,',
    'contracts and code. Find the values below where the text states them.',
    '',
    'Fields:',
    FIELD_HELP,
    '',
    'Rules:',
    '- Propose a value only where a line states it. Never guess, never compute.',
    '- For each value, give the file, the line number, and the text of that line as',
    '  a quote, as it is written.',
    '- If the text states none of them, answer with no entries.',
    '',
    'Answer with JSON only:',
    '{"entries": [{"field": "...", "value": ..., "file": "...", "line": 0, "quote": "..."}]}',
  ].join('\n');
  return {
    system,
    messages: [
      {
        role: 'user',
        content: `The profile's languages: ${languages.join(', ')}\n\n${chunk.text}`,
      },
    ],
  };
}

/** An entry as the model gave it, with the shape of its field. */
export interface ReturnedEntry {
  readonly field: ExtractField;
  readonly value: JsonValue;
  readonly file: string;
  readonly line: number;
  readonly quote: string;
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isText = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '';

/** A text field of a value readReply let through; its shape is checked there. */
function textAt(value: unknown, key: string): string {
  const item = isObject(value) ? value[key] : undefined;
  return typeof item === 'string' ? item : '';
}

function parseJson(source: string): unknown {
  try {
    return JSON.parse(source);
  } catch {
    return undefined;
  }
}

/** Whether a value has its field's shape. */
function shaped(field: ExtractField, value: unknown): boolean {
  if (field.startsWith('limits.')) return Number.isInteger(value) && Number(value) > 0;
  if (field === 'cacheBypass.header') {
    return isObject(value) && isText(value['name']) && isText(value['value']);
  }
  return isObject(value) && isText(value['language']) && isText(value['sentence']);
}

/**
 * The entries of a reply: JSON, whole or from its first { to its last }, of
 * the right shapes. null when it holds no entries list: the reply isn't the
 * JSON asked for, and is unread (ADR-0051).
 */
export function readReply(text: string): ReturnedEntry[] | null {
  const whole =
    parseJson(text) ?? parseJson(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  const entries = isObject(whole) ? whole['entries'] : undefined;
  if (!Array.isArray(entries)) return null;
  return entries.flatMap((entry: unknown): ReturnedEntry[] => {
    if (!isObject(entry)) return [];
    const { field, value, file, line, quote } = entry;
    const known = EXTRACT_FIELDS.find((name) => name === field);
    if (
      known === undefined ||
      !shaped(known, value) ||
      typeof file !== 'string' ||
      !Number.isInteger(line) ||
      typeof quote !== 'string'
    ) {
      return [];
    }
    return [{ field: known, value: toPlain(value), file, line: Number(line), quote }];
  });
}

function toPlain(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map(toPlain);
  if (isObject(value))
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toPlain(item)]));
  return null;
}

const collapse = (text: string): string => text.replaceAll(/\s+/gu, ' ').trim();

function escapeRegExp(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** A word standing alone: no letter, digit, "-" or "_" right before or after it. */
function standsAlone(word: string, text: string, flags = 'u'): RegExpExecArray | null {
  return new RegExp(`(?<![\\p{L}\\p{N}_-])${escapeRegExp(word)}(?![\\p{L}\\p{N}_-])`, flags).exec(
    text,
  );
}

/** A whole number standing alone, as digits, not part of a longer number. */
function numberStandsAlone(value: number, text: string): boolean {
  return new RegExp(`(?<![\\d.,])${String(value)}(?![\\d]|[.,]\\d)`, 'u').test(text);
}

/** Why an entry's value isn't in its quote, or undefined when it is. */
function valueProblem(entry: ReturnedEntry, quote: string): string | undefined {
  const { value } = entry;
  if (typeof value === 'number') {
    return numberStandsAlone(value, quote) ? undefined : 'the value is not in the quote';
  }
  if (!isObject(value)) return 'the value has the wrong shape';
  if (entry.field === 'cacheBypass.header') {
    const name = standsAlone(textAt(value, 'name'), quote, 'iu');
    if (name === null) return 'the header name is not in the quote';
    const after = quote.slice(name.index + name[0].length);
    return standsAlone(textAt(value, 'value'), after) === null
      ? 'the header value is not in the quote, after the name'
      : undefined;
  }
  return collapse(quote).includes(collapse(textAt(value, 'sentence')))
    ? undefined
    : 'the sentence is not in the quote';
}

export interface VerifiedEntry extends ReturnedEntry {
  /** The kind of the file the value is in. */
  readonly kind: string;
}

export interface UnverifiedEntry {
  readonly field: string;
  readonly file: string;
  readonly line: number;
  readonly reason: string;
}

/**
 * Checks an entry against the chunk it came from: the file was sent, the line
 * was sent, the quote is on that line or within two lines of it, and the
 * value is in the quote. `lines` gives a file's lines, numbered from 1.
 */
export function verifyEntry(
  entry: ReturnedEntry,
  chunk: Chunk,
  lines: (path: string) => readonly string[],
  languages: readonly string[],
):
  | { readonly ok: true; readonly entry: VerifiedEntry }
  | { readonly ok: false; readonly problem: UnverifiedEntry } {
  const fail = (reason: string) => ({
    ok: false as const,
    problem: { field: entry.field, file: entry.file, line: entry.line, reason },
  });
  const part = chunk.parts.find(
    (candidate) =>
      candidate.path === entry.file && entry.line >= candidate.from && entry.line <= candidate.to,
  );
  if (part === undefined) return fail('the file and line were not in the chunk sent');
  if (collapse(entry.quote) === '') return fail('the quote is empty');
  const text = lines(entry.file);
  const window = text.slice(Math.max(0, entry.line - 3), entry.line + 2).join('\n');
  if (!collapse(window).includes(collapse(entry.quote))) {
    return fail('the quote is not on that line');
  }
  if (entry.field === 'refusal' && !languages.includes(textAt(entry.value, 'language'))) {
    return fail("the language is not one of the profile's");
  }
  const problem = valueProblem(entry, entry.quote);
  return problem === undefined ? { ok: true, entry: { ...entry, kind: part.kind } } : fail(problem);
}

/** An entry the model step proposes, with what it rests on. */
export interface ExtractedEntry {
  readonly pointer: string;
  readonly value: JsonValue;
  /** The kind of the file of its first evidence. */
  readonly kind: string;
  readonly evidence: string;
}

const quoted = (entry: ReturnedEntry): string => {
  const quote = collapse(entry.quote);
  return `${entry.file}:${String(entry.line)}: "${quote.length > 120 ? `${quote.slice(0, 117)}...` : quote}"`;
};

function pointerOf(entry: VerifiedEntry): string {
  if (entry.field.startsWith('limits.'))
    return `/target/limits/${entry.field.slice('limits.'.length)}`;
  if (entry.field === 'cacheBypass.header') return '/target/cacheBypass';
  return `/refusal/canonical/${textAt(entry.value, 'language')}`;
}

function valueOf(entry: VerifiedEntry): JsonValue {
  if (entry.field === 'cacheBypass.header') {
    return {
      kind: 'header',
      name: textAt(entry.value, 'name'),
      value: textAt(entry.value, 'value'),
    };
  }
  return entry.value;
}

/**
 * Verified entries, in sending order, made into one value per entry: the
 * same value once, with its first evidence; different values of a limit or
 * the cache bypass are a conflict, and give none; refusals gather into their
 * language's list.
 */
export function mergeExtracted(entries: readonly VerifiedEntry[]): {
  readonly entries: ExtractedEntry[];
  readonly conflicts: { readonly pointer: string; readonly evidence: string[] }[];
} {
  const byPointer = new Map<string, VerifiedEntry[]>();
  for (const entry of entries) {
    const pointer = pointerOf(entry);
    byPointer.set(pointer, [...(byPointer.get(pointer) ?? []), entry]);
  }
  const merged: ExtractedEntry[] = [];
  const conflicts: { pointer: string; evidence: string[] }[] = [];
  for (const [pointer, found] of byPointer) {
    const [first] = found;
    if (first === undefined) continue;
    if (first.field === 'refusal') {
      const sentences: string[] = [];
      const evidence: string[] = [];
      for (const entry of found) {
        const sentence = collapse(textAt(entry.value, 'sentence'));
        if (sentences.includes(sentence)) continue;
        sentences.push(sentence);
        evidence.push(quoted(entry));
      }
      merged.push({ pointer, value: sentences, kind: first.kind, evidence: evidence.join('; ') });
      continue;
    }
    const values = new Set(found.map((entry) => JSON.stringify(valueOf(entry))));
    if (values.size > 1) {
      conflicts.push({ pointer, evidence: found.map(quoted) });
      continue;
    }
    merged.push({ pointer, value: valueOf(first), kind: first.kind, evidence: quoted(first) });
  }
  return { entries: merged, conflicts };
}

/** The provenance source of a value, by the kind of its file. */
export function extractSource(kind: string): 'doc' | 'prompt' | 'contract' | 'code' {
  return kind === 'doc' || kind === 'prompt' || kind === 'contract' ? kind : 'code';
}

export interface ExtractionEstimate {
  readonly chunks: number;
  readonly inputTokens: number;
  /** The most the model can answer: chunks × its maxTokens. */
  readonly maxOutputTokens: number;
  /** null without a price. */
  readonly costUsd: number | null;
  readonly upperUsd: number | null;
}

/** The step's cost before it runs: every chunk's prompt, and the most each reply can be. */
export function estimateExtraction(
  chunks: readonly Chunk[],
  languages: readonly string[],
  model: {
    readonly maxTokens: number;
    readonly price?: { readonly input: number; readonly output: number } | undefined;
  },
): ExtractionEstimate {
  const inputTokens = chunks.reduce((sum, chunk) => {
    const prompt = analyzerPrompt(chunk, languages);
    return sum + estimateTokens(prompt.system) + estimateTokens(prompt.messages[0]?.content ?? '');
  }, 0);
  const maxOutputTokens = chunks.length * model.maxTokens;
  const costUsd =
    model.price === undefined
      ? null
      : (inputTokens * model.price.input + maxOutputTokens * model.price.output) / 1_000_000;
  return {
    chunks: chunks.length,
    inputTokens,
    maxOutputTokens,
    costUsd,
    upperUsd: costUsd === null ? null : costUsd * 2,
  };
}
