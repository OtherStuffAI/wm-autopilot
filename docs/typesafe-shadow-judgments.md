# TypeSafe decisions in shadow pipelines

Autopilot classifier steps can call OpenRouter's Decisions API for TypeSafe/Jev judgments. This is separate from the default JSON chat-completion classifier mode: Decisions models reject `/api/v1/chat/completions` and require `/api/alpha/decisions`.

Contract verified on 2026-09-18 with `~typesafe/jev-latest`: OpenRouter resolved the alias to `typesafe/jev-1.13-20260917`. A successful response contained `model`, typed `answers`, `usage.input_tokens`, `usage.output_tokens`, `usage.cost`, `id`, and `provider`. Noul answers contained a yes probability; Choice and Score answers contained probabilities and confidence. OpenRouter did not return a server latency field, so Autopilot records measured end-to-end `latencyMs` around the request. See the [TypeSafe API reference](https://docs.typesafe.ai/api) and [OpenRouter model page](https://openrouter.ai/~typesafe/jev-latest/).

Use `mode: "decisions"`, put the domain state in the step input, and define narrow `noul`, `choice`, or `score` questions in the pipeline definition. The runner sends the selected input as `state`, keeping domain policy reviewable in the versioned definition.

```json
{
  "name": "shadow-judge",
  "description": "Evaluate an advisory signal without changing the business result.",
  "type": "classifier",
  "provider": "openrouter",
  "mode": "decisions",
  "model": "~typesafe/jev-latest",
  "failurePolicy": "record_error",
  "retries": 1,
  "timeoutMs": 10000,
  "input": { "pick": { "item": "$.item", "policy": "$.policy" } },
  "questions": {
    "relevant": {
      "type": "noul",
      "instructions": "Is `item` relevant under `policy`?",
      "criteria": { "true": "Directly relevant", "false": "Not relevant" }
    }
  },
  "assign": "$.shadow"
}
```

Successful results include `answers`, the untouched provider payload in `raw`, requested and resolved model identifiers, provider, request ID, measured latency, usage, and cost when OpenRouter returns it. The runner marks the envelope `authoritative: false` and `advisoryOnly: true`.

For a non-gating shadow, set `failurePolicy: "record_error"`. Transport, timeout, JSON, or schema failures then produce `shadowStatus: "error"`, an empty answer set, and a visible error string while later business steps continue. Do not interpret a shadow error as a negative or confident judgment. Omit this policy for authoritative classifiers that should fail their pipeline.

Choice and Score confidence describe how concentrated the returned distribution is. Noul is itself the probability of yes and has no separate confidence. Thresholds and any action remain deterministic application policy; typed output is not permission to mutate state.
