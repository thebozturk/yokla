// Domain-neutral checks for the core expectations every case may use:
// route, answer and evidence (design §10). They run for every target.

import { coreExpectations } from '../schema/cases.ts';
import { findPhrases } from '../text/phrases.ts';
import type { Check, CheckContext, CheckFinding } from './types.ts';

function fold(context: CheckContext, text: string): string {
  return context.lang === undefined ? text.toLowerCase() : context.lang.fold(text);
}

export const routeExpected: Check = {
  id: 'route-expected',
  description: 'The turn was answered by one of the expected routes.',
  run(context) {
    const parsed = coreExpectations.route.safeParse(context.turn.expect['route']);
    if (!parsed.success) return { applicable: false, reason: 'the turn expects no route' };
    const expected = typeof parsed.data === 'string' ? [parsed.data] : parsed.data;
    const actual = context.turn.response.route;
    if (actual === undefined) {
      return {
        applicable: false,
        reason: 'the response has no route; map response.route in the profile',
      };
    }
    const ok = expected.includes(actual);
    return {
      applicable: true,
      findings: [
        {
          dimension: 'routing',
          verdict: ok ? 'pass' : 'fail',
          severity: 'medium',
          message: ok
            ? `answered by ${actual}`
            : `answered by ${actual}, expected ${expected.join(' or ')}`,
          evidence: { expected, actual },
        },
      ],
    };
  },
};

export const answerText: Check = {
  id: 'answer-text',
  description: "The answer contains, or doesn't contain, the expected phrases.",
  run(context) {
    const parsed = coreExpectations.answer.safeParse(context.turn.expect['answer']);
    if (!parsed.success)
      return { applicable: false, reason: 'the turn expects nothing of the text' };
    const text = fold(context, context.turn.response.text);
    const findings: CheckFinding[] = [];
    for (const phrase of parsed.data.contains ?? []) {
      const found = findPhrases(text, [fold(context, phrase)]).length > 0;
      findings.push({
        dimension: 'answer-content',
        verdict: found ? 'pass' : 'fail',
        severity: 'medium',
        message: found ? `contains "${phrase}"` : `doesn't contain "${phrase}"`,
      });
    }
    for (const phrase of parsed.data.notContains ?? []) {
      const found = findPhrases(text, [fold(context, phrase)]).length > 0;
      findings.push({
        dimension: 'answer-content',
        verdict: found ? 'fail' : 'pass',
        severity: 'medium',
        message: found ? `contains "${phrase}", which it must not` : `doesn't contain "${phrase}"`,
      });
    }
    if (findings.length === 0) return { applicable: false, reason: 'no phrases to look for' };
    return { applicable: true, findings };
  },
};

export const evidenceCount: Check = {
  id: 'evidence-count',
  description:
    'Evidence collections have the expected number of items and include the expected ids.',
  run(context) {
    const parsed = coreExpectations.evidence.safeParse(context.turn.expect['evidence']);
    if (!parsed.success)
      return { applicable: false, reason: 'the turn expects nothing of the evidence' };
    const findings: CheckFinding[] = [];
    for (const [name, expectation] of Object.entries(parsed.data)) {
      const items = context.turn.response.evidence[name];
      if (items === undefined) {
        return { applicable: false, reason: `the profile maps no evidence collection "${name}"` };
      }
      const count = items.length;
      if (expectation.min !== undefined) {
        findings.push({
          dimension: 'evidence',
          verdict: count >= expectation.min ? 'pass' : 'fail',
          severity: 'medium',
          message: `${name}: ${String(count)} items, expected at least ${String(expectation.min)}`,
        });
      }
      if (expectation.max !== undefined) {
        findings.push({
          dimension: 'evidence',
          verdict: count <= expectation.max ? 'pass' : 'fail',
          severity: 'medium',
          message: `${name}: ${String(count)} items, expected at most ${String(expectation.max)}`,
        });
      }
      const ids = new Set(items.map((item) => item['id']).filter((id) => typeof id === 'string'));
      for (const id of expectation.includes ?? []) {
        findings.push({
          dimension: 'evidence',
          verdict: ids.has(id) ? 'pass' : 'fail',
          severity: 'medium',
          message: ids.has(id) ? `${name} includes ${id}` : `${name} doesn't include ${id}`,
        });
      }
    }
    if (findings.length === 0) return { applicable: false, reason: 'no evidence expectations' };
    return { applicable: true, findings };
  },
};

/** The checks that run for every case, whatever the domain. */
export const CORE_CHECKS: readonly Check[] = [routeExpected, answerText, evidenceCount];
