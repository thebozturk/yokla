// policy-claim (design §10): a concrete policy claim (a duration, "free", an
// amount) needs a source and must match it. A sentence that names a policy
// topic and makes such a claim is a claim about that topic; when a turn names
// its topic with `policyTopic`, every concrete claim in the answer is about it.
// Sentences without a concrete claim, such as "I can't verify shipping
// terms", make no claim (narrow detectors, design §10). The check applies only
// when the profile lists policies: then a topic listed without a source, or a
// neverFabricate topic left out, can back no claim. A profile that lists none
// gives the check nothing to judge a claim against.

import {
  findPhrases,
  type Check,
  type CheckFinding,
  type DurationMention,
  type FindingSubject,
  type LanguagePack,
  type MoneyMention,
} from '@yokla/core';
import type { EcommerceData } from '../data.ts';
import { CORRECTION_NEGATIONS, POLICY_TOPIC_PHRASES } from '../lexicon.ts';
import { FACT_KINDS } from '../schema.ts';
import { notApplicable, segments } from './common.ts';

interface Claims {
  readonly durations: string[];
  readonly free: boolean;
  readonly amounts: number[];
  readonly raw: string[];
  readonly mentions: {
    readonly durations: readonly DurationMention[];
    readonly money: readonly MoneyMention[];
    readonly free: readonly string[];
  };
}

/** How many words on either side of a value a correction's negation may stand (ADR-0082). */
const CORRECTION_WINDOW = 4;

/**
 * Whether a negation stands within a few words of text[start, end) in its
 * sentence: "90 gün değil", "not 90 days" (ADR-0082).
 */
function negatedNear(text: string, start: number, end: number, lang: LanguagePack): boolean {
  const negations = CORRECTION_NEGATIONS[lang.language];
  if (negations === undefined) return false;
  const words = (part: string) =>
    lang
      .fold(part)
      .split(/\s+/u)
      .map((word) => word.replaceAll(/^[^\p{L}']+|[^\p{L}']+$/gu, ''))
      .filter((word) => word !== '');
  const near = [
    ...words(text.slice(0, start)).slice(-CORRECTION_WINDOW),
    ...words(text.slice(end)).slice(0, CORRECTION_WINDOW),
  ];
  return near.some(
    (word) =>
      negations.words.includes(word) || negations.endings.some((ending) => word.endsWith(ending)),
  );
}

/**
 * The claims of a text. With the user's message, a duration or amount the
 * user wrote that the sentence negates near it is a correction, not a claim
 * (ADR-0082).
 */
function claimsIn(text: string, lang: LanguagePack, user?: string): Claims {
  const said = user === undefined ? undefined : claimsIn(user, lang);
  const corrected = (mention: { start: number; end: number }) =>
    negatedNear(text, mention.start, mention.end, lang);
  const durations = lang
    .findDurations(text)
    .filter(
      (d) =>
        said === undefined ||
        !said.durations.includes(`${String(d.amount)} ${d.unit}`) ||
        !corrected(d),
    );
  const money = lang
    .findMoney(text)
    .filter(
      (m) =>
        said === undefined ||
        !said.amounts.some((a) => Math.abs(a - m.amount) < 0.005) ||
        !corrected(m),
    );
  const free = findPhrases(lang.fold(text), lang.phrases.free);
  return {
    durations: durations.map((d) => `${String(d.amount)} ${d.unit}`),
    free: free.length > 0,
    amounts: money.map((m) => m.amount),
    raw: [...durations.map((d) => d.raw), ...money.map((m) => m.raw), ...free.map((f) => f.phrase)],
    mentions: { durations, money, free: free.map((f) => f.phrase) },
  };
}

/**
 * The first unsupported claim, as the value a failing finding is about
 * (ADR-0033): a duration, else an amount, else the "free" wording.
 */
function subjectOf(claims: Claims, unsupported: readonly string[]): FindingSubject | undefined {
  const duration = claims.mentions.durations.find((d) =>
    unsupported.includes(`${String(d.amount)} ${d.unit}`),
  );
  if (duration !== undefined) {
    return { kind: 'duration', amount: duration.amount, unit: duration.unit };
  }
  const money = claims.mentions.money.find((m) => unsupported.includes(String(m.amount)));
  if (money !== undefined) {
    return {
      kind: 'money',
      amount: money.amount,
      ...(money.currency === undefined ? {} : { currency: money.currency }),
    };
  }
  const free = claims.mentions.free[0];
  return free !== undefined && unsupported.includes('free')
    ? { kind: 'text', text: free }
    : undefined;
}

