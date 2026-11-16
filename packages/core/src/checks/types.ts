// The check API (design §10) and what packs provide (design §17).
// A check is a pure function of one turn and its context. It says whether it
// applied; when its input is absent it reports `applicable: false` instead of
// passing (no vacuous checks).

import type { EvidenceItem, JsonValue } from '../extract/response.ts';
import type { DomainPackSchemas } from '../schema/build.ts';
import type { Case } from '../schema/cases.ts';
import type { Profile } from '../schema/profile.ts';
import type { PromptRole } from '../schema/proxy.ts';
import type { FindingSubject } from '../schema/results.ts';
import type { DataAnalyzer } from '../analyze/pack.ts';

export type FindingSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';

export interface CheckFinding {
  readonly dimension: string;
  readonly verdict: 'pass' | 'fail';
  readonly severity: FindingSeverity;
  readonly message: string;
  readonly evidence?: JsonValue;
  /**
   * The value a failing finding is about, taken from the answer. Core works
   * out where it first appears (ADR-0033).
   */
  readonly subject?: FindingSubject;
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
    /**
     * The response as the profile's paths read it: the JSON body, or the
     * document a stream became (ADR-0016, ADR-0024). Absent when it isn't JSON.
     */
    readonly document?: JsonValue;
  };
  /**
   * Items the model saw in the results of the tools the profile maps, per
   * evidence collection, with the tool they came from (ADR-0026). Kept apart
   * from the returned evidence: {} without the model proxy or a mapping.
   */
  readonly seen: Readonly<Record<string, readonly SeenItem[]>>;
  /**
   * On the last turn of a simulated conversation (ADR-0028): whether its goal
   * was reached, after how many answers, and the most allowed.
   */
  readonly customer?: {
    readonly reached: boolean;
    readonly turns: number;
    readonly maxTurns: number;
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

/** An item the model saw in a tool's result (ADR-0026). */
export interface SeenItem {
  readonly tool: string;
  readonly item: EvidenceItem;
}

/** One model call the proxy tied to a turn, as checks see it (ADR-0012, ADR-0015). */
export interface ProxyCallView {
  /** Input tokens as the provider reported them, cached ones included; null when unreported. */
  readonly inputTokens: number | null;
  /**
   * The messages the call sent, with their text; null when the proxy couldn't
   * read them. A tool result names the tool it answers (ADR-0026).
   */
  readonly prompt:
    readonly { readonly role: PromptRole; readonly text: string; readonly tool?: string }[] | null;
  /** The names of the tools the call offered; null when unknown (ADR-0025). */
  readonly offered: readonly string[] | null;
  /** The tool calls the model asked for, with their arguments' text; null when unknown. */
  readonly toolCalls: readonly { readonly name: string; readonly arguments: string }[] | null;
  /** The text the model answered; null when unknown (ADR-0033). */
  readonly output: string | null;
  /** The changes the proxy made to the tool results the call sent (ADR-0043). */
  readonly toolChanges?:
    | readonly {
        readonly kind: 'inject' | 'reverse';
        readonly tool: string;
        readonly applied: boolean;
      }[]
    | undefined;
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
  /** Lower-cases with the language's rules, as a user who skips capitals writes (ADR-0045). */
  lowerCase(text: string): string;
  /**
   * Each letter with a diacritic as its base letter, case kept, as a user
   * without the language's keyboard writes (ADR-0045).
   */
  removeDiacritics(text: string): string;
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

/** A turn of a conversation yokla explore ran, as intents read it (ADR-0044). */
export interface ExploredTurn {
  readonly user: string;
  /** The route the target answered on, where the profile maps one. */
  readonly route: string | undefined;
  readonly evidence: Readonly<Record<string, readonly EvidenceItem[]>>;
}

/** A turn a domain pack writes from the target's own data and profile (ADR-0044). */
export interface IntentTurn {
  /** What the turn asks for, such as `cart`; explored cases are named after it. */
  readonly intent: string;
  readonly user: string;
  /**
   * What the turn asked, from the same data its words came from, in the
   * pack's expectation keys (ADR-0046). Core passes it on without reading it.
   */
  readonly expect?: Readonly<Record<string, unknown>>;
  /** Where the expectation came from, for the proposed case's provenance (ADR-0046). */
  readonly basis?: string;
}

/** The turns a domain pack offers yokla explore, in the pack's own phrasings (ADR-0044). */
export interface Intents {
  /** Turns that open a conversation, in a language, over at most `types` product types (ADR-0046). */
  opening(language: string, types: number): readonly IntentTurn[];
  /** Turns that go on from a conversation, after its last answer. */
  following(language: string, conversation: readonly ExploredTurn[]): readonly IntentTurn[];
}

/** A domain pack bound to one profile: its checks, with their data already loaded. */
export interface PreparedPack {
  readonly checks: readonly Check[];
  /** Turns built from the target's data, for yokla explore (ADR-0044). */
  readonly intents?: Intents;
}

export interface PackIo {
  /** Reads a text file; relative paths resolve against the profile's directory. */
  readText(path: string): string;
}

export interface DomainPack extends DomainPackSchemas {
  /** What the pack gives yokla analyze from the target's data (ADR-0047). */
  readonly analyzer?: DataAnalyzer;
  /** Aggregation per dimension; a dimension not listed uses worst-of-n. */
  readonly dimensions: Readonly<Record<string, AggregationPolicy>>;
  /** Loads the pack's data (e.g. a catalog snapshot) and binds its checks. */
  prepare(profile: Profile, io: PackIo): PreparedPack;
}
