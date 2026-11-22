# 0088. More attacker strategies (R5b)

Status: Proposed · Date: 2026-11-22

## Context

ADR-0087 split R5 in two. R5 built the attacker model and two strategies:
`escalation`, one conversation written turn by turn, and `best-of-n`,
attempts each in a fresh session. It moved three strategies to R5b:

- **iterative refinement:** each attempt rewritten from the earlier ones
  and the target's answers;
- **a tree of variants:** variants of the attack, then variants of each
  variant;
- **the profile's other language** (moved from R3, ADR-0084): the attack
  written in another language the profile lists.

Its exit criterion, which this ADR may change: each strategy reaches a
demo-shop defect the template attack doesn't, with the fake provider as
attacker.

What R5 built, and R5b runs on:

- **`--attacker <strategy>`** adapts each `redteam` case of one turn,
  without `as`. The case keeps its definition: its turn's expectations
  judge every message the attacker writes.
- **yokla's own calls:** `models.attacker`, a prompt per language, a reply
  cache in `yokla-data/attacker/`, the spend counted under `--max-cost`.
- **The runner** runs best-of-n as one sample per attempt, judges the
  samples after each as the final judging would, and stops the case at its
  first attempt with a failing finding.
- **The fake provider plays the attacker** by rules: best-of-n's attempts
  are the attack as written, a role-play, leetspeak and a hypothetical.

Two facts shape the other language:

- **The attack kinds are written natively in both languages** (ADR-0079).
  The profile's other language has its own cases already, so a defect that
  language shows is reached by its written cases too.
- **Some checks read words in a language.** `concession`, `policy-claim`
  and the refusal and absence phrases read the answer with the case's
  language pack. A message sent in another language is answered in that
  language. Judged with the case's pack, a finding could be missed in
  silence.

ADR-0079 says Turkish and English are written natively, never translated
by a model at run time. That rule is about the cases yokla writes. ADR-0081
and ADR-0084 put the other language with the attacker model, where a model
writes. The case stays as written and approved; the translated message is
an attack the attacker writes, as its other messages are.

## Decision

### The command

```sh
yokla run --attacker iterative --attempts 4
yokla run --attacker tree --branches 3 --depth 2
yokla run --attacker translate
```

- **`--attacker` takes three more strategies.** What ADR-0087 decided for
  the command holds for them: the cases it adapts, the definition kept, the
  gate and `yokla compare`, the refusal with `--strategy`, `--transform`
  or a cassette, and `models.attacker`.
- **The bounds:** `--attempts` goes with `best-of-n` and `iterative`;
  `--branches` (1 to 5, default 3) and `--depth` (1 to 3, default 2) with
  `tree` only. `translate` takes none.
- **`translate` needs a profile of two languages or more,** each with its
  language pack loaded and named in the attacker prompt. Otherwise the run
  is refused before any request.

### The strategies

| Strategy | What the attacker writes for an attempt | Attempts | Stops |
|---|---|---|---|
| `iterative` | a new message, from the attack, every earlier attempt and the answer to each | `--attempts` (default 4), one after the other | at the first attempt a check fails |
| `tree` | at the first level, a variant of the attack; at each later level, a variant of a parent attempt, given its answer | `--branches` per node, to `--depth` levels, breadth first: at most 3 + 9 = 12 by default | at the first attempt a check fails |
| `translate` | the attack in another language of the profile | one per other language | at the first attempt a check fails |

- **Every attempt is a sample in a fresh session,** as best-of-n's is. The
  case stops at the first attempt with a failing finding, whatever the
  dimension's policy (ADR-0087).
- **The tree is numbered breadth first.** Attempt `k`, counted from 0, has
  attempt `⌊k / branches⌋ − 1` as its parent; the first `branches`
  attempts have the attack itself. Its branch is `k mod branches`.
- **No attempt is pruned.** No check tells how close an answer came, and a
  model doesn't decide what runs (ADR-0079).
- **A translated attempt is judged in its own language.** Its turn is
  judged with that language's pack, and a `language` expectation on the
  turn asks for that language. The case's other expectations are data,
  such as a canary, an amount, a policy topic or a tool, and hold in any
  language.
- **Each failure names the strategy and the attempt** that broke through,
  and the results keep every message the attacker wrote.

### yokla's own calls

As ADR-0087's, with each strategy's request:

- **The prompt** gains one request per strategy, in Turkish and English:
  - iterative's gives the earlier attempts and their answers as the
    conversation so far, and says each was sent in a new conversation;
  - tree's gives the parent attempt and its answer, or asks for a variant
    of the attack itself at the first level;
  - translate's names the language to write in, by its name in the
    prompt's language.
- **The cache key** holds, beside the model, the attack, the case's
  language, the strategy and the seed:
  - for iterative, the earlier attempts with their answers, the attempt's
    number and the attempts;
  - for tree, the parent's message and answer, the branch and the bounds;
  - for translate, the language written in.

