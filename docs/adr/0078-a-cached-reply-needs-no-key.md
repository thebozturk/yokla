# 0078. A cached reply needs no key

Status: Accepted · Date: 2026-11-20

## Context

yokla calls a model of its own in three roles: the simulated customer
(ADR-0028), the transforms that rewrite a message (ADR-0059), and the
analyzer's model step (ADR-0049). Each role caches its replies, so a rerun
on the same input costs nothing.

Each role reads its key from the environment variable `apiKeyEnv` names.
The client checks that the variable is set when it is made, before the
cache is looked at. So a rerun that every cached reply answers still stops
with "environment variable … is not set", although it would send nothing.

The rerun by hand on the private target of design §19, after ADR-0074, hit
this: every reply came from the cache, and the key still had to be loaded.
A key loaded for a run that makes no call is a secret handled for nothing.

The roles differ in what is known before the run:

- **The analyzer** asks about chunks of files. Every chunk, and so every
  cache key, is known before the first call.
- **The transforms** rewrite messages written in the cases. Their plan
  already counts the calls the cache can't answer, before the run
  (ADR-0059).
- **The customer** answers the target. Its next message depends on the
  target's last answer, so whether the cache holds it is known only during
  the run.

## Decision

- **The analyzer and the transforms ask for the key only when they call
  the model.** Their client is made at the first reply the cache doesn't
  hold. When the cache holds every reply, no client is made, and the
  variable `apiKeyEnv` names need not be set.
- **When a call is needed and the key is not set,** the error is today's, and
  says why the key is needed: "environment variable X is not
  set: the analyzer model is called for a reply not in the cache". The
  error comes before any call, so nothing is sent and nothing is spent.
  The analyzer writes no proposal, as with any other error.
- **The customer is unchanged.** Its key is checked when the run starts,
  since a missing key found during the run would stop it after cases have
  already run against the target.
- **Only when the key is checked changes.** The cache, its keys, `--max-cost`,
  the estimate and every check of a reply stay as they are.

### The tests

- **The analyzer:** a run with every reply cached and the key not set
  proposes the same entries as a run with the key, and makes no call. With
  one reply missing from the cache and the key not set, it fails with the
  message above, makes no call, and writes nothing.
- **The transforms:** the same two cases, for a run with a model transform.
- **The customer:** a run with the key not set still fails before the
  first case, as today.
- **The demo-shop end-to-end tests are unchanged.**

## Consequences

- **A rerun answered from the cache needs no secret.** It can run where
  the key is not available, such as a CI job that replays committed
  replies.
- **A missing key is found later:** at the first reply not cached, not
  when the run starts. For the analyzer that is after the probes have
  run, if any; for the transforms it is still before the first case, since
  the rewrites are made before the run. Nothing has been sent to the model
  by then.
- **The customer still asks for its key at the start,** even on a rerun
  whose replies are all cached.

## Alternatives considered

- **Check the key in the client at its first call, for every role.** The
  customer would then fail mid-run, after cases ran against the target.
  Rejected for the customer: its misses can't be known before the run.
- **Count the analyzer's cache misses before the run, and ask for the key
  only when there is one.** It finds a missing key before the probes, but
  reads the cache twice and adds a step to the plan. Rejected for now:
  making the client at the first miss gives the same result with no spend,
  and is simpler.
- **A flag that says the run must make no call.** It moves the decision to
  the person, who can't always tell. Rejected: the cache already knows.
