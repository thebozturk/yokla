// The inventory's data files, parsed into rows for the packs (ADR-0047):
// JSON Lines, a JSON array of objects, or CSV with a header line. A file is
// read up to its first MAX_ROWS rows; a line that isn't an object is left out.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { toJson, type DataFile, type DataRow, type JsonValue } from '@yokla/core';
import type { InventoryFile } from './inventory.ts';

/** Rows read from one data file at most. */
export const MAX_ROWS = 10_000;

function isRow(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsed(text: string): JsonValue | undefined {
  try {
    return toJson(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/** A CSV line's fields: commas apart, double quotes around a field, "" for a quote. */
function csvFields(line: string): string[] {
  const fields: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      fields.push(field);
      field = '';
    } else field += char;
  }
  fields.push(field);
  return fields;
}

/** The rows of a data file's text, by its extension. */
export function rowsOf(path: string, text: string): DataRow[] {
  const lines = () =>
    text
      .split(/\r?\n/u)
      .filter((line) => line.trim() !== '')
      .slice(0, MAX_ROWS + 1);
  if (path.endsWith('.jsonl')) {
    return lines()
      .slice(0, MAX_ROWS)
      .flatMap((line) => {
        const value = parsed(line);
        return value !== undefined && isRow(value) ? [value] : [];
      });
  }
  if (path.endsWith('.csv')) {
    const [header, ...body] = lines();
    if (header === undefined) return [];
    const keys = csvFields(header);
    return body.map((line) => {
      const values = csvFields(line);
      return Object.fromEntries(keys.map((key, index) => [key, values[index] ?? '']));
    });
  }
  const value = parsed(text);
  return Array.isArray(value) ? value.filter(isRow).slice(0, MAX_ROWS) : [];
}

/**
 * The inventory's data files, with their rows. `pathFor` writes each file's
 * path as the profile will read it: relative to the proposed file.
 */
export function readDataFiles(
  dir: string,
  files: readonly InventoryFile[],
  pathFor: (inRepo: string) => string,
): DataFile[] {
  return files
    .filter((file) => file.kind === 'data')
    .map((file) => ({
      path: pathFor(file.path),
      rows: rowsOf(file.path, readFileSync(join(dir, file.path), 'utf8')),
    }));
}
