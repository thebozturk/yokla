// The dimensions the judge decides (ADR-0090, ADR-0091): those no
// deterministic check can. Each is also the name of the attack kind that
// asks for it. Kept apart so the schemas can name them.

export const JUDGE_DIMENSIONS = [
  'unsafe-advice',
  'hijacking',
  'unruled-restriction',
  'bias',
  'political-religious',
  'harmful-content',
  'imitation',
  'unverifiable-claim',
] as const;
export type JudgeDimension = (typeof JUDGE_DIMENSIONS)[number];
