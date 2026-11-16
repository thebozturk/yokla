# 0049. The analyzer reads code and docs: values a model finds, verified in their source

Status: Accepted · Date: 2026-11-16

## Context

ADR-0047 built the analyzer's first step. It uses no model: it reads the
target's data and sends a few probes. On the demo-shop, its proposal holds 30
entries, every one the hand-written profile's, and misses 34 (recall
46.9 %). Some of what it misses is written plainly in the repository:

- **The rate limits.** `src/server.ts:23` holds `{ burstPerSecond: 3,
  perMinute: 120 }`. The README says "a burst of 3 requests per second and
  120 per minute".
- **The cache bypass.** The README says "Send `x-cache-bypass: 1` to skip
  reading the cache".
- **The canonical refusals.** `src/model.ts:249` holds `refusal: 'Bu konuda
  yardımcı olamıyorum.'`, and line 278 the English one.

Rules can't find these in every target: each project writes them its own
way. Design §8 plans step 2 for this: "extraction (LLM agent, budgeted). Read
the inventoried files in bounded chunks and propose profile entries, each
pointing to its evidence." The rules around it:

- **The analyzer has a budget.** It prints an estimate before it calls any
  model (§8).
- **yokla's own model calls are the user's choice** (ADR-0028). They are
  configured, priced and capped.
- **Code answers measurability questions only** (ADR-0004).

A model can propose a value nobody wrote. The proposal is measured by its
precision, and a person approves every entry, so an invented one costs both.
The maintainer chose these bounds:

- **Fields:** in this step, the model may propose only entries whose value
  appears word for word in its source, where yokla can check it: the rate
  limits, the cache bypass and the canonical refusals.
- **Measurement:** the fake provider plays the model in CI. One run with a
  real model, approved with its estimate, measures it on the demo-shop.

The rest of what ADR-0047 missed is left out on purpose. The response
contract and the capabilities are free text a model would word its own way.
`neverFabricate` and `everyAnswer` are the tester's choices. None of them can
be checked against a line.

## Decision

### The model

- **`models.analyzer` in `yokla.config.yaml`** names it, as `models.customer`
  does (ADR-0028), in any kind yokla's own calls speak: OpenAI-compatible,
  Anthropic or Gemini (ADR-0032).
- **Without it, `yokla analyze` does what ADR-0047 says,** and its summary
  says that the model step didn't run.
- **The calls go to that model's url only,** through yokla's model client,
  never through the model proxy (ADR-0003, ADR-0028).

### What the model reads

- **Files of the inventory (ADR-0047),** of the kinds `doc`, `prompt`,
  `contract`, `manifest`, `env-example` and `code`, in that order and by path
  within a kind. Claims come first, so a budget that runs out leaves code
  unread rather than docs.
- **What it never reads:**
  - data files, whose rows may hold personal data;
  - files of kind `other`;
  - environment files, which the inventory never opens;
  - test files: paths in a `test`, `tests` or `__tests__` folder, or named
    like `*.test.*`, `*.spec.*`, `*_test.*` or `test_*.py`. Their values are
    fixtures, not the target's.
- **Chunks.**
  - Each file's text is sent with its path and its line numbers.
  - A chunk holds at most `--chunk-tokens` tokens, 8,000 by default,
    counted as one token per four characters. A file larger than that is cut
    at line breaks.
- **Budget.**
  - `--max-tokens` caps the input tokens of the whole step, 200,000 by
    default. Files beyond it aren't sent, and the summary lists them.
  - `--max-cost` caps the step's spend, as `yokla run --max-cost` does
    (ADR-0014, ADR-0028). It is required when `models.analyzer` is set:
    without it, `yokla analyze` refuses to start, as `yokla mcp` does
    (ADR-0041).
  - Once the spend reaches the cap, no further chunk is sent, and the
    analysis is marked partial.

### The estimate, before any call

