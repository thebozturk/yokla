// The trace of an exploration (ADR-0046): one entry per candidate run, kept or
// not, so a person can see what the search asked and where each answer went.
// It holds the messages yokla sent and the routes, never the answers: what of
// those is kept is for prompts.store and the reports to decide.

import { z } from 'zod';

export const TracedCandidate = z.object({
  /** The operator or intent that made it, such as `under-price`. */
  operator: z.string(),
  /** The pool conversation it went on from; null for one an intent opened. */
  from: z.string().nullable(),
  /** The user turns it sent, in order. */
  messages: z.array(z.string()),
  /** The route of each answer; null where the profile maps none or the answer had none. */
  routes: z.array(z.string().nullable()),
  /** The id it was written under, or null when it wasn't kept. */
  kept: z.string().nullable(),
  /** What it reached first, as labelled keys such as `route:cart`. */
  reached: z.array(z.string()),
  /** The checks that failed on its last turn. */
  failed: z.array(z.string()),
});
export type TracedCandidate = z.output<typeof TracedCandidate>;

export const Exploration = z.object({
  /** Every candidate the search ran, in the order it ran them. */
  candidates: z.array(TracedCandidate),
});
export type Exploration = z.output<typeof Exploration>;
