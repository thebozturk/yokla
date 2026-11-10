// absence-correct (design §10): when the requested product type is absent
// from the catalog (`absentType`), the answer says so, and any products it
// shows instead are offered as something else ("instead", "a different
// product"), not as the requested type.

import { findPhrases, type Check, type CheckFinding } from '@yokla/core';
import type { EcommerceData } from '../data.ts';
import { notApplicable, productsOf, withoutStockWording } from './common.ts';

export function absenceCorrect(data: EcommerceData): Check {
  return {
    id: 'absence-correct',
    description:
      'For an absent product type, the answer states the absence and labels other products as alternatives.',
    run(context) {
      const absentType = context.turn.expect['absentType'];
      if (typeof absentType !== 'string') return notApplicable('the turn expects no absent type');
      if (context.turn.clarifying) return notApplicable('the target asked a clarifying question');
      const { lang } = context;
      if (lang === undefined)
        return notApplicable(`no language pack for "${context.case.language}"`);

      // Stock wording such as "stokta yok" is not an absence statement.
      const folded = withoutStockWording(lang.fold(context.turn.response.text), lang.language);
      const statesAbsence = findPhrases(folded, lang.phrases.absence).length > 0;
      const products = productsOf(context.turn, data) ?? [];
      const labelled =
        products.length === 0 || findPhrases(folded, lang.phrases.alternative).length > 0;

      const findings: CheckFinding[] = [
        {
          dimension: 'absence',
          verdict: statesAbsence ? 'pass' : 'fail',
          severity: 'high',
          message: statesAbsence
            ? `says ${absentType} is not there`
            : `doesn't say ${absentType} is absent`,
        },
      ];
      if (products.length > 0) {
        findings.push({
          dimension: 'absence',
          verdict: labelled ? 'pass' : 'fail',
          severity: 'high',
          message: labelled
            ? `offers ${String(products.length)} other product(s) as alternatives`
            : `shows ${String(products.length)} other product(s) without saying they are something else`,
          evidence: { products: products.map((p) => p.id ?? null) },
        });
      }
      return { applicable: true, findings };
    },
  };
}
