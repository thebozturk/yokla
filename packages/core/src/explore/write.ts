// The case file yokla explore writes (ADR-0044): each kept candidate as a
// proposed case, with provenance `explore` whose evidence says where it came
// from and what it reached or failed. Those a check failed on come first.
// An intent's turn keeps what it asked, and the evidence names the data it
// came from (ADR-0046).

import { Document } from 'yaml';
import type { ExploreResult, KeptCandidate } from './search.ts';

/** Where a kept case came from, and what it reached or failed. */
export function explorationEvidence(kept: KeptCandidate): string {
  const { candidate } = kept;
  const from = candidate.from ?? 'an opening turn';
  const parts = [
    ...(kept.failed.length === 0
      ? []
      : [`failed ${kept.failed.join(', ')} on turn ${String(candidate.turns.length)}`]),
    ...(kept.reached.length === 0 ? [] : [`reached ${kept.reached.join(', ')}`]),
    ...(candidate.basis === undefined ? [] : [`expects ${candidate.basis}`]),
  ];
  return `yokla explore, ${candidate.operator} from ${from}: ${parts.join('; ')}`;
}

/** The kept candidates as a case file, those that failed a check first. */
export function exploredCaseYaml(result: ExploreResult): string {
  const ordered = [
    ...result.kept.filter((kept) => kept.failed.length > 0),
    ...result.kept.filter((kept) => kept.failed.length === 0),
  ];
  const cases = ordered.map((kept) => ({
    id: kept.id,
    suite: kept.candidate.suite,
    language: kept.candidate.language,
    turns: kept.candidate.turns,
    provenance: { source: 'explore', evidence: explorationEvidence(kept), status: 'proposed' },
  }));
  const doc = new Document({ version: 1, cases }, { aliasDuplicateObjects: false });
  doc.commentBefore = [
    ' Written by yokla explore (ADR-0044): conversations on paths the written cases',
    ' never took, or on which a check failed. A turn the domain pack wrote states only',
    ' what it asked, from the catalog (ADR-0046); the rest state no expectation. They',
    ' run, but gate only once a person reads them and sets their status to approved',
    ' (ADR-0004). See docs/guide/cli.md.',
  ].join('\n');
  return doc.toString({ lineWidth: 100 });
}
