# 0009. Observing the target through its own logs

Status: Accepted · Date: 2026-11-10

## Context

The model proxy (design §12) sees a target's model calls only when the app's
provider base URL can be pointed at it. Some targets can't be pointed at it:
- the SDK has a fixed endpoint,
- requests are signed,
- calls go through an in-process gateway.

For such a target, cost, model calls and the path that answered are
`unmeasured`.

Many production assistants already write one structured log line per request.
The line can carry:
- the model calls and their cost,
- whether the response cache answered,
- which route answered,
- whether a search relaxed its filters.

The line is keyed by a request id that the client can set or read back.

## Decision

- **A profile may declare a log source** as an additional way to observe the
  target. A log source has:
  - **Where to read:** a local file, or a local command such as a container
    log command. A command is given as an argument list and never runs in a
    shell.
  - **How to read it:** each line is parsed as JSON. Text before the first `{`
    on a line, such as a container prefix, is ignored.
  - **How to correlate:** the request id yokla sent, or the target's own id
    from the response, matched to a field of the log line.
  - **Which fields to read:** a declarative mapping from log fields to evidence
    fields, with simple reductions such as the sum or count over an array.
    Examples are cost, model calls, a cache hit and a relaxation flag.
- **Measurements from logs are labelled by their source.** The report shows
  `source: target-logs`, because the numbers are self-reported by the target,
  unlike proxy measurements. When neither the proxy nor logs can measure a
  threshold, it stays `unmeasured`.
- **Logs never leave the machine.** Reading them follows ADR-0003. Results
  keep only the mapped fields, not the raw lines.
- **Log observation enters v0.1.** It is the only cost and path signal for
  targets the proxy can't see. The proxy stays in v0.2.

## Consequences

- **Correlation depends on a request id.** The target must accept or return
  one. Otherwise correlation falls back to order, which requires serial
  requests on an otherwise idle target. The report states which mode was used.
- **Self-reported cost can be wrong.** Where both are available, a proxy
  measurement is preferred and the two can be reconciled.
- **The log format stays the target's concern.** yokla needs only a mapping in
  the profile, never code for a particular target (P9).

## Alternatives considered

- **Proxy only.** Targets with fixed or signed endpoints would stay
  unmeasured. Rejected.
- **OpenTelemetry only.** It is a good later option (design §18), but many
  targets don't export spans while they already write structured logs.
  Deferred, not rejected.
- **Parse logs with target-specific code in a pack.** This would make yokla
  specific to one target. Rejected.
