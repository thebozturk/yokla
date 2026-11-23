// The dimensions the judge decides (ADR-0090): those no deterministic check
// can. R7b adds more. Kept apart so the schemas can name them.

export const JUDGE_DIMENSIONS = ['unsafe-advice'] as const;
export type JudgeDimension = (typeof JUDGE_DIMENSIONS)[number];
