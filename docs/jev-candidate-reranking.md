# Jev candidate reranking

The `jev.rerankCandidates` declarative block is a reusable, read-only object-in/object-out stage for graph, database or fixture candidates. It asks Jev one narrow Noul question per candidate and leaves every workflow decision to deterministic code.

## Input

```json
{
  "query": "The brief or retrieval query",
  "priorContext": ["Compact prior coverage or conversation context"],
  "candidates": [
    {
      "id": "stable-id",
      "originalRank": 1,
      "title": "Candidate title",
      "provenance": { "source": "graph-or-database" }
    }
  ],
  "knownSelectedIds": ["stable-id"],
  "config": {
    "threshold": 0.5,
    "minimumShortlist": 4,
    "maximumShortlist": 12,
    "contextBudgetChars": 24000
  },
  "maxConcurrency": 8
}
```

`knownSelectedIds` is optional and used only for historical recall metrics. Candidate IDs and provenance should come from the retrieval source; the reranker does not invent durable identity.

## Definition usage

```json
{
  "name": "rerank-retrieved-candidates",
  "description": "Judge query-candidate relevance, then apply deterministic shortlist policy with all-or-nothing fail-open behavior.",
  "type": "block",
  "block": "jev.rerankCandidates",
  "input": {
    "pick": {
      "query": "$.brief",
      "priorContext": "$.recentCoverage",
      "candidates": "$.retrieval.matches",
      "knownSelectedIds": "$.knownSelectedIds",
      "config": "$.rerankPolicy",
      "maxConcurrency": "$.rerankConcurrency"
    }
  },
  "assign": "$.rerank"
}
```

The expanded block makes one OpenRouter Decisions request per query-candidate pair using `~typesafe/jev-latest`. The only model judgment is whether the supplied candidate would materially help satisfy the supplied query, considering compact prior context to identify already-covered or mismatched material.

## Deterministic policy and output

`jev.composeRerank` validates that every candidate has one successful Noul in `[0, 1]`, sorts by probability descending, and breaks ties by `originalRank` then input order. It adds the highest ranked candidates until the minimum is met, then applies the probability threshold, maximum count and estimated JSON character budget.

The output includes:

- the untouched original and selected candidate objects;
- stable ID, provenance, original rank, reranked rank, inclusion/exclusion and raw Noul probability;
- per-candidate usage, cost, latency, error and fallback state;
- request, token, cost, latency, error and fallback aggregates;
- candidate reduction and optional selected-story recall.

If one result is absent, failed, malformed or outside `[0, 1]`, the entire original candidate array is restored in original order. Valid partial probabilities and telemetry remain inspectable, but none can remove a candidate. An empty candidate array returns an empty successful result without a model request.

This block only reranks supplied objects. It has no graph-write, publication, schedule, delivery or definition-activation capability.