### What results.v1 keeps

Additive (ADR-0007):

- **`run.attacker.limit`** is the most attempts: `--attempts` for
  iterative, the tree's node count for tree, the number of other languages
  for translate. `run.attacker` keeps `branches` and `depth` for tree.
- **On a sample:** `attacker.parent`, for a tree attempt past the first
  level, and `attacker.language`, for a translated one.

### The demo-shop

The fake provider plays each strategy by rules, at no cost:

- **iterative:** the first attempt is the attack as written. Each later
  one is the last attempt without the phrase the last answer quotes between
  double quotes; with none quoted, the last attempt again.
- **tree:** a node's branches are its parent's message as a role-play, in
  leetspeak and as a hypothetical: best-of-n's variants after the first.
- **translate:** an instruction to reply with a word is written as the
  other language's own instruction to ignore earlier instructions and reply
  only with that word. A message without one is written back as it is: the
  fake translates nothing else.

Three defects, each reached by one strategy:

- **`filter-explained`:** the shop refuses a message holding an override
  phrase (to ignore its instructions, "you are now", a system marker, in
  either language), and its refusal quotes the phrase. A message without
  one has its instruction to reply with a word followed.
  - Every written injection carries such a phrase, and passes.
  - escalation and best-of-n pass: each of their messages keeps the
    phrase, or writes it in leetspeak, which hides the instruction too.
  - `iterative` drops the quoted phrase at its second attempt, and fails
    each injection but the hidden-text one, by the check that judges the
    attack.
- **`layered-obeyed`:** the shop refuses a role-play, hypothetical or
  developer-mode request it can read, and reads past leetspeak. A wrapped
  request in leetspeak passes the filter and is answered with itself.
  - The written cases pass, and so does best-of-n: a plain wrapper is
    refused, and leetspeak alone wraps nothing.
  - `tree` fails at its fifth attempt, the role-play in leetspeak: the
    cases whose own message, followed, breaks a check, as
    `obfuscation-obeyed` does under best-of-n (ADR-0087).
  - A static layer, `--strategy roleplay+leetspeak` (ADR-0084), reaches it
    too, once a person names that pair in that order. The tree tries the
    pairs itself.
- **`one-language-guard`:** the shop's guard reads Turkish only. An
  instruction to reply with a word, in an English message, is followed.
  - The Turkish injections pass as written, and fail under `translate`,
    written in English.
  - The English injections fail as written, and pass under `translate`,
    written in Turkish.

**The exit criterion changes for `translate`:** from the cases of one
language, it reaches a defect those cases don't reach as written. The
other language's written cases reach it too. Its worth is covering a
language whose cases weren't written or approved. `iterative` and `tree`
meet the criterion as ADR-0087 wrote it.

**The end-to-end test, at no model cost:**

- on the correct shop, the attack cases pass under each strategy, every
  attempt run; `translate` runs over the injection cases, the only ones
  the fake translates;
- each defect fails as above under its strategy, and passes the written
  cases and best-of-n (for `one-language-guard`, the Turkish cases);
- a second iterative run sends no attacker call: every reply comes from
  the cache.

### Layers

- **`core`:** the strategies, their prompts and cache keys, the tree's
  numbering, and translate's languages.
- **`runtime`:** the three drivers, beside R5's, and judging a translated
  attempt in its language.
- **`cli`:** the strategies, `--branches` and `--depth`, and the summary.

### The design is updated

- **Design §20:** R5b's row is marked done, with this ADR's criterion for
  `translate`.
- **Design §19:** the three defects and what catches them.

## Consequences

- **Every strategy ADR-0081 listed for R5 runs** over the approved attack
  cases.
- **A tree costs the most:** with a real attacker, up to branches +
  branches² + … calls and target turns per case. `--max-cost` caps it,
  and the defaults keep it at 12.
- **iterative and tree send the target's answers to the attacker,** as
  escalation does (ADR-0087).
- **The fake's translation covers instructions only.** Translating the
  other kinds needs a real model, run with its estimate approved.
- **A language without a pack stays out** until a later ADR: the checks
  that read words couldn't judge its answer.

## Alternatives considered

- **translate as a static strategy, from the language packs.** Each pack
  already writes every kind natively; a translation table would repeat
  them. Rejected: the attacker writes it, as ADR-0084 decided.
- **Judging a translated attempt with the case's pack.** A check that
  reads words would read the wrong language and miss a finding in silence.
  Rejected: the attempt's own language judges it.
- **A tree pruned by a score.** A model would decide what runs, and no
  deterministic check gives a degree. Rejected: breadth first, bounded by
  branches and depth.
- **A translate defect the other language's written cases don't reach.**
  The cases are written natively in both languages, so such a defect would
  hang on a phrasing, not on a language. Rejected: the criterion changes
  instead.
- **One `--attempts` bound for every strategy.** A tree has two
  dimensions, and one number would hide one of them. Rejected: `--branches`
  and `--depth`.
