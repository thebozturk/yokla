// Parses YAML (or JSON) config text and validates it, reporting file:line:column.
// Pure: the caller reads the file.

import {
  isMap,
  isNode,
  isPair,
  isScalar,
  LineCounter,
  parseDocument,
  type Document,
  type Node,
} from 'yaml';
import type { z } from 'zod';

export interface ConfigIssue {
  readonly file: string;
  /** 1-based; absent when the position is unknown. */
  readonly line?: number;
  readonly column?: number;
  /** Dotted path to the offending value, e.g. target.request.url or cases[2].id. */
  readonly path: string;
  readonly message: string;
}

export type ParseResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly issues: ConfigIssue[] };

const MAX_ALIAS_COUNT = 100;

export function formatPath(path: readonly PropertyKey[]): string {
  return path
    .map((key, index) =>
      typeof key === 'number' ? `[${String(key)}]` : `${index === 0 ? '' : '.'}${String(key)}`,
    )
    .join('');
}

export function formatIssue(issue: ConfigIssue): string {
  const position =
    issue.line === undefined ? '' : `:${String(issue.line)}:${String(issue.column ?? 1)}`;
  const where = issue.path === '' ? '' : ` ${issue.path}:`;
  return `${issue.file}${position}:${where} ${issue.message}`;
}

/** The node at `path`, or the deepest ancestor that exists. */
function nodeAt(doc: Document, path: readonly PropertyKey[]): Node | undefined {
  for (let length = path.length; length >= 0; length -= 1) {
    const prefix = path.slice(0, length);
    const node: unknown = length === 0 ? doc.contents : doc.getIn(prefix, true);
    if (isNode(node)) return node;
  }
  return undefined;
}

/** For an unknown key, point at the key itself rather than at its object. */
function keyNode(doc: Document, path: readonly PropertyKey[], key: string): Node | undefined {
  const parent = nodeAt(doc, path);
  if (!isMap(parent)) return parent;
  const pair = parent.items.find(
    (item) => isPair(item) && isScalar(item.key) && item.key.value === key,
  );
  return isPair(pair) && isNode(pair.key) ? pair.key : parent;
}

export function parseConfig<T>(text: string, file: string, schema: z.ZodType<T>): ParseResult<T> {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, {
    lineCounter,
    version: '1.2',
    schema: 'core',
    merge: false,
    uniqueKeys: true,
    prettyErrors: true,
  });

  // Warnings (such as unresolved custom tags) are errors in config files.
  const yamlProblems = [...doc.errors, ...doc.warnings];
  if (yamlProblems.length > 0) {
    return {
      ok: false,
      issues: yamlProblems.map((problem) => {
        const position = problem.linePos?.[0];
        return {
          file,
          ...(position === undefined ? {} : { line: position.line, column: position.col }),
          path: '',
          message: (problem.message.split('\n')[0] ?? problem.message).replace(
            / at line \d+, column \d+:?$/u,
            '',
          ),
        };
      }),
    };
  }

  let value: unknown;
  try {
    value = doc.toJS({ maxAliasCount: MAX_ALIAS_COUNT });
  } catch (error) {
    return {
      ok: false,
      issues: [{ file, path: '', message: error instanceof Error ? error.message : String(error) }],
    };
  }

  const parsed = schema.safeParse(value);
  if (parsed.success) return { ok: true, value: parsed.data };

  const issues: ConfigIssue[] = [];
  for (const issue of parsed.error.issues) {
    const path = issue.path;
    const located: { node: Node | undefined; path: readonly PropertyKey[]; message: string }[] =
      issue.code === 'unrecognized_keys'
        ? issue.keys.map((key) => ({
            node: keyNode(doc, path, key),
            path: [...path, key],
            message: 'unknown key',
          }))
        : [{ node: nodeAt(doc, path), path, message: issue.message }];
    for (const entry of located) {
      const offset = entry.node?.range?.[0];
      const position = offset === undefined ? undefined : lineCounter.linePos(offset);
      issues.push({
        file,
        ...(position === undefined ? {} : { line: position.line, column: position.col }),
        path: formatPath(entry.path),
        message: entry.message,
      });
    }
  }
  return { ok: false, issues };
}