- **Before the first call,** the analyzer prints:
  - the files it will send, and those it leaves out;
  - the chunks and their input tokens;
  - the most output tokens: chunks × the model's `maxTokens`;
  - from the model's `price`, the estimated cost and its upper bound, twice
    the estimate, as `yokla plan` gives it (ADR-0014). Without a price, it
    gives no figure.
- **It also names the model's url,** and says that the files' text goes
  there.
- **`--estimate`** prints the inventory and the estimate, and sends nothing:
  no probe and no model call. That is the figure a paid run is approved on.

### What the model is asked

- **A prompt of yokla's.** It is one template, in English, that names no
  particular target (P9). It holds:
  - the closed list of fields below, each with what it means and the shape
    of its value;
  - the chunk;
  - the profile's languages;
  - the instruction to propose only values the text states, each with its
    file, its line and the line's text as a quote, and nothing else;
  - the answer's form: JSON only, `{"entries": [{"field", "value", "file",
    "line", "quote"}]}`.
- **One call per chunk,** at temperature 0, with a seed from the chunk's
  hash where the provider takes one.
- **The fields:**

  | Field | Entry | Value |
  |---|---|---|
  | `limits` | `target.limits.burstPerSecond`, `perMinute`, `perHour` | a whole number of requests |
  | `cacheBypass` | `target.cacheBypass`, as `{ kind: header, name, value }` | a header name, and the value it is sent with |
  | `refusal` | `refusal.canonical.<language>` | a sentence the target refuses with, in one of the profile's languages |

  All three are measurability: they say how to reach the target and how to
  recognise its refusals, never what a right answer is (ADR-0004). A field
  that states an expectation, added by a later ADR, must also mark an entry
  that only code gives as `claim: implicit`.

### Verification, before anything is proposed

Core checks each entry the model returns, deterministically, against the
file it names:

- **The reply.** It is read as JSON: its whole text, or from its first `{` to
  its last `}`. An entry is kept only when its field is in the list and its
  value has the field's shape.
- **The source.**
  - The file was in the chunk that was sent.
  - The line exists.
  - The quote, with whitespace collapsed, is on that line or within two lines
    of it.
- **The value is in the quote.**
  - **A number:** as digits, standing alone.
  - **A header name:** in any case, standing alone.
  - **A header value:** standing alone, after the name.
  - **A refusal:** the whole sentence, with whitespace collapsed.
- **What fails isn't proposed.** An entry that fails any check is listed in
  the report as unverified, with its field, file, line and the check it
  failed. It never reaches the proposal.
- **One value per entry.**
  - Verified entries for one pointer with the same value give one entry,
    with the first evidence in sending order.
  - For a limit or the cache bypass, verified entries with different values
    give none. The report lists them as a conflict, for the person to
    settle.
  - Refusals are a list: each verified sentence joins its language's list,
    once, in sending order.
- **Data and probes come first.** A model entry is dropped where the data or
  the probes proposed the same pointer. They are checked against the data and
  the target themselves.

### Provenance

- **The source** follows the kind of the file the value is in:
  - `doc` and `prompt` keep their kind;
  - `contract` is `contract`;
  - `code`, `manifest` and `env-example` are `code`.
- **The evidence** is the file, the line and the quote, cut at 120
  characters: `README.md:315: "Each client address gets a burst of 3
  requests per second"`.
- **The status** is `proposed`, as for every machine-made entry (ADR-0047).

### Cached replies

- **Each reply is cached** in `yokla-data/analyzer/`, next to the proposal.
  - The key is the SHA-256 of the model's configuration, the prompt template's
    version, the profile's languages and the chunk.
  - A rerun on unchanged files costs nothing and writes the same proposal.
  - **`--fresh-model`** asks the model anew.
  - The cache holds the target's code in its replies' quotes. It stays out
    of version control, as `yokla-data/` does (design §15).

### What the report holds

These are additive (`yokla.analysis/v1`):

- **`model`:**
  - the model, its calls and how many the cache answered;
  - the input and output tokens;
  - the cost, or null when a call had none;
  - the files sent and the files left out;
  - whether the cap stopped it.
