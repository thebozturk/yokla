// The check API (design §10) and what packs provide (design §17).
// A check is a pure function of one turn and its context. It says whether it
// applied; when its input is absent it reports `applicable: false` instead of
// passing (no vacuous checks).

import type { EvidenceItem, JsonValue } from '../extract/response.ts';
import type { DomainPackSchemas } from '../schema/build.ts';
import type { Case } from '../schema/cases.ts';
import type { Profile } from '../schema/profile.ts';

export type FindingSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';

export interface CheckFinding {
  readonly dimension: string;
  readonly verdict: 'pass' | 'fail';
  readonly severity: FindingSeverity;
  readonly message: string;
  readonly evidence?: JsonValue;
}

export type CheckOutcome =
  | { readonly applicable: false; readonly reason: string }
  | { readonly applicable: true; readonly findings: readonly CheckFinding[] };

/** One answered turn, as checks see it. */
export interface TurnView {
  readonly user: string;
  /** The turn's expectations; packs read their own keys. */
  readonly expect: Readonly<Record<string, unknown>>;
  readonly response: {
    readonly status: number;
    readonly latencyMs: number;
    readonly text: string;
    readonly route: string | undefined;
    readonly id: string | undefined;
    readonly evidence: Readonly<Record<string, readonly EvidenceItem[]>>;
  };
  /** Fields read from the target's logs (ADR-0009). */
  readonly observed: Readonly<Record<string, JsonValue>> | undefined;
}

/** What a language pack provides. Grows with the language-dependent checks. */
export interface LanguagePack {
  readonly language: string;
}

export interface CheckContext {
  readonly case: Case;
  readonly turnIndex: number;
  readonly turn: TurnView;
  /** Earlier turns of the same sample, oldest first. */
  readonly history: readonly TurnView[];
  readonly profile: Profile;
  /** The pack for the case's language, when one is loaded. */
  readonly lang: LanguagePack | undefined;
}

export interface Check {
  readonly id: string;
  readonly description: string;
  run(context: CheckContext): CheckOutcome;
}

/** How the findings of N samples become one verdict per dimension (design §13). */
export type AggregationPolicy = 'worst-of-n' | 'majority-of-n';

/** A domain pack bound to one profile: its checks, with their data already loaded. */
export interface PreparedPack {
  readonly checks: readonly Check[];
}

export interface PackIo {
  /** Reads a text file; relative paths resolve against the profile's directory. */
  readText(path: string): string;
}

export interface DomainPack extends DomainPackSchemas {
  /** Aggregation per dimension; a dimension not listed uses worst-of-n. */
  readonly dimensions: Readonly<Record<string, AggregationPolicy>>;
  /** Loads the pack's data (e.g. a catalog snapshot) and binds its checks. */
  prepare(profile: Profile, io: PackIo): PreparedPack;
}
