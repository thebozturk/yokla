# 0045. Robustness transforms of a case's messages

Status: Proposed · Date: 2026-11-16 · Amends 0042

## Context

A case is written once, and written cleanly. Users don't write that way:

- they type on a phone or a keyboard without Turkish letters ("cadir" for
  "çadır");
- they write in lower case and leave out punctuation;
- they mistype.

An assistant that understands "Çadır önerir misin?" and not "cadir onerir
misin" fails those users, and no written case shows it.

Design §9 plans robustness transforms: "typos, removed diacritics,
Turkish–English code-switching, paraphrase, casing and punctuation noise. The
expectation is the same verdict as the source case." The v0.4 row of design
§20 takes the ones that need no model: typos, removed diacritics, casing and
punctuation. Its exit criterion: "on the demo-shop, a transform catches a
seeded defect that shows only in a message without diacritics, and the
transforms of every other approved case keep its verdict".

Three things are already there:

- **A change that mustn't move a verdict.** ADR-0043 makes one for a whole
  run, and `yokla compare --expect-same` fails when a case's status moves.
- **Case and diacritic folding.** The language packs fold text for matching.
  They give no lower casing or diacritic removal on its own.
- **A seed per turn.** Fault jitter is drawn from the case, the sample and
  the turn, so a run repeats (ADR-0017).

On 2026-11-16 a probe ran at no model cost against the in-process demo-shop,
with hand-made copies of the 18 acceptance cases:

- **A copy is another definition.** `yokla compare` compared no copy with its
  source (ADR-0011). `--expect-same` passed while four copies with a typo
  failed. A transform has to keep the definition of the case as written.
- **Without diacritics, in lower case, and without punctuation,** all 18
  cases passed, as they do as written.
- **With one typo in each message,** four failed:
  - a price limit ignored after "altında" became "atlında";
  - two absent types not recognised, `sleeping-pad-tr` and `hammock-en`;
  - a warranty question read as a product search, `warranty-en`.

  The demo-shop has no tolerance for typos.
- **A copy of the shop that tells Turkish by its letters alone** passed all
  18 cases as written. Without diacritics, it answered three Turkish cases
  in English, and each failed a check:
  - `tents-under-500-tr`, the filter disclosure;
  - `sleeping-pad-tr`, the absence statement;
  - `returns-tr`, the similarity to the FAQ.

## Decision

### The command

```sh
yokla run --out runs/written.json
yokla run --transform no-diacritics --out runs/no-diacritics.json
yokla compare --results runs/written.json --results runs/no-diacritics.json --expect-same
```

- **`yokla run --transform <kind>`,** repeatable. The run sends each written
  message of each case as the transforms change it.
  - Several kinds apply in the order of the table below.
  - One kind per run tells which one moved a verdict.
  - Every case the run runs is transformed, proposed ones too. As in any
    run, a proposed case is reported and doesn't gate (ADR-0018).
- **The case keeps its definition.** A transformed case has the definition
  hash of the case as written (ADR-0011). The case didn't change; the run
  sent it differently. So the comparison and the gate compare it with its
  source.
- **It is judged as ADR-0043's metamorphic change is.**
  - `yokla compare --expect-same` sets it beside a run without the transform.
  - `yokla gate` with the baseline also judges it: a case that passed in the
    baseline and fails under a transform is a regression (ADR-0010).

### The transforms

| Kind | What it does | Given by |
|---|---|---|
| `no-diacritics` | each letter with a diacritic becomes its base letter: "Çadır önerir misin?" → "Cadir onerir misin?" | the case's language pack |
| `lowercase` | the message in lower case, by the language's rules: "İADE" → "iade", "KIŞ" → "kış" | the case's language pack |
| `no-punctuation` | each punctuation mark removed: "women's jackets?" → "womens jackets" | core |
| `typos` | one typo in one word: two neighbouring letters swapped, one letter dropped, or one doubled | core |

- **The language packs gain two functions,** `lowerCase` and
  `removeDiacritics`. Core knows no language (P7).
  - Turkish's dotless ı, its dotted İ and its letters are lang-tr's.
  - lang-en removes combining marks, so "café" becomes "cafe".
- **Typos.**
  - **One per message,** in a word of at least four letters.
  - **Never the first letter** of a word, which people rarely mistype.
  - **Drawn from a seed** of the case id, the sample index and the turn
    index, as fault jitter is (ADR-0017). The seed picks the word, the
    position and the kind.
  - **The same case, sample and turn get the same typo in every run.** The
    samples of a case get different ones.
- **What no transform changes.**
  - **A word that holds a digit, `@` or `/`:** amounts, sizes, phone
    numbers, e-mail addresses, urls and ids. "1.500 TL" stays as written.
  - **Text the turn's expectations quote:** a `notSentToModel` value, or a
    phrase of `answer.contains` or `answer.notContains`, found in the message
    as written. An example is a canary the message asks the assistant to
    repeat. A transform changes how the user writes, never the values the
    checks look for. A typo in a seeded phone number or a canary would make
    the check that looks for it pass for nothing.
  - **The rest of the turn:** its expectations, faults, tool-result
    injections (ADR-0043) and request additions.
  - **A simulated customer's messages (ADR-0028).** They are the customer
    model's, not the case's. The run's issues count the cases a transform
    left as they are.
