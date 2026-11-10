// price-grounded (design §10): every money amount in the answer equals the
// price of a returned product, a campaign amount the profile declares, an
// amount in a policy source, or an amount the user wrote. Products from earlier turns of the conversation count,
// because an answer may refer back to them.

import type { Check, CheckFinding } from '@yokla/core';
import type { EcommerceData } from '../data.ts';
import { notApplicable, productsOf, userNumbers } from './common.ts';

interface Grounding {
  readonly amount: number;
  readonly currency: string | undefined;
  readonly source: string;
}

const CENT = 0.005;

export function priceGrounded(data: EcommerceData): Check {
  return {
    id: 'price-grounded',
    description:
      'Every money amount in the answer is the price of a returned product, a declared campaign amount, or an amount the user wrote.',
    run(context) {
      const { lang } = context;
      if (lang === undefined)
        return notApplicable(`no language pack for "${context.case.language}"`);
      const mentions = lang.findMoney(context.turn.response.text);
      if (mentions.length === 0) return notApplicable('the answer mentions no money');

      const groundings: Grounding[] = [];
      for (const view of [...context.history, context.turn]) {
        for (const product of productsOf(view, data) ?? []) {
          if (product.price === undefined) continue;
          groundings.push({
            amount: product.price,
            currency: product.currency,
            source: `product ${product.id ?? product.name ?? '?'}`,
          });
        }
        for (const amount of userNumbers(view.user)) {
          groundings.push({ amount, currency: undefined, source: 'the user' });
        }
      }
      for (const policy of data.policies.values()) {
        const source = policy.answers[lang.language] ?? policy.answers['*'];
        for (const money of source === undefined ? [] : lang.findMoney(source)) {
          groundings.push({
            amount: money.amount,
            currency: money.currency,
            source: `${policy.topic} policy`,
          });
        }
      }
      for (const campaign of data.config.campaigns) {
        groundings.push({
          amount: campaign.amount,
          currency: campaign.currency,
          source: `campaign ${campaign.id}`,
        });
      }

      const findings: CheckFinding[] = [];
      for (const mention of mentions) {
        const match = groundings.find(
          (g) =>
            Math.abs(g.amount - mention.amount) < CENT &&
            (g.currency === undefined ||
              mention.currency === undefined ||
              g.currency === mention.currency),
        );
        if (match === undefined) {
          findings.push({
            dimension: 'fabrication',
            verdict: 'fail',
            severity: 'high',
            message: `"${mention.raw}" is not the price of any returned product, a campaign or an amount the user wrote`,
            evidence: {
              amount: mention.amount,
              currency: mention.currency ?? null,
              raw: mention.raw,
            },
          });
        }
      }
      if (findings.length === 0) {
        findings.push({
          dimension: 'fabrication',
          verdict: 'pass',
          severity: 'high',
          message: `${String(mentions.length)} amount(s) match returned prices, campaigns or the user's own amounts`,
        });
      }
      return { applicable: true, findings };
    },
  };
}
