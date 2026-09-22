# TypeSafe production triage

The WH40K content monitor and Book of Sand production definitions use the same authority boundary:

1. Deterministic collection and evidence checks establish the candidate state.
2. Jev supplies independent typed judgments and raw probability distributions.
3. Versioned code applies explicit thresholds, weights, floors and failure policy.
4. The existing review/editorial, verification, Tower graph and publication paths retain authority.

Confidence measures distribution concentration, not correctness or permission. Provider, timeout, malformed/schema, incomplete-evidence and missing-state cases therefore preserve the authoritative path. The definitions use `failurePolicy: "record_error"`; the deterministic gate treats every recorded error as fallback rather than a negative judgment.

## WH40K

`wh40k-content-monitor-ingest.v2.json` (definition version 3) fans out newly ingested `triageItems` to Jev for relevance, duplicate likeness, review priority, evidence sufficiency and an advisory outcome. It may return `suppress_expensive_review` only when all of these are true:

- triage is enabled;
- the Jev request succeeded and evidence is `sufficient` with probability at least `0.95` and Choice confidence at least `0.90`;
- irrelevance has relevance probability at most `0.02`, plus `likely_irrelevant` probability at least `0.95` and confidence at least `0.90`; or
- duplicate likeness is at least `0.98`, supplied comparison evidence is non-empty, plus `likely_duplicate` probability at least `0.95` and confidence at least `0.90`.

Every other result is `legacy_review`. Suppression is an auditable, reversible routing outcome; it does not delete or mutate content. Set `jevTriage.enabled` to `false` for instant definition-level legacy behavior.

The current WH40K WApp CLI does not yet emit `triageItems`. The adapter exposes `triageContractAvailable: false` and an empty item list in that case, so the deployed definition behaves exactly like legacy ingestion and cannot silently lose content. Production suppression requires a later WApp-owned CLI/API contract that returns newly saved items and comparison evidence; Autopilot must not read the WApp database directly.

## Book of Sand

`book-of-sand-story-publication.v4.json` separates research from final editorial selection. It judges novelty, significance, evidence quality and editorial policy independently, then calculates a deterministic composite:

- novelty `0.32`;
- significance `0.34`;
- evidence quality `0.24`;
- policy fit `0.10`.

The shortlist targets 12 candidates, keeps at least 8 eligible candidates when available, and additionally retains every uncertain candidate (any Choice/Score confidence below `0.72`) and every high-significance candidate (score at least `1.55`). Generic crypto is excluded only when the policy answer is `generic_crypto_excluded` with probability at least `0.97`, confidence at least `0.90`, and evidence-quality score at least `1.25`. The safety floor never reintroduces such a confidently excluded candidate.

Any missing result or Jev error restores the complete researched candidate set. Set `jevTriage.enabled` to `false` for the same full-set legacy behavior. The editorial agent receives the shortlist and full audit, independently verifies it, and alone selects/writes the headline and Other Stories. Existing validation, Tower graph import/readback and Feed publication remain downstream and unchanged in authority.

Run output retains the full classifier envelopes (raw provider payload, typed distributions, request/model/provider identifiers, latency, usage and cost), deterministic thresholds/weights, rankings, shortlist, exclusions and reasons.

## Activation

The definitions are versioned and non-default. Activation requires source review, an Autopilot restart so parallel classifier support is loaded, definition selection/schedule migration to the new versions, and non-publishing smoke runs. Rollback is immediate by setting `jevTriage.enabled` to `false` or restoring the prior production definition reference. Do not activate WH40K suppression until its WApp-owned `triageItems` contract exists and has been smoke-tested.
