// price-grounded (design §10): every money amount in the answer equals the
// price of a returned product, a campaign amount the profile declares, an
// amount in a policy source, or an amount the user wrote. Products from earlier turns of the conversation count,
// because an answer may refer back to them. The check applies only when the
// evidence has an authoritative price: with no priced product in the
// conversation, as when the profile maps no evidence, yokla can't tell a real
// price from an invented one.

import { findQuantities, type Check, type CheckFinding } from '@yokla/core';
import type { EcommerceData } from '../data.ts';
import { notApplicable, productsOf, segments, userNumbers } from './common.ts';

interface Grounding {
  readonly amount: number;
  readonly currency: string | undefined;
  readonly source: string;
}

const CENT = 0.005;

/** A number, or a decimal string such as "24.00". */
function amountOf(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/u.test(value.trim())) return Number(value);
  return undefined;
}

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

      const views = [...context.history, context.turn];
      const groundings: Grounding[] = views.flatMap((view) =>
        (productsOf(view, data) ?? []).flatMap((product) =>
          product.price === undefined
            ? []
            : [
                {
                  amount: product.price,
                  currency: product.currency,
                  source: `product ${product.id ?? product.name ?? '?'}`,
                },
              ],
        ),
      );
      if (groundings.length === 0) {
        return notApplicable('no product in the conversation has a price');
      }
      // Only product prices are multiplied by a stated quantity (ADR-0021).
      const prices = [...groundings];
      for (const view of views) {
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
      // Price sources (ADR-0020): amounts the conversation showed, and amounts in data files.
      for (const source of data.config.priceSources) {
        if (!('evidence' in source)) continue;
        for (const view of views) {
          for (const item of view.response.evidence[source.evidence] ?? []) {
            const currency = typeof item['currency'] === 'string' ? item['currency'] : undefined;
            for (const field of source.fields) {
              const amount = amountOf(item[field]);
              if (amount === undefined) continue;
              groundings.push({ amount, currency, source: `${source.evidence}.${field}` });
            }
          }
        }
      }
      for (const { amount, file } of data.sourceAmounts) {
        groundings.push({ amount, currency: undefined, source: file });
      }

      const findings: CheckFinding[] = [];
      const multiples: string[] = [];
      for (const segment of segments(context.turn.response.text)) {
        const quantities = findQuantities(segment, lang);
        for (const mention of lang.findMoney(segment)) {
          const sameCurrency = (g: Grounding) =>
            g.currency === undefined ||
            mention.currency === undefined ||
            g.currency === mention.currency;
          const match = groundings.find(
            (g) => Math.abs(g.amount - mention.amount) < CENT && sameCurrency(g),
          );
          if (match !== undefined) continue;
          // A price times a quantity the same sentence states, such as "$356 for four".
          const multiple = prices
            .filter(sameCurrency)
            .flatMap((g) => quantities.map((q) => ({ g, q })))
            .find(({ g, q }) => Math.abs(g.amount * q.value - mention.amount) < CENT);
          if (multiple !== undefined) {
            const { g, q } = multiple;
            const price =
              g.currency === undefined ? String(g.amount) : lang.formatMoney(g.amount, g.currency);
            multiples.push(`"${mention.raw}" = ${String(q.value)} × ${price} (${g.source})`);
            continue;
          }
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
          message: `${String(mentions.length)} amount(s) match returned prices, campaigns or the user's own amounts${multiples.length === 0 ? '' : `; ${multiples.join('; ')}`}`,
        });
      }
      return { applicable: true, findings };
    },
  };
}
