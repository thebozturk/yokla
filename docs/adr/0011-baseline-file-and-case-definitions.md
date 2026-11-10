# 0011. The baseline file, and cases compared only while their definition holds

Status: Accepted · Date: 2026-11-10 · Amends 0010

## Context

ADR-0010 breaks the gate when a case that passed in the baseline no longer
passes. The first real use showed a gap. A case got a stricter expectation
(a product type to match), its new check failed, and the gate reported a
regression. The target hadn't changed; the case had. A results file doesn't
record what a case asked for, so the gate couldn't tell the two apart.

Design §13 also says that updating the baseline is an explicit command whose
diff is reviewed. A results file is a poor baseline to review:
- it is large;
- it holds the target's answers, which may be private data (design §15);
- its order and timings change on every run.

## Decision

- **Results record each case's definition.** `results.v1` gains an optional
  `definitionSha256` on every case. It is the SHA-256 of the canonical JSON of
  what decides the case's verdict:
  - the language,
  - the turns: messages, extra request content and expectations,
  - the sample count and the check selection.

  Title, suite, tags, provenance and the `knownGap` marker are left out. A
  marker documents a gap; it must not make a case look changed.
- **A case is compared only while its definition holds.** When a case's
  definition differs from the baseline's, the gate doesn't compare it and
  reports "changed since the baseline". This amends ADR-0010's regression rule.
  Its own status still counts against the thresholds, so a changed case that
  fails is still caught.
- **The baseline is its own file, `yokla.baseline/v1`.** It holds:
  - where it came from: the run id, its start time, the yokla version and the
    profile's target and hash;
  - per case, sorted by id: the id, suite, status and definition hash.

  It holds no answers, evidence or timings, so it can be committed and its diff
  reviewed. A Zod schema in `core` defines it, and its JSON Schema is generated
  (ADR-0008).
- **`yokla baseline --results <file>`** writes the baseline, by default
  `yokla.baseline.json`.
  - It prints what changed since the previous baseline: new and removed cases,
    status changes and changed definitions.
  - `--dry-run` prints the changes without writing.
  - It refuses a run that the gate can't judge (ADR-0010).
- **`yokla gate --baseline`** reads a baseline file, or a results file, which
  it reduces to a baseline first. Without `--baseline`, the gate uses
  `yokla.baseline.json` from the working directory when it exists, and says so.

## Consequences

- **Making a case stricter isn't a regression.** Weakening a case isn't one
  either. Both show up as changed cases in the gate's report and in the
  reviewed baseline diff.
- **Changes outside the cases aren't tracked per case.** Examples are the
  profile, the catalog snapshot and the packs. The profile hash is recorded,
  and the gate notes a baseline from another profile. Data files may be
  tracked the same way later.
- **Results written before this change have no definition hash.** Their cases
  are compared as ADR-0010 says.

## Alternatives considered

- **Use a results file as the baseline.** It is simpler, but it is large, holds
  private answers and is hard to review. It is still accepted as input.
- **Hash the whole case, marker included.** Rejected: marking a passing case
  as a known gap would then hide its regression.
- **Compare changed cases anyway.** This is the behaviour ADR-0010 had, which
  reported a stricter case as a regression of the target. Rejected.
