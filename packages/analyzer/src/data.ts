// The inventory's data files, parsed into rows for the packs (ADR-0047):
// JSON Lines, a JSON array of objects, or CSV with a header line. A file is
// read up to its first MAX_ROWS rows, and said to be cut past that
// (ADR-0066); a line that isn't an object is left out.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { toJson, type DataFile, type DataRow, type JsonValue } from '@yokla/core';
import type { InventoryFile } from './inventory.ts';

/** Rows read from one data file at most (ADR-0066). */
export const MAX_ROWS = 1_000_000;

/** A data file as the analyzer read it: cut when it holds more than MAX_ROWS rows. */
export interface ReadDataFile extends DataFile {
  readonly cut: boolean;
}

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

/**
 * Whether a file holds data rows, as the inventory sorts files: JSON Lines,
 * CSV, or a JSON array of objects (ADR-0065).
 */
export function isDataText(path: string, text: string): boolean {
  const name = path.toLowerCase();
  if (name.endsWith('.jsonl') || name.endsWith('.csv')) return true;
  if (!name.endsWith('.json')) return false;
  const value = parsed(text);
  return Array.isArray(value) && value.length > 0 && value.every(isRow);
}

/** The rows of a data file's text, by its extension, up to `max`, and whether it held more. */
export function readRows(
  path: string,
  text: string,
  max: number = MAX_ROWS,
): { rows: DataRow[]; cut: boolean } {
  const name = path.toLowerCase();
  const lines = () => text.split(/\r?\n/u).filter((line) => line.trim() !== '');
  if (name.endsWith('.jsonl')) {
    const all = lines();
    const rows = all.slice(0, max).flatMap((line) => {
      const value = parsed(line);
      return value !== undefined && isRow(value) ? [value] : [];
    });
    return { rows, cut: all.length > max };
  }
  if (name.endsWith('.csv')) {
    const [header, ...body] = lines();
    if (header === undefined) return { rows: [], cut: false };
    const keys = csvFields(header);
    const rows = body.slice(0, max).map((line) => {
      const values = csvFields(line);
      return Object.fromEntries(keys.map((key, index) => [key, values[index] ?? '']));
    });
    return { rows, cut: body.length > max };
  }
  const value = parsed(text);
  const all = Array.isArray(value) ? value.filter(isRow) : [];
  return { rows: all.slice(0, max), cut: all.length > max };
}

/** The rows of a data file's text, by its extension, up to `max`. */
export function rowsOf(path: string, text: string, max: number = MAX_ROWS): DataRow[] {
  return readRows(path, text, max).rows;
}

/**
 * The inventory's data files, with their rows. `pathFor` writes each file's
 * path as the profile will read it: relative to the proposed file.
 */
export function readDataFiles(
  dir: string,
  files: readonly InventoryFile[],
  pathFor: (inRepo: string) => string,
): ReadDataFile[] {
  return files
    .filter((file) => file.kind === 'data')
    .map((file) => ({
      path: pathFor(file.path),
      ...readRows(file.path, readFileSync(join(dir, file.path), 'utf8')),
    }));
}

/**
 * Data files given from outside the repository (ADR-0065), read as the
 * inventory's are. `pathFor` writes each one's path as the profile reads it.
 */
export function readGivenDataFiles(
  paths: readonly string[],
  pathFor: (path: string) => string,
): ReadDataFile[] {
  return paths.map((path) => ({
    path: pathFor(path),
    ...readRows(path, readFileSync(path, 'utf8')),
  }));
}
