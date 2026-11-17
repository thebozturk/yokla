# 0059. Paraphrase and code-switching, written by a model

Status: Accepted · Date: 2026-11-17

## Context

ADR-0045 added robustness transforms that need no model: no diacritics,
lower case, no punctuation and a typo. It left two of design §9's
transforms to "a later ADR under ADR-0028's rules", since only a model
writes them well:

- **Paraphrase:** the same request in other words, as another shopper asks
  it. "Çadır önerir misin?" becomes "Bana bir çadır tavsiye eder misiniz?".
- **Turkish–English code-switching:** a message that mixes the two, as
  shoppers in Turkey often write: "Bu jacket'in M size'ı var mı?".

An assistant that answers the written words and misreads their paraphrase,
or answers a mixed message in the wrong language, fails those shoppers, and
no written case shows it. The verdict must stay the same, as for ADR-0045's
transforms.

ADR-0028's rules for yokla's own calls hold: the model is the user's choice,
configured and priced, its calls capped and cached, and its replies checked
where yokla can check them.

## Decision

### The transforms

- **`yokla run --transform paraphrase` and `--transform code-switch`,**
  beside ADR-0045's kinds, and combinable with them.
  - The model's kinds apply first, then ADR-0045's, so a paraphrase can be
    sent in lower case.
  - Everything ADR-0045 says of a transform holds: the case keeps its
    definition, `yokla compare --expect-same` and the gate judge it, the
    results keep `written` beside `user`, and a simulated customer's
    messages are left as they are.
- **`models.transform` in `yokla.config.yaml`** names the model, in any kind
  yokla's own calls speak (ADR-0028, ADR-0032), with a price, 0 for a local
  model. Without it, a run with a model's transform refuses to start.
- **`code-switch` mixes in the profile's other language:** the first of its
  languages that isn't the case's. A profile with one language leaves the
  messages as written, and says so.

### What the model is asked

- **A prompt of yokla's,** marked on its first line, in English, naming no
  target (P9). It gives the message, its language, the kind, and the text
  to keep exactly. It asks for the rewritten message alone.
  - **Paraphrase:** the same request, in the same language, with the same
    facts, as another shopper would write it.
  - **Code-switch:** the same message, with some words, such as product
    words, in the other language, as bilingual shoppers write it.
- **One rewrite per message,** the same in every sample and every run: the
  prompt holds no seed, at temperature 0.

### Checked before it is sent

- **The text no transform changes must stay exactly:** a word that holds a
  digit, `@` or `/`, a money amount, and the values the turn's expectations
  quote (ADR-0045). A rewrite that loses one of them is not sent.
- **A rewrite must differ from the message,** and hold one line of text.
- **A message whose rewrite fails a check is sent as written.** The run's
  issues count them per kind, with why, such as "1.500 TL was lost".

### Cost and cache

- **The rewrites are made before the first request,** so the cost of the
  transforms is known and capped before the target is asked anything.
- **Before the first call,** the run prints how many messages the model
  rewrites, how many the cache holds, the model's url, and an upper bound:
  each message's prompt, counted as ADR-0051 counts, and `maxTokens` of
  output.
- **`--max-cost` is required** when a rewrite isn't cached and the model's
  price isn't 0. It covers these calls as it covers the customer's
  (ADR-0028): once the spend reaches it, no further message is rewritten,
  and those left are sent as written.
- **Replies are cached** in `yokla-data/transform/`, keyed by the model's
  settings, the prompt's version, the kind, the languages, the message and
  the text it keeps. A rerun costs nothing, and sends the same messages.
- **The results' `run.own`** counts these calls with the customer's.

### The demo-shop and the tests

- **The fake provider plays the transform model** by rules, at no cost. It
  recognises yokla's prompt by its first line.
  - **Paraphrase:** "X var mı?" becomes "X bulunuyor mu?", "Do you have
    X?" becomes "Is there any X?", and other messages gain a polite
    opening.
  - **Code-switch:** the shop's product words in one language become the
    other's, such as "çadır" to "tent".
  - **It loses a value once:** in a message with an amount, it writes the
    amount another way, so the check has a rewrite to refuse.
- **A new defect, `language-by-words`:** the shop answers in English a
  Turkish message that holds an English product word. Every written case
  passes with it on.
- **The end-to-end test, at no model cost,** runs the acceptance cases as
  written and under each model's transform:
  - without defects, `yokla compare --expect-same` exits with `0` for both,
    and each changed messages;
  - the message whose amount the fake model lost is sent as written, and
    the run's issues say so;
  - with `language-by-words`, `code-switch` makes the comparison exit with
    `1`, and every case it names is a Turkish case whose message gained an
    English product word; `paraphrase` keeps every verdict;
  - a second run sends the same messages, from the cache;
  - nothing is contacted but the shop and the fake provider.
- **One run with a real model, by hand,** approved with its estimate, on
  the demo-shop without defects. Its cases that keep their verdict, the
  rewrites refused, and its cost go to design §19.

### Layers

- **`core`:** the prompt, the check of a rewrite, and the order of the
  kinds. All pure.
- **`runtime`:** the calls through its model client, the cache, the cap,
  and the runner sending the rewrites.
- **`cli`:** the kinds, `models.transform`, the estimate and the issues.

## Consequences

- **A target is tested as its shoppers write,** not only as its cases were
  written, and a rewrite never changes what the checks look for.
- **A paraphrase can change a request's meaning** in a way no check sees,
  such as "a tent" becoming "tents". The written message stays beside the
  sent one, and `--expect-same` names a case whose verdict moved for a
  person to read.
- **The messages go to the configured model.** A hosted model receives
  them, as it receives the customer's conversation (ADR-0028).
- **A run with these transforms can cost money,** capped and estimated; a
  rerun is free from the cache.

## Alternatives considered

- **A new rewrite per sample.** It would cover more wording, but a
  sample's verdict could then move by the rewrite, not the target, and
  every run would cost again. Rejected: one rewrite per message.
- **Sending a rewrite that lost a kept value.** The check that looks for it
  would pass or fail for the wrong reason (ADR-0045). Rejected.
- **Rewriting during the run, turn by turn.** The cap would then stop a run
  half transformed. Rejected: the rewrites come first.
- **Phrase lists in the language packs.** They would rewrite a handful of
  sentences well and the rest not at all. Rejected: a model writes them.
