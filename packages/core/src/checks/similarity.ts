// answer-similarity (ADR-0030): the answer's wording stays close to reference
// answers, or away from them. The score is the cosine similarity of character
// trigrams, after the language pack's folding, rounded to three decimals; the
// bound is compared with the score as reported, so a threshold set from real
// answers holds as read. It measures wording, not meaning.

import { coreExpectations } from '../schema/cases.ts';
import { textSimilarity } from '../text/similarity.ts';
import { fold } from './fold.ts';
import type { Check, CheckFinding } from './types.ts';

/** The score as reported: three decimals. */
function rounded(score: number): number {
  return Math.round(score * 1000) / 1000;
}

function finding(pass: boolean, message: string, evidence: CheckFinding['evidence']): CheckFinding {
  return {
    dimension: 'similarity',
    verdict: pass ? 'pass' : 'fail',
    severity: 'medium',
    message,
    ...(evidence === undefined ? {} : { evidence }),
  };
}

export const answerSimilarity: Check = {
  id: 'answer-similarity',
  description: "The answer's wording stays close to reference answers, or away from them.",
  run(context) {
    const parsed = coreExpectations.similar.safeParse(context.turn.expect['similar']);
    if (!parsed.success) {
      return { applicable: false, reason: 'the turn compares the answer with no reference' };
    }
    const { to, min, max } = parsed.data;
    const answer = fold(context, context.turn.response.text);
    const scores = to.map((reference) => rounded(textSimilarity(answer, fold(context, reference))));
    const best = Math.max(...scores);
    // The reference the answer is closest to, counted from 1.
    const closest = scores.indexOf(best) + 1;
    const evidence = { scores, best };
    const findings: CheckFinding[] = [];
    if (min !== undefined) {
      findings.push(
        best >= min
          ? finding(
              true,
              `similar to reference ${String(closest)}: ${String(best)} ≥ ${String(min)}`,
              { ...evidence, min },
            )
          : finding(
              false,
              `not similar enough to any reference: best ${String(best)} < ${String(min)}`,
              { ...evidence, min },
            ),
      );
    }
    if (max !== undefined) {
      findings.push(
        best <= max
          ? finding(
              true,
              `not too similar to any reference: best ${String(best)} ≤ ${String(max)}`,
              { ...evidence, max },
            )
          : finding(
              false,
              `too similar to reference ${String(closest)}: ${String(best)} > ${String(max)}`,
              { ...evidence, max },
            ),
      );
    }
    return { applicable: true, findings };
  },
};