function isFactKind(topic: string): boolean {
  return FACT_KINDS.some((kind) => kind === topic);
}

export function policyClaim(data: EcommerceData): Check {
  return {
    id: 'policy-claim',
    description: 'Concrete policy claims (durations, "free", amounts) have a source and match it.',
    run(context) {
      const { lang } = context;
      if (lang === undefined)
        return notApplicable(`no language pack for "${context.case.language}"`);
      if (data.policies.size === 0) return notApplicable('the profile lists no policies');
      const lexicon = POLICY_TOPIC_PHRASES[lang.language] ?? {};
      const expected = context.turn.expect['policyTopic'];
      const declared = typeof expected === 'string' ? expected : undefined;

      const findings: CheckFinding[] = [];
      let mentioned = declared !== undefined;
      for (const segment of segments(context.turn.response.text)) {
        const folded = lang.fold(segment);
        const topics = Object.keys(lexicon).filter(
          (topic) => findPhrases(folded, lexicon[topic] ?? []).length > 0,
        );
        if (topics.length > 0) mentioned = true;
        if (topics.length === 0 && declared !== undefined) topics.push(declared);
        const claims = claimsIn(segment, lang, context.turn.user);
        if (claims.raw.length === 0) continue;

        // A sentence may name several topics ("return within 14 days of delivery"):
        // the claim stands if any named topic's source supports it.
        const verdicts: { topic: string; unsupported: string[]; sourced: boolean }[] = [];
        for (const topic of topics) {
          const policy = data.policies.get(topic);
          if (
            policy === undefined &&
            !(isFactKind(topic) && data.config.neverFabricate.some((k) => k === topic))
          ) {
            continue;
          }
          const source = policy?.answers[lang.language] ?? policy?.answers['*'];
          if (source === undefined && Object.keys(policy?.answers ?? {}).length > 0) continue; // Only in another language.
          if (source === undefined) {
            verdicts.push({ topic, unsupported: claims.raw, sourced: false });
            continue;
          }
          const supported = claimsIn(source, lang);
          verdicts.push({
            topic,
            sourced: true,
            unsupported: [
              ...claims.durations.filter((d) => !supported.durations.includes(d)),
              ...(claims.free && !supported.free ? ['free'] : []),
              ...claims.amounts
                .filter((a) => !supported.amounts.some((x) => Math.abs(x - a) < 0.005))
                .map(String),
            ],
          });
        }
        if (verdicts.length === 0) continue;
        const backing = verdicts.find((v) => v.sourced && v.unsupported.length === 0);
        if (backing !== undefined) {
          findings.push({
            dimension: 'fabrication',
            verdict: 'pass',
            severity: 'high',
            message: `${backing.topic}: ${claims.raw.join(', ')} match the source`,
          });
          continue;
        }
        const sourced = verdicts.find((v) => v.sourced);
        // Without a source, every claim is unsupported: the first one is the subject.
        const subject = subjectOf(
          claims,
          sourced?.unsupported ?? [
            ...claims.durations,
            ...claims.amounts.map(String),
            ...(claims.free ? ['free'] : []),
          ],
        );
        findings.push({
          dimension: 'fabrication',
          verdict: 'fail',
          severity: 'high',
          message:
            sourced === undefined
              ? `claims ${claims.raw.join(', ')} about ${verdicts.map((v) => v.topic).join(' / ')}, which has no source`
              : `${sourced.topic}: ${sourced.unsupported.join(', ')} not in the source`,
          evidence: {
            topic: (sourced ?? verdicts[0])?.topic ?? null,
            unsupported: sourced?.unsupported ?? claims.raw,
          },
          ...(subject === undefined ? {} : { subject }),
        });
      }

      if (!mentioned) return notApplicable('the answer mentions no policy topic');
      if (findings.length === 0) {
        findings.push({
          dimension: 'fabrication',
          verdict: 'pass',
          severity: 'high',
          message: 'no concrete policy claims',
        });
      }
      return { applicable: true, findings };
    },
  };
}
