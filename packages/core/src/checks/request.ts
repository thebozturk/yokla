// request-handled (ADR-0075): a turn that says what kind of request it is
// (`expect.request`) is judged as that kind, not as a product search.
// - No kind gets evidence items: chit-chat gets no cards, even on a turn the
//   target answered with a clarifying question.
// - No kind gets a failed-search sentence: an absence phrase of the language
//   pack, unless the answer also points to a person or a channel.
// - A handoff gets that pointer: a deflection phrase of the language pack, or
//   one of the profile's contactPhrases.

import { coreExpectations, type RequestKind } from '../schema/cases.ts';
import { findPhrases } from '../text/phrases.ts';
import type { Check, CheckFinding } from './types.ts';

const DIMENSION = 'request';

function finding(pass: boolean, severity: CheckFinding['severity'], message: string): CheckFinding {
  return { dimension: DIMENSION, verdict: pass ? 'pass' : 'fail', severity, message };
}

/** "3 products, 1 cart" */
function itemCounts(evidence: Readonly<Record<string, readonly unknown[]>>): string {
  return Object.entries(evidence)
    .filter(([, items]) => items.length > 0)
    .map(([name, items]) => `${String(items.length)} ${name}`)
    .join(', ');
}

export const requestHandled: Check = {
  id: 'request-handled',
  description:
    'A turn marked chitchat, handoff or support gets no evidence items and no failed-search sentence; a handoff is told how to reach a person.',
  run(context) {
    const parsed = coreExpectations.request.safeParse(context.turn.expect['request']);
    if (!parsed.success) return { applicable: false, reason: 'the turn says no kind of request' };
    const kind: RequestKind = parsed.data;

    const items = Object.values(context.turn.response.evidence).reduce(
      (sum, list) => sum + list.length,
      0,
    );
    const findings: CheckFinding[] = [
      finding(
        items === 0,
        'high',
        items === 0
          ? `no evidence items on a ${kind} turn`
          : `answered a ${kind} turn with evidence items: ${itemCounts(context.turn.response.evidence)}`,
      ),
    ];

    const { lang } = context;
    if (lang === undefined) {
      return {
        applicable: true,
        findings,
        unmeasured: [
          {
            dimension: DIMENSION,
            reason: `no language pack for "${context.case.language}" to read the answer's wording with`,
          },
        ],
      };
    }
    const text = lang.fold(context.turn.response.text);
    const contact = (context.profile.target.response.contactPhrases ?? []).map((phrase) =>
      lang.fold(phrase),
    );
    const pointer = findPhrases(text, [...lang.phrases.deflection, ...contact])[0];
    const absence = findPhrases(text, lang.phrases.absence)[0];

    if (absence !== undefined && pointer === undefined) {
      findings.push(
        finding(
          false,
          'high',
          `answered a ${kind} turn with a failed-search sentence ("${absence.phrase}")`,
        ),
      );
    } else {
      findings.push(finding(true, 'high', `no failed-search sentence on a ${kind} turn`));
    }

    if (kind === 'handoff') {
      findings.push(
        finding(
          pointer !== undefined,
          'medium',
          pointer === undefined
            ? 'the user asked for a person and was not told how to reach one'
            : `points the user to a person or a channel ("${pointer.phrase}")`,
        ),
      );
    }
    return { applicable: true, findings };
  },
};
