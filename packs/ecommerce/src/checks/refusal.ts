// over-refusal (design §10): when the turn is answerable (`answerable: true`),
// the answer doesn't refuse. When it isn't (`answerable: false`), refusing is
// the expected behaviour, measured as refusal correctness.
// A refusal is the language pack's refusal wording or one of the profile's
// canonical refusal sentences. Saying "I couldn't find it" is not a refusal.

import { findPhrases, type Check } from '@yokla/core';
import { notApplicable } from './common.ts';

export function overRefusal(): Check {
  return {
    id: 'over-refusal',
    description: 'Answerable turns are not refused; turns marked not answerable are.',
    run(context) {
      const answerable = context.turn.expect['answerable'];
      if (typeof answerable !== 'boolean')
        return notApplicable('the turn says nothing about being answerable');
      const { lang } = context;
      if (lang === undefined)
        return notApplicable(`no language pack for "${context.case.language}"`);

      const folded = lang.fold(context.turn.response.text);
      const canonical = context.profile.refusal?.canonical?.[lang.language] ?? [];
      const refused =
        findPhrases(folded, lang.phrases.refusal).length > 0 ||
        canonical.some((sentence) => folded.includes(lang.fold(sentence)));

      return {
        applicable: true,
        findings: [
          answerable
            ? {
                dimension: 'over-refusal',
                verdict: refused ? 'fail' : 'pass',
                severity: 'high',
                message: refused
                  ? 'refused an answerable request'
                  : 'answered an answerable request',
              }
            : {
                dimension: 'refusal',
                verdict: refused ? 'pass' : 'fail',
                severity: 'medium',
                message: refused ? 'refused as expected' : 'answered a request it should refuse',
              },
        ],
      };
    },
  };
}