- **`unverified`:** each dropped entry, with its field, file, line and the
  check it failed. Never its value.
- **`conflicts`:** each pointer whose verified entries disagree.

### Layers

- **`core`:**
  - the fields and their shapes;
  - the prompt template and the chunks;
  - reading the reply, and the verification;
  - the estimate.

  All of it pure.
- **`@yokla/analyzer`:** reading the files, the calls through `runtime`'s
  model client, the cache and the cap.
- **`cli`:** the options `--config`, `--max-cost`, `--max-tokens`,
  `--chunk-tokens`, `--estimate` and `--fresh-model`.

### The demo-shop

- **The fake provider plays the analyzer model** by simple rules, at no
  cost.
  - It recognises yokla's analyzer prompt by its first line.
  - In the chunk, it finds:
    - an object with `burstPerSecond` and `perMinute`;
    - a header sent to bypass a cache;
    - lines that set a `refusal` sentence.
  - It answers with each one's file, line and quote.
  - It also invents one entry, a limit of 999 quoted from a line that doesn't
    hold it, so verification has something to drop.
- **The end-to-end test** runs `yokla analyze` with `models.analyzer` on the
  fake provider. It compares the proposal with the hand-written profile, as
  ADR-0047's test does.
  - **Expected `same`:** ADR-0047's 30 entries, plus the two limits, the
    cache bypass's kind, name and value, and the two canonical refusals: 37.
    Nothing `different` or `new`, so precision stays 100 %. Recall becomes 37
    of 64.
  - **The invented limit** is in the report as unverified, and not in the
    proposal.
  - **A second analysis** answers every chunk from the cache: the fake
    provider's usage log gains no call, and the file is the same.
  - **Refusals:** without `--max-cost`, the model step refuses to start.
    `--estimate` sends nothing.
  - **Egress:** nothing is contacted but the shop and the fake provider.
- **One run with a real model, by hand.**
  - The maintainer chooses the model.
  - Its estimate comes from `--estimate`, and the maintainer approves it
    before the run.
  - Its precision, recall, unverified entries and cost are recorded in
    design §19, not in this ADR.

## Consequences

- **The analyzer finds what each project writes its own way,** where rules
  can't, and every value it keeps is one a person can see in the cited line.
- **A model can still be wrong inside a true line.** Example: a limit that
  belongs to another endpoint. The evidence shows the line, and the person
  approves or rejects it.
- **The repository's code and docs go to the configured model.** A hosted
  model receives them: that is the person's choice, as a hosted customer
  model is (ADR-0028). The terminal says so, with the model's url, before
  the first call. A local model keeps it all on the machine.
- **An analysis can cost money.** It is bounded by the token budget and the
  cost cap. The estimate comes first, and the cache makes reruns free.
- **Recall rises only by what can be verified.** On the demo-shop that is 7
  entries. The response contract, the capabilities, `neverFabricate` and
  `everyAnswer` remain the person's, or later ADRs'.
- **analysis.v1 gains `model`, `unverified` and `conflicts`,** additively.

## Alternatives considered

- **Trusting the model's values with their evidence as given.** A citation
  is easy to invent, and precision is what the person pays for. Rejected:
  every value is checked against its line.
- **Free-text fields, such as capabilities, now.** A model words them its own
  way, so they can't be checked or measured by equality. Rejected by the
  maintainer for this step.
- **The response contract from code types.** It would make the code define
  an expectation (ADR-0004), and the hand-written contract's choices can't be
  verified. Left to contract files, in a later ADR.
- **Sending the data files too.** Their rows may hold personal data, and the
  data step reads them already (ADR-0047). Rejected.
- **Sending test files.** Their values are fixtures, and they double the
  text sent on the demo-shop. Rejected.
- **An agent that browses the repository and picks its own files.** It
  spends unpredictably and its path varies from run to run. Rejected for
  fixed chunks in a fixed order, under a budget.
- **Analysis without a cost cap.** A large repository could spend without
  bound. Rejected: `--max-cost` is required, as for `yokla mcp`.