- **A message a transform can't change,** such as one without an eligible
  word, is sent as written.

### What the results keep

These are additive (ADR-0007):

- **`run.transforms`:** each kind, with how many messages it changed.
  - A transform that changed no message is a run issue: the run measured
    the cases as written.
- **On a turn:**
  - `user` is the message as sent, and the checks see it;
  - `written` is the message as the case wrote it, when a transform changed
    it.
- **The reports.** The terminal summary names the run's transforms. The HTML
  report shows the written message under the one sent.
- **`yokla compare` names a run by what it changed:** its swaps (ADR-0042),
  its tool changes (ADR-0043) and its transforms, such as
  `transforms: no-diacritics`.
  - A run that changed nothing stays "as the app asks".
  - This amends ADR-0042, which named a run by its swaps alone. The rest of
    ADR-0042 stands.

### With the other options

- **A cassette.** A transformed run records and replays as any run does.
  Its messages repeat from the seed, and so do the app's model calls.
  - The cassette records the run's transforms.
  - A replay with other transforms is refused before any request, since
    every call would diverge (ADR-0040).
- **Faults, swaps, tool changes and `--stop-early`** apply as they do.
- **`yokla plan`** is unchanged. A transformed run costs what the run as
  written costs.
- **Not part of this ADR:**
  - transforms in `yokla explore`, `yokla shrink` and `yokla mcp`;
  - paraphrase and Turkish–English code-switching. They need a model, and a
    later ADR under ADR-0028's rules.

### Layers

- **`core`:** the transforms, the seed, and the words and values they leave
  alone. Pure, as the checks are.
- **`packs/lang-*`:** `lowerCase` and `removeDiacritics`.
- **`runtime`:** the runner transforms each written turn's message before
  sending it, and records both.
- **`cli` and `report`:** the option, and what the reports show.

### The demo-shop

- **The correct shop gains tolerance for typos.** Take a word of four
  letters or more. When it, or its start before a suffix, is one edit away
  from exactly one of the words and stems the shop knows, the shop reads it
  as that one. An edit is a letter swapped with its neighbour, dropped,
  doubled or replaced.
  - The shop already folds case and diacritics and ignores punctuation.
  - It tells a Turkish message without Turkish letters by its common words.
- **A new defect, `language-by-letters`.** The shop tells Turkish from
  English by Turkish letters alone, so a Turkish message typed without them
  is answered in English.
  - Every Turkish acceptance message has a Turkish letter, except the
    greeting. The greeting expects nothing that depends on the language.
  - So the written cases pass with the defect on.
- **The end-to-end test** runs the acceptance cases in process, at no model
  cost, behind the network guard: once as written, and once under each
  transform.
  - **Without defects:** `yokla compare --expect-same` exits with `0` for
    every transform, and every transform changed messages.
  - **With `language-by-letters`:**
    - as written, every case passes;
    - under `no-diacritics`, the comparison exits with `1`, and it names
      exactly `tents-under-500-tr`, `sleeping-pad-tr` and `returns-tr`;
    - under the other three transforms, it exits with `0`.
  - **Repeats:** two runs with `typos` send the same messages.
- **Design §19 gains the defect.** With this, v0.4's transform criterion
  holds. The analyzer's criteria remain.

## Consequences

- **A team learns whether its assistant understands users as they write,**
  with the cases it already has and no new expectation.
- **Each transform costs a run.** On a paid target, a robustness check is
  one run per transform. `yokla plan` estimates it and `--max-cost` caps it,
  as for any run.
- **Results stay comparable.** A transformed case keeps its definition, so
  the comparison and the gate set it beside its source.
- **A typo can change a word's meaning,** for example "mont" to "mot". A
  verdict that moves under typos is a finding for a person to read. The HTML
  report shows both messages.
- **The language packs gain two functions.** Property tests cover them, as
  they cover folding (ADR-0006): a message without diacritics, or in lower
  case, folds to what the message as written folds to.
- **The demo-shop's tolerance for typos is its own.** It shows what a correct
  target does, as its fallback answer does.

## Alternatives considered

- **Transformed copies written as proposed case files.** Each case would need
  a twin.
  - A copy is another definition, so neither the comparison nor the gate ties
    it to its source, as the probe showed.
  - Approving a mechanical copy adds review that tells the reviewer nothing.

  Rejected for a run-wide change, as ADR-0043 rejected metamorphic twins.
- **Typos drawn anew on every run.** A verdict could move between two runs
  with nothing changed, as jitter did before ADR-0017. Rejected.
- **Several typos per message, or a rate per word.** They test a heavier
  hand, and a moved verdict says less about which slip moved it. Deferred:
  one typo is the smallest slip.
- **Keyboard-neighbour replacements.** They need a layout per language: the
  Turkish Q and F layouts, and QWERTY. Deferred; a language pack can add
  them.
- **Typos on a word's first letter.** People rarely make them, and they are
  hard for any reader. Rejected.
- **Upper case, or random casing.** Both are rare in chat. Deferred.
- **Changing every word, digits included.** "1.500" turned into "1500" can
  change an amount. Rejected.
- **Turkish rules in core.** Core knows no language (P7). Rejected; the
  packs give them.
- **Paraphrase and code-switching now.** They need a model. Deferred to their
  own ADR.
