# 0016. Streaming targets, session setup, and model calls after the answer

Status: Accepted · Date: 2026-11-11

## Context

v0.2's exit criterion needs one real target whose cost reconciles with the
provider's usage records (ADR-0012). The open-source shopping assistant
chosen for it does three things yokla can't handle yet. They are common in
sales assistants, so each needs a general answer, not one for this target
(P9):
- **It streams its answer** as server-sent events: text pieces, tool calls,
  cart updates, then an event that ends the turn. yokla reads a target's
  answer only from one JSON body.
- **It opens a session with its own request.** A conversation starts with a
  request that returns a session id; every turn then sends it in a header.
  yokla can carry a value from one turn's answer into the next, but has no
  request before the first turn.
- **It calls its model after answering.** After the stream ends, it starts a
  memory-extraction call in the background and doesn't wait for it. In
  `serial` correlation, that call races the runner marking the next turn, so
  it can be counted for the wrong turn. The last turn's call can start after
  the recording closes and is then never recorded, and the run's cost no
  longer reconciles.

## Decision

- **Streaming answers.** `target.response.stream` declares an event stream:

  ```yaml
  response:
    stream:
      format: sse                 # sse or ndjson
      event: $.type               # optional: where an event's name is in its data
      text: { event: text_delta, from: $.text }
      done: turn_complete         # optional: the event that ends a complete answer
      error: { event: error, from: $.message }   # optional
    text: $.text
    route: $.last.turn_complete.route
    evidence:
      products: { items: '$.all.ui[*].products[*]', fields: { ... } }
  ```

  - **Event names.** An event's name is the SSE `event:` field. When
    `stream.event` is set, it is that path in the event's data instead. An
    SSE event without a name is `message`, as the SSE standard says.
  - **One document from the stream.** yokla turns the stream into one JSON
    document, and the profile's existing paths read it as they read a JSON
    body (`text`, `route`, `id`, `evidence`, `session.carry`):
    - `text`: the `text` pieces joined in order;
    - `events`: every event in order, as `{event, data}`;
    - `all`: per event name, the data of each occurrence;
    - `last`: per event name, the data of its last occurrence.

    Data that isn't JSON, such as `[DONE]`, is kept as a string.
  - **Incomplete answers.** With `done` declared, a stream that ends without
    that event is an incomplete answer. So is a stream that carries the
    `error` event. The turn is an error, or under faults a finding
    (ADR-0013).
  - **Time to first text.** The results add, additively, `firstTextMs` to
    the response: the time from the request to the first text piece.
    Latency stays the time to the full answer. The size limit and the
    timeout apply to the whole stream.
- **Session setup.** `target.session.open` is a request sent once per
  sample, before the first turn, after the cache bypass:

  ```yaml
  session:
    open:
      request: { url: 'http://127.0.0.1:8000/api/session', method: POST, body: {} }
      carry: [{ name: sessionId, from: $.session_id }]
  ```

  - Its carried values join `{{carry.NAME}}` for every turn of the sample,
    in bodies and in headers.
  - If it fails, or a carried value is missing, the sample's first turn is
    an error, as with a failed cache bypass.
  - It isn't a turn: no checks, and no latency.
- **Model calls after the answer.** The proxy can wait until the target's
  model calls have stopped.
  - **The settle call.** `POST /_yokla/recordings/<id>/settle` with
    `{quietMs, maxWaitMs}` returns once no call of the recording is in
    flight and none has started or ended for `quietMs`. If `maxWaitMs` runs
    out first, it returns and says the target never went quiet.
  - **`serial` correlation settles after every answer,** before the runner
    marks the next turn. A call the target makes after its answer then
    belongs to the turn that caused it. The wait isn't part of the turn's
    latency.
  - **Every recording settles before it closes,** in either correlation
    mode, so calls after the last answer are recorded.
  - **Settings.** `modelProxy.settle` sets `quietMs` (default 250) and
    `maxWaitMs` (default 10,000).
  - **A target that never goes quiet.** The turn gets an issue saying that
    later calls may be counted for the next turn, and the run goes on.
- **The demo-shop shows all three.** None of this can be tested without
  them, and the demo-shop has none of them today.
  - It can answer as an event stream.
  - It can open sessions on the server.
  - With the model over HTTP, it can make a summary call in the background
    after each answer.
  - A streaming variant of the acceptance run passes as the JSON one does.
    Its cost reconciles with the fake provider call for call, and every
    background call is counted for its own turn.

## Consequences

- **Serial runs take longer,** by about `quietMs` per turn.
- **A turn's cost includes its calls after the answer.** That is the true
  cost of the turn, and `cost-budget` judges it.
- **Profiles can describe more targets** without code: streaming answers in
  two formats, and sessions the target issues. WebSocket and other
  transports come with v0.3.
- **A call that starts later than `quietMs` after the last activity is still
  missed.** A target with such delays needs a larger `quietMs`.

## Alternatives considered

- **Reading streams with a script in the profile.** It would handle any
  format, but it puts code into configuration that must otherwise be
  reviewed as data. The declarative form covers SSE and NDJSON. Deferred.
- **Counting calls by time** (a call that starts soon after an answer belongs
  to it). That is the clock-based attribution ADR-0012 replaced with marks
  after it misattributed calls.
- **A fixed pause after each turn.** It is either too long or too short. The
  proxy knows exactly which calls are in flight.
- **The runner polling the proxy's records until they stop changing.** It
  makes more control calls and can't see a call still in flight. The proxy
  can.
- **Relying on `header` correlation.** It works only when the app passes the
  trace into its background work, which it rarely does.
