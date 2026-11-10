// Observation through the target's own logs (ADR-0009): read the log lines
// once after the run, keep the JSON lines that pass the filters, tie each to a
// turn by request id, target id or order, and read the mapped fields.
// Nothing leaves the machine; results keep only the mapped fields.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { queryJsonPath, toJson, type JsonValue, type ProfileTarget } from '@yokla/core';
import { runCommandOrFail } from '../process/command.ts';

export type LogConfig = NonNullable<NonNullable<ProfileTarget['observe']>['logs']>;
type FieldSpec = LogConfig['fields'][string];

const ESC = 27;

/** Removes terminal colour codes (ESC [ … letter), which many log formats carry. */
export function stripAnsi(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === ESC && text[i + 1] === '[') {
      let j = i + 2;
      while (j < text.length && !/[A-Za-z]/u.test(text.charAt(j))) j += 1;
      i = j;
      continue;
    }
    out += text.charAt(i);
  }
  return out;
}

/** The JSON objects of the lines that pass `contains` and `match`. */
export function parseLogLines(text: string, config: LogConfig): unknown[] {
  const lines: unknown[] = [];
  for (const raw of text.split('\n')) {
    const line = stripAnsi(raw);
    if (config.contains !== undefined && !line.includes(config.contains)) continue;
    const start = line.indexOf('{');
    if (start === -1) continue;
    let value: unknown;
    try {
      value = JSON.parse(line.slice(start));
    } catch {
      continue;
    }
    const passes = config.match.every((m) => queryJsonPath(value, m.path)[0] === m.equals);
    if (passes) lines.push(value);
  }
  return lines;
}

/** A field's value, or null when the line doesn't measure it. A sum with a non-number is null. */
export function readField(line: unknown, spec: FieldSpec): JsonValue {
  if (typeof spec === 'string') {
    const [first] = queryJsonPath(line, spec);
    return first === undefined ? null : toJson(first);
  }
  const values = queryJsonPath(line, spec.from);
  switch (spec.reduce) {
    case 'first':
      return values[0] === undefined ? null : toJson(values[0]);
    case 'sum':
      return values.reduce<number | null>(
        (total, v) => (total === null || typeof v !== 'number' ? null : total + v),
        0,
      );
    case 'count':
      return values.length;
    case 'any':
      return values.some(Boolean);
    case 'all':
      return values.length > 0 && values.every(Boolean);
  }
}

export async function readLogText(
  config: LogConfig,
  context: { startedAt: Date; cwd: string },
): Promise<string> {
  if (config.source.kind === 'file')
    return readFileSync(resolve(context.cwd, config.source.path), 'utf8');
  const startedAt = context.startedAt.toISOString();
  const argv = config.source.run.map((arg) => arg.replaceAll('{{startedAt}}', startedAt));
  const result = await runCommandOrFail(argv, {
    timeoutMs: config.source.timeoutMs,
    cwd: context.cwd,
    maxOutputBytes: 64 * 1024 * 1024,
  });
  return result.stdout;
}

export interface TurnKey {
  readonly requestId: string | undefined;
  readonly targetId: string | undefined;
}

/** For each turn, its log line, or undefined. */
export function correlate(
  lines: readonly unknown[],
  config: LogConfig,
  turns: readonly TurnKey[],
): unknown[] {
  if (config.correlate.by === 'order') return turns.map((_turn, index) => lines[index]);
  const field = config.correlate.field ?? '$.requestId';
  const byId = new Map<string, unknown>();
  for (const line of lines) {
    const [id] = queryJsonPath(line, field);
    if (typeof id === 'string' || typeof id === 'number') byId.set(String(id), line);
  }
  return turns.map((turn) => {
    const key = config.correlate.by === 'request-id' ? turn.requestId : turn.targetId;
    return key === undefined ? undefined : byId.get(key);
  });
}

export function observedFields(line: unknown, config: LogConfig): Record<string, JsonValue> {
  return Object.fromEntries(
    Object.entries(config.fields).map(([name, spec]) => [name, readField(line, spec)]),
  );
}
