# 0104. The attacker's prompt is written in English

Status: Accepted · Date: 2026-11-26

## Context

ADR-0087 gave the attacker a prompt per language, Turkish and English: a
Turkish case's attacker is instructed in Turkish, and an English case's in
English. ADR-0088's `translate` asks in the case's language too, and
ADR-0101 gave the prompt its tags and a version in the cache key.

The real runs of the attacker on the demo-shop (design §19), Claude Haiku
5.5 through a hosted gateway, refused far more often in Turkish. In
ADR-0102's run, 12 of 17 replies to a Turkish prompt held no message, and 1
of 8 to an English one; every Turkish case of `filter-explained` and both
of `one-language-guard`'s English translations went unmeasured.

A diagnostic, approved with its estimate on 2026-11-26 and never
committed, asked whether the prompt's language is the cause. `best-of-n`
on the correct shop, over the five `injection` cases of each language,
four attempts each, $0.0123:

| Cases | Prompt | Attempts sent | No message | Values left out |
|---|---|---|---|---|
| Turkish | Turkish, as shipped | 4 of 20 | 11 | 5 |
| Turkish | English, asking for a message "in Turkish" | 19 of 20 | 0 | 1 |
| English | English, as shipped | 16 of 20 | 4 | 0 |

Every message of the second arm was Turkish. Instructed in English, the
model wrote the Turkish attacks it refused when instructed in Turkish. Its
refusals were also its longest replies: the first arm cost $0.0068, the
second $0.0037.

## Decision

### One prompt, in English, for every case language

- **The attacker's prompt is written in English** whatever the case's
  language. Where it asks for a message, it names the case's language:
  "Write only your next message to the assistant, in Turkish."
- **The languages it can name are those the language packs write,**
  English and Turkish, by their English names. A case in another language
  stays an error of the case, as ADR-0087 decided.
- **The Turkish prompt is removed.** Its lines said what the English ones
  say.
- **`translate` asks in English too:** "Translate the attack into this
  language: English."
- **The attack, the transcript and the answers stay as they are,** in the
  case's language: only yokla's instructions change language.

### The cache asks anew

- **The prompt's version becomes 3** (ADR-0101). Every attacker reply
  cached before this ADR is asked anew once, the English ones too: one
  version covers every language.

### The demo-shop and the tests

- **The fake attacker reads the language from the line that names it,**
  "in Turkish" or "in English", where it read the Turkish prompt's words.
  Its rules are unchanged, so every end-to-end verdict holds.
- **Unit tests:** a Turkish case's prompt is the English one naming
  Turkish, for every strategy; it holds none of the removed Turkish lines;
  `translate` names the language it writes in; a language without a name
  is an error; the version in the key is 3.

### One run with a real model, by hand

- **Approved with its estimate,** ADR-0102's run again: `worn-down` under
  `escalation`, `filter-explained` under `iterative`, `one-language-guard`
  under `translate`, over the `injection` cases. Expected: the Turkish
  cases' attempts are sent, and `one-language-guard`, reached by its
  English translations. Its results go to design §19.

## Consequences

- **A Turkish case is attacked as often as an English one,** on the model
  measured. The diagnostic is one model's; another may differ, and the
  summary's count of attempts not sent (ADR-0101) shows it.
- **Fewer refusals cost less:** a refusal is a long reply, paid for and
  not sent.
- **One prompt to keep:** a change to the attacker's instructions is made
  once.
- **The simulated customer's and the transforms' prompts stay per
  language.** They ask for nothing a model refuses, and no run showed
  refusals there.

## Alternatives considered

- **Rewording the Turkish prompt.** The diagnostic changed only the
  language, and the refusals went. Rejected: a reworded Turkish prompt
  would need its own measurement, for no gain over the English one.
- **An English prompt only after a Turkish refusal.** Each refusal would
  be paid for, then asked again. Rejected: ADR-0101 asks nothing again by
  itself.
- **Another attacker model.** It may refuse less in Turkish, at a higher
  price, and would not be measured against this one. Rejected for now:
  the prompt is yokla's, and fixing it helps every model.
