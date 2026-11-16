// What a domain pack gives yokla analyze (ADR-0047): entries from the target's
// own data files, the rows to find in the target's answers, and the messages
// that make the target show them. Core knows no domain (P7).

import type { LanguagePack } from '../checks/types.ts';
import type { JsonValue } from '../extract/response.ts';
import type { KnownRows } from './match.ts';

export type DataRow = Readonly<Record<string, JsonValue>>;

/** A data file of the target's repository, parsed into rows. */
export interface DataFile {
  /** Its path in the repository, with "/" between folders. */
  readonly path: string;
  readonly rows: readonly DataRow[];
}

/** An entry a pack proposes, with what it rests on. */
export interface DataEntry {
  readonly pointer: string;
  readonly value: JsonValue;
  readonly evidence: string;
}

/** A message to probe the target with, and the evidence collection its answer should hold. */
export interface ProbeIntent {
  readonly message: string;
  readonly collection: string;
}

/** Rows to find in the target's answers (ADR-0047). */
export interface ProbedRows extends KnownRows {
  /** Per row field, the evidence field it is, such as `category` for a catalog's type. */
  readonly evidenceFields: Readonly<Record<string, string>>;
  /** The first message, which asks the target to show some of the rows. */
  readonly probe: ProbeIntent;
  /** The next message, built from the rows the first answer showed. */
  next(shown: readonly DataRow[]): ProbeIntent | undefined;
}

export interface DataAnalysis {
  readonly entries: readonly DataEntry[];
  readonly probed?: ProbedRows;
}

export interface DataAnalyzer {
  /**
   * Entries from the target's data files, and what to probe it with.
   * `languages` are the loaded language packs; `given` the languages the
   * person named, the first of which the probes are written in.
   */
  analyze(
    files: readonly DataFile[],
    options: { readonly languages: readonly LanguagePack[]; readonly given: readonly string[] },
  ): DataAnalysis;
}
