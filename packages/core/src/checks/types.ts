// The check API (design §10) and what packs provide (design §17).
// A check is a pure function of one turn and its context. It says whether it
// applied; when its input is absent it reports `applicable: false` instead of
// passing (no vacuous checks).

import type { EvidenceItem, JsonValue } from '../extract/response.ts';
import type { DomainPackSchemas } from '../schema/build.ts';
import type { Case } from '../schema/cases.ts';
import type { Profile } from '../schema/profile.ts';
import type { PromptRole } from '../schema/proxy.ts';

export type FindingSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';

export interface CheckFinding {
  readonly dimension: string;
  readonly verdict: 'pass' | 'fail';
  readonly severity: FindingSeverity;
  readonly message: string;
  readonly evidence?: JsonValue;
}

/** A threshold the check couldn't measure on this turn (ADR-0014). */
export interface UnmeasuredDimension {
  readonly dimension: string;
  readonly reason: string;
}

export type CheckOutcome =
  | { readonly applicable: false; readonly reason: string }
  | {
      readonly applicable: true;
      readonly findings: readonly CheckFinding[];
      /** Dimensions it applies to but couldn't measure: never a pass. */
      readonly unmeasured?: readonly UnmeasuredDimension[];
    };

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
  /** The target answered with a clarifying question (see response.clarification). */
  readonly clarifying: boolean;
  /**
   * Set when the turn injected provider faults (ADR-0013). `failure` says why the
   * target gave no usable answer under them; the text is then empty.
   */
  readonly faults: { readonly failure: string | undefined } | undefined;
  /**
   * Why the answer can't be used, in a turn that allows other statuses
   * (ADR-0019): an incomplete stream, a body that isn't JSON, no answer text.
   * The text is then empty, and status-allowed judges the turn.
   */
  readonly unusable: string | undefined;
  /** The model calls the proxy tied to this turn; undefined without proxy data (ADR-0012). */
  readonly proxy:
    { readonly calls: readonly ProxyCallView[]; readonly costUsd: number | null } | undefined;
}

/** One model call the proxy tied to a turn, as checks see it (ADR-0012, ADR-0015). */
export interface ProxyCallView {
  /** Input tokens as the provider reported them, cached ones included; null when unreported. */
  readonly inputTokens: number | null;
  /** The messages the call sent, with their text; null when the proxy couldn't read them. */
  readonly prompt: readonly { readonly role: PromptRole; readonly text: string }[] | null;
}

/** A money amount mentioned in text, e.g. "1.299,90 TL". */
export interface MoneyMention {
  readonly amount: number;
  /** ISO 4217 code, e.g. TRY; undefined when the text names no currency. */
  readonly currency: string | undefined;
  readonly raw: string;
  readonly start: number;
  readonly end: number;
}

/** A duration mentioned in text, e.g. "14 gün" or "30 days". */
export interface DurationMention {
  readonly amount: number;
  readonly unit: 'day' | 'week' | 'month' | 'year';
  readonly raw: string;
  readonly start: number;
  readonly end: number;
}

/**
 * General phrases of a language, folded (see LanguagePack.fold). Domain
 * phrases, such as stock or shipping wording, belong to domain packs.
 */
export type PhraseKind =
  | 'refusal' // the assistant declines: "I can't help with that"
  | 'inability' // it can't verify or doesn't know: "I can't verify"
  | 'absence' // something isn't there: "we don't carry", "bulamadım"
  | 'alternative' // it offers something else: "instead", "bunun yerine"
  | 'free' // something costs nothing: "free of charge", "ücretsiz"
  | 'deflection'; // it sends the user elsewhere: "contact customer service"

/** What a language pack provides (design §17). */
export interface LanguagePack {
  readonly language: string;
  /** Lower-cases with the language's rules and removes diacritics. */
  fold(text: string): string;
  /** Money amounts with a currency marker; bare numbers are not money. */
  findMoney(text: string): MoneyMention[];
  findDurations(text: string): DurationMention[];
  formatMoney(amount: number, currency: string): string;
  readonly phrases: Readonly<Record<PhraseKind, readonly string[]>>;
  /**
   * The language's most common words, folded, shared with no other pack's list;
   * language-match tells languages apart by them (ADR-0018).
   */
  readonly commonWords: readonly string[];
  /**
   * Number words from 2 up, folded, and their values, for quantities such as
   * "four bags" (ADR-0021). Words that also mean something else are left out.
   */
  readonly numberWords: Readonly<Record<string, number>>;
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
  /** Every loaded language pack, by language (ADR-0018). */
  readonly languages: ReadonlyMap<string, LanguagePack>;
}

export interface Check {
  readonly id: string;
  readonly description: string;
  run(context: CheckContext): CheckOutcome;
}

/**
 * How the findings of N samples become one verdict per dimension (design §13).
 * An `advisory` dimension is judged like worst-of-n and reported, but never
 * decides the case status.
 */
export type AggregationPolicy = 'worst-of-n' | 'majority-of-n' | 'advisory';

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
