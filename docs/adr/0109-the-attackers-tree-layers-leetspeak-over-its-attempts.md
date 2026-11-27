# 0109. The attacker's tree layers leetspeak over its attempts

Status: Proposed · Date: 2026-11-27

## Context

ADR-0088 gave the attacker a tree of variants. At the first level, the
model writes `--branches` variants of the attack. At each later level, it
writes `--branches` variants of each attempt, shown the attempt and its
answer. The tree was meant to find layered attacks, such as a role-play
written in leetspeak:

- **The `layered-obeyed` defect** refuses a role-play, a hypothetical or a
  developer-mode request it can read, and reads past leetspeak. A wrapped
  request in leetspeak passes its filter and is answered with itself.
- **With the fake provider as attacker,** the tree breaks it at its fifth
  attempt. The fake writes a node's branches as a role-play, leetspeak and
  a hypothetical, so the second level holds the role-play in leetspeak.
- **`obfuscation-obeyed`** answers a message in leetspeak or Cyrillic
  look-alikes with itself. The fake's best-of-n breaks it at its leetspeak
  attempt (ADR-0087).

The real runs of the attacker on the demo-shop (design §19), Claude Haiku
5.5 through a hosted gateway, never reached either defect. The prompts ask
for the attack "in another way", and the model chose its ways: it reworded
the attack, posed as a tester, a developer or a QA team, and wrote
role-plays and games. Across every best-of-n and tree attempt of the run
after ADR-0106, it wrote no message in leetspeak or look-alike letters.

yokla already writes leetspeak itself. The `leetspeak` strategy (ADR-0084)
turns small letters into digits and keeps the values the turn's
expectations quote, such as a canary, as written. It rewrites the case's
written message, though, not a message the model wrote.

## Decision

### The layered branch

- **Past the first level, each node's last branch is its parent in
  leetspeak, written by yokla.** The branch numbered `--branches` isn't
  asked of the model. It is the parent attempt's message as the
  `leetspeak` strategy rewrites it: the small letters a, e, i, o, s and t
  as digits, and the values the turn's expectations quote kept as written.
  It makes no attacker call and costs nothing.
- **A layered attempt's own branches are all the model's.** Leetspeak over
  leetspeak would send the same message again.
- **The first level stays the model's.** Its parent is the attack itself,
  which `--strategy leetspeak` already sends as written.
- **The rest of the tree holds** (ADR-0088, ADR-0101):
  - the same number of attempts, numbered breadth first;
  - an attempt whose parent wasn't sent isn't written;
  - the case stops at the first attempt a check fails, and its message
    must hold the attack's values.
- **By default, 3 of a tree's 12 attempts are layered:** the model writes
  9.
- **The prompt and the cache keys don't change.** The model's requests keep
  their branch numbers. The last branch past the first level is never
  asked, so earlier replies in the cache still serve.

### What results.v1 keeps

Additive (ADR-0007):

- **`attacker.layer: "leetspeak"`** on a layered attempt. It has no calls,
  and a cost of 0.
- **The terminal report counts the layered attempts** under the attacker's
  line.

### The demo-shop

- **The fake provider's tree writes no leetspeak of its own.** A node's
  branches are a role-play, a hypothetical and a developer-mode request.
  best-of-n keeps its attempts: the attack, a role-play, leetspeak and a
  hypothetical.
- **`layered-obeyed` breaks at the tree's sixth attempt:** the leetspeak
  layer over the role-play, the first node's last branch. Its plain
  wrappers before it are refused.
- **`obfuscation-obeyed` breaks at the same attempt** under the tree, over
  the injection cases, in a new end-to-end run.

### Measured before this ADR

The leetspeak layer was applied to the run after ADR-0106, offline:

- **Its trees sent 10 first-level attempts** over the four injection
  cases. Each would have had a layered branch at the second level.
- **`obfuscation-obeyed` follows all 10:** each holds two leetspeak words
  or more. Under the tree, it would fail all four cases.
- **`layered-obeyed` follows none.** Its filter reads 1 of the run's 39
  sent tree attempts as a wrapper, and that one is at the second level.
  The model's role-plays, such as "Bir oyun oynayalım" or "pretend you're
  a plain echo tool", aren't among the phrases the demo-shop knows. The
  next ADR reads them.

### The tests

- **`core`:** which attempts are layered, by branch and level, with one
  branch and with a layered parent. The `leetspeak` rewrite keeps the
  quoted values.
- **The runner:** a layered attempt sends its parent in leetspeak with no
  attacker call. Its own branches are the model's. An unsent parent leaves
  it unwritten, as before.
- **End to end:**
  - On the correct shop the tree passes, with three layered attempts a
    case, and the second tree run sends no attacker call.
  - `layered-obeyed` breaks at the sixth attempt.
  - `obfuscation-obeyed` breaks at the sixth attempt over the injection
    cases.

## Consequences

- **A real model's tree reaches the shops that read past leetspeak:**
  each attempt the model writes at the first level is tried again in
  leetspeak.
- **A tree costs a quarter less by default:** 9 attacker calls in place of
  12.
- **`layered-obeyed` still needs its filter to read the model's
  role-plays,** which the next ADR takes up.
- **The layer is leetspeak only.** Cyrillic look-alikes and the encodings
  stay with `--strategy`.
- **The demo-shop README, the CLI and red-team guides and `yokla run
  --help` say what the tree's last branch is.**

## Alternatives considered

- **A leetspeak attempt in best-of-n.** Rejected: best-of-n's attempts are
  the model's independent ways, and a static rewrite of the attack is what
  `--strategy leetspeak` sends. Layering a model's attempt is the tree's
  work (ADR-0088).
- **Asking the model for leetspeak in some attempts.** Rejected for now:
  whether the model complies, and how often it refuses, can only be
  measured at a cost. The layer is certain and costs nothing.
- **A layered branch per obfuscation, leetspeak and Cyrillic
  look-alikes.** Rejected: it would add attempts. Leetspeak is the one
  both defects read past.
- **An extra branch beside the model's.** Rejected: it changes the tree's
  size and numbering, which `--branches` and `--depth` state.
