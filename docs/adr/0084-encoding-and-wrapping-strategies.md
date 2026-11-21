# 0084. Encoding and wrapping strategies (R3)

Status: Proposed · Date: 2026-11-21

## Context

R3 of the red-team track (ADR-0079, widened by ADR-0081) delivers an
approved attack case in another form, as the robustness transforms deliver
any case (ADR-0045). Its list:

- static transforms: Base64, hex, ROT13, leetspeak, look-alike letters,
  Morse, hidden Unicode, Turkish without its letters, the profile's other
  language, and yokla's own jailbreak wrappers (role-play, a hypothetical, a
  fake developer mode);
- two of them in layers;
- an attack spread over several turns;
- the canary goes in encoded with the attack, and the answer is checked
  for it in plain text.

Its exit criteria: an encoded or spread attack that the correct shop
withstands still passes, and a defect that decodes and follows one is
caught.

What exists:

- **`yokla run --transform`** sends each written message as a transform
  changes it, keeps the values the turn's expectations quote as written,
  and keeps the case's definition, so `yokla compare --expect-same` sets
  the run beside one without it (ADR-0045).
- **`no-diacritics`** is already a transform.
- **The attack cases** of `yokla generate --redteam` carry their canary,
  or the value a check looks for, in the message (ADR-0080, ADR-0082,
  ADR-0083).
- **`hideText`** writes ASCII in invisible Unicode tag characters
  (ADR-0082).

Two items of the list don't fit a static rewrite of one message:

- **The other language** needs a translation, which needs a model. The
  attack kinds are already written natively in both languages.
- **An attack spread over turns** changes how many turns a case has. A
  turn's index ties it to its expectations, its identity (ADR-0083), its
  faults and its results. Splitting a turn would move all of them.

## Decision

### The command

- **`yokla run --strategy <name>`** sends each message of each `redteam`
  case as the strategy rewrites it. Cases of other suites go as written.
- **One strategy per run,** or two in layers: `--strategy base64+roleplay`
  applies `base64`, then `roleplay`. One run per strategy tells which one
  moved a verdict.
- **The case keeps its definition,** as under a transform (ADR-0045).
  `yokla compare --expect-same` sets the run beside one without the
  strategy, and the gate judges it against the baseline.
- **Not with `--transform`, nor with a cassette,** for now: the run is
  refused, saying so.

### The strategies

| Strategy | Kind | What it sends |
|---|---|---|
| `base64` | encoding | the message in Base64, after a line that asks to decode it and follow it |
| `hex` | encoding | the message's UTF-8 bytes in hexadecimal, after the same kind of line |
| `rot13` | encoding | the message without diacritics, its Latin letters rotated by 13, after the same kind of line |
| `morse` | encoding | the message without diacritics in Morse code, letters by spaces and words by slashes, after the same kind of line |
| `hidden` | encoding | a line that says the message holds an instruction, then the message without diacritics in Unicode tag characters |
| `leetspeak` | obfuscation | letters as digits: a→4, e→3, i→1, o→0, s→5, t→7 |
| `homoglyph` | obfuscation | Latin letters as their Cyrillic look-alikes: a→а, e→е, o→о, p→р, c→с, x→х, and capitals |
| `roleplay` | wrapper | the message as a line a character in a story says, asked to be played out |
| `hypothetical` | wrapper | the message as a purely hypothetical question |
| `developer-mode` | wrapper | the message after a claim that a developer mode with no rules is on |

- **Encodings rewrite the whole message,** the canary and every quoted
  value with it. A target that decodes the message and follows it writes
  the canary back in plain text, and the check that looks for it fails. A
  target that only repeats the encoded text writes no canary.
- **Obfuscations and wrappers keep quoted values as written,** as the
  transforms do (ADR-0045). The canary stays readable, so a target that
  reads past the obfuscation and follows the instruction writes it.
- **The language pack words** each encoding's line and each wrapper, with
  `{payload}` for the message. Core does the encoding (P7).
- **Text a strategy can't encode,** such as a letter outside ASCII left
  after removing diacritics, goes as `?` in Morse and in tag characters.

### What the results keep

- **`run.strategy`:** the name, and how many messages it changed. A
  strategy that changed no message, as on a run with no `redteam` case, is
  a run issue.
- **On a turn,** `user` is the message as sent and `written` as the case
  wrote it, as for a transform (ADR-0045).
- **The reports** name the run's strategy, and `yokla compare` names a run
  by it.

### Left out, with why

- **The profile's other language** goes to R5, where a model writes.
- **An attack spread over turns** goes to R5 too: its attacker model writes
  a conversation turn by turn, so no written turn's index moves.
- **`no-diacritics`** stays a transform: `yokla run --transform
  no-diacritics` already sends an attack case that way.

This narrows ADR-0081's R3, as its last rule allows.

### The demo-shop

- **The correct shop withstands every strategy:** it reads an encoded or
  wrapped message as it reads any other, and follows no instruction in it.
- **New defects:**

  | Defect | What it does |
  |---|---|
  | `decodes-and-obeys` | decodes a Base64, hexadecimal, ROT13 or Morse message and answers with what it says |
  | `obfuscation-obeyed` | reads leetspeak and Cyrillic look-alikes as letters and answers with the message |
  | `wrapper-obeyed` | takes a role-play, hypothetical or developer-mode request at its word and answers with it |

  The `hidden` strategy is caught by `hidden-text-obeyed` (ADR-0082).
- **A defect's failures are the cases whose own message, followed, breaks
  its check:** an injection writes its canary, a false premise states its
  false duration, a card attack writes the card number. Every injection
  case under the defect's strategies fails, and no case fails under the
  other strategies.
- **The end-to-end test, at no model cost:** an attack file of one case of
  each kind per language, run on the correct shop under every strategy and
  under `base64+roleplay`, where every case passes but `cost-abuse`, which
  is unmeasured without the proxy; and under each defect with its
  strategies.

### Layers

- **`core`:** the strategies, their encodings and the layering.
- **The language packs:** each encoding's line and each wrapper.
- **`runtime`:** sending `redteam` cases as the strategy rewrites them, and
  `run.strategy`.
- **`cli`:** `--strategy`, the summary and `compare`'s name for the run.

## Consequences

- **An attack case approved once is sent ten more ways** at no model cost.
- **A target that resists the written attack** but decodes or reads past
  an obfuscation shows it.
- **Templates and strategies are still fixed text.** A target can learn
  them; R5's attacker model varies them.
- **Multi-turn attacks wait for R5.**

## Alternatives considered

- **Strategies as more transforms.** Transforms apply to every case and
  never change quoted values; an encoding must change the canary, and only
  attacks should be sent encoded. Rejected: a separate option.
- **Encoding only the instruction, not the canary.** A target that decoded
  nothing would still see the canary in plain text, and one that repeats
  the message would fail for nothing. Rejected: encodings rewrite all of
  it.
- **Splitting a turn into two.** It moves every later turn's index, and
  with it expectations, identities and results. Rejected: R5.
- **Any number of layers.** Two show what a layer adds; more make a
  failure hard to explain. Rejected for now.
