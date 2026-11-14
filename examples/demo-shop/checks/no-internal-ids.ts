// A check the demo-shop's team writes for itself (ADR-0030), by yokla's check
// contract version 1: an answer never shows an internal catalog id, such as
// TNT-001. yokla loads it because yokla.config.yaml names it; it imports
// nothing from yokla, so the demo-shop stays apart from it.

interface Turn {
  readonly answer: { readonly text: string };
}

/** Catalog ids: three capital letters, a dash and three digits. */
const CATALOG_ID = /\b[A-Z]{3}-\d{3}\b/u;

export default {
  api: 1,
  id: 'no-internal-ids',
  description: 'The answer shows no internal catalog id.',
  dimension: 'internal-ids',
  run(turn: Turn) {
    const found = CATALOG_ID.exec(turn.answer.text);
    return {
      findings: [
        found === null
          ? { verdict: 'pass', message: 'shows no catalog id' }
          : { verdict: 'fail', message: `shows the catalog id ${found[0]}`, severity: 'medium' },
      ],
    };
  },
};
