// yokla.config.yaml (design §16, ADR-0010): settings for judging runs. Like
// the profile, it is a config file: unknown keys are errors.

import { z } from 'zod';
import { Id, Suite } from './common.ts';

const Thresholds = z.strictObject({
  maxFailures: z
    .int()
    .nonnegative()
    .optional()
    .meta({ description: 'Cases with status fail a suite may have. Default 0.' }),
  allowUnmeasured: z.boolean().optional().meta({
    description:
      'Whether a suite may have unmeasured cases and thresholds. Default false: unmeasured is never a pass.',
  }),
  latencyP50Ms: z.number().nonnegative().optional().meta({
    description: 'The median latency of the answered turns, every sample included (ADR-0014).',
  }),
  latencyP95Ms: z.number().nonnegative().optional().meta({
    description: 'The 95th percentile latency of the answered turns, every sample included.',
  }),
  costPerTurnUsd: z
    .number()
    .nonnegative()
    .optional()
    .meta({ description: 'The mean model cost of an answered turn, from the model proxy.' }),
  costUsd: z
    .number()
    .nonnegative()
    .optional()
    .meta({ description: "The suite's total model cost, from the model proxy." }),
});

export const GateConfig = Thresholds.extend({
  suites: z
    .partialRecord(Suite, Thresholds)
    .optional()
    .meta({ description: 'Overrides per suite of the thresholds above.' }),
  maxRisk: z.number().min(0).max(10).optional().meta({
    description:
      "The highest risk score an attack kind of the approved cases may have, from 0 to 10: 10 × its severity's weight × its attack success rate (ADR-0089). Off by default.",
  }),
});
export type GateConfig = z.output<typeof GateConfig>;

const Price = z
  .strictObject({
    input: z.number().nonnegative(),
    output: z.number().nonnegative(),
    cachedInput: z
      .number()
      .nonnegative()
      .optional()
      .meta({ description: 'Defaults to the input price, so cost is never understated.' }),
    cacheWrite: z
      .number()
      .nonnegative()
      .optional()
      .meta({ description: 'Defaults to the input price, so cost is never understated.' }),
  })
  .meta({ description: 'USD per million tokens.' });
export type Price = z.output<typeof Price>;

/** A model yokla calls itself, such as the simulated customer's (ADR-0028). */
const OwnModel = z.strictObject({
  kind: z.enum(['openai-compatible', 'anthropic', 'gemini']),
  auth: z.enum(['api-key', 'bearer']).default('api-key').meta({
    description:
      'For gemini: the key in x-goog-api-key, or as an Authorization bearer token, as Vertex AI takes it (ADR-0032). The other kinds send it in their own header.',
  }),
  url: z
    .url({ protocol: /^https?$/u })
    .meta({ description: 'The base url, e.g. http://127.0.0.1:11434/v1 for a local model.' }),
  model: z.string().min(1),
  apiKeyEnv: z
    .string()
    .min(1)
    .optional()
    .meta({ description: 'The environment variable that holds the API key, if one is needed.' }),
  temperature: z.number().min(0).max(2).default(0),
  // A model that reasons spends output tokens on it (ADR-0051).
  maxTokens: z.int().min(1).max(64_000).default(400),
  timeoutMs: z.int().min(1).max(600_000).default(60_000),
  price: Price.optional().meta({
    description: 'USD per million tokens. Without it, the calls have no cost, never 0.',
  }),
});
export type OwnModel = z.output<typeof OwnModel>;

/** The analyzer's model: its replies list many values, so it answers at length (ADR-0072). */
const AnalyzerModel = OwnModel.extend({
  maxTokens: z.int().min(1).max(64_000).default(2000),
});

export const YoklaConfig = z.strictObject({
  version: z.literal(1),
  gate: GateConfig.default({}),
  prices: z
    .record(Id, z.record(z.string().min(1), Price))
    .default({})
    .meta({
      description:
        'Per upstream id, per model as the provider reports it (ADR-0012). A model without a price has no cost.',
    }),
  models: z
    .strictObject({
      customer: OwnModel.optional().meta({
        description:
          'The model that plays a simulated customer (ADR-0028). A hosted model receives the conversation, the target answers included.',
      }),
      transform: OwnModel.optional().meta({
        description:
          "The model that writes yokla run's paraphrase and code-switch transforms (ADR-0059). A hosted model receives the cases' messages. It needs a price, 0 for a local model, so --max-cost can be enforced.",
      }),
      attacker: OwnModel.optional().meta({
        description:
          "The model yokla run --attacker uses to adapt the redteam cases' attacks (ADR-0087). A hosted model receives the attacks and the target's answers. It needs a price, 0 for a local model, so --max-cost can be enforced.",
      }),
      analyzer: AnalyzerModel.optional().meta({
        description:
          "The model yokla analyze asks for values in the target's docs, prompts and code (ADR-0049). A hosted model receives those files' text. It needs a price, 0 for a local model, so --max-cost can be enforced.",
      }),
    })
    .default({}),
  checks: z
    .array(z.string().min(1))
    .default([])
    .refine((paths) => new Set(paths).size === paths.length, {
      message: 'a module is listed twice',
    })
    .meta({
      description:
        'Check modules to load, relative to this file: JavaScript, or TypeScript Node.js runs as it is. Each default-exports a check by contract version 1 (ADR-0030).',
    }),
  plan: z
    .strictObject({
      upperBoundFactor: z
        .number()
        .min(1)
        .default(2)
        .meta({ description: 'yokla plan prints the estimate times this as the upper bound.' }),
    })
    .default({ upperBoundFactor: 2 }),
});
export type YoklaConfig = z.output<typeof YoklaConfig>;
