// Rows from another tool's file (ADR-0097): JSON, JSON Lines, YAML or CSV,
// by the file's extension. A CSV file's first line names its columns, and each
// row becomes an object of strings, by RFC 4180: fields in double quotes may
// hold commas, line breaks and doubled quotes. Pure: the caller reads the file.

import { parseConfig, queryJsonPath, z } from '@yokla/core';

export const ROW_FORMATS = ['json', 'jsonl', 'yaml', 'csv'] as const;
export type RowFormat = (typeof ROW_FORMATS)[number];

/** A file's format by its extension; undefined for another. */
export function formatOf(file: string): RowFormat | undefined {
  const extension = /\.([a-z]+)$/iu.exec(file)?.[1]?.toLowerCase();
  if (extension === 'yml') return 'yaml';
  return ROW_FORMATS.find((format) => format === extension);
}

/** A problem with the file's rows: where, and what. */
export class RowsError extends Error {
  override readonly name = 'RowsError';
}

/** The records of a CSV text: each a list of its fields. */
export function csvRecords(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  let index = 0;
  const body = text.startsWith('\uFEFF') ? text.slice(1) : text;
  while (index < body.length) {
    const char = body[index] ?? '';
    if (quoted) {
      if (char === '"' && body[index + 1] === '"') {
        field += '"';
        index += 2;
        continue;
      }
      if (char === '"') quoted = false;
      else field += char;
      index += 1;
      continue;
    }
    if (char === '"' && field === '') {
      quoted = true;
    } else if (char === ',') {
      record.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      record.push(field);
      records.push(record);
      record = [];
      field = '';
    } else {
      field += char;
    }
    index += 1;
  }
  if (quoted) throw new RowsError('a quoted CSV field is never closed');
  if (field !== '' || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  // A blank line is no record, nor is the empty one between the CR and the LF of a CRLF.
  return records.filter((one) => !(one.length === 1 && one[0] === ''));
}

/** A CSV text's rows, each an object of its columns' strings. */
function csvRows(text: string): Record<string, string>[] {
  const [header, ...records] = csvRecords(text);
  if (header === undefined) return [];
  return records.map((record, index) => {
    if (record.length !== header.length) {
      throw new RowsError(
        `CSV row ${String(index + 1)} has ${String(record.length)} fields, and the header ${String(header.length)}`,
      );
    }
    return Object.fromEntries(header.map((name, column) => [name, record[column] ?? '']));
  });
}

/**
 * The rows of a file's text: each line of JSON Lines, each CSV row, or in JSON
 * or YAML, what `rows` selects, by default the document when it is a list.
 */
export function readRows(text: string, format: RowFormat, rows?: string): unknown[] {
  switch (format) {
    case 'csv': {
      return csvRows(text);
    }
    case 'jsonl': {
      return text.split('\n').flatMap((line, index) => {
        if (line.trim() === '') return [];
        try {
          const value: unknown = JSON.parse(line);
          return [value];
        } catch {
          throw new RowsError(`line ${String(index + 1)} is not JSON`);
        }
      });
    }
    case 'json':
    case 'yaml': {
      const parsed = parseConfig(text, format, z.unknown());
      if (!parsed.ok) throw new RowsError(`the file is not ${format === 'json' ? 'JSON' : 'YAML'}`);
      if (rows !== undefined) return queryJsonPath(parsed.value, rows);
      if (Array.isArray(parsed.value)) return parsed.value;
      throw new RowsError('the file is not a list: give the mapping `rows`, the path to its rows');
    }
  }
}
