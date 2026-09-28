# Private Space explanations (`space-explain.v1`)

This app-facing contract runs one bounded, tool-free model worker over reviewed
public Tower guide evidence cached by the brokered Space CLI. It does not create a shared definition, generic pipeline
run, interactive agent session, chat message, Feed item, or learner record.
The existing `learning-question` action remains a Flight Deck action.

Generic user-directory definitions already protect run and step reads. They do
not enforce this input contract or durable request/hash idempotency and they can
launch interactive sessions with separate history/analysis surfaces. This narrow
route avoids those surfaces rather than storing private input in shared runs.
There is no per-user installation of a JSON definition for this action.

## Authentication and HTTP contract

All application calls require a fresh NIP-98 event (kind 27235) signed by the
current personal identity. Sign exact public URL, HTTP method and SHA-256 of the
actual POST body bytes (`payload` tag); include a fresh nonce tag to distinguish
retry events. Reusing the HTTP request ID is correct; reusing a Nostr auth event
is rejected by the existing persistent replay cache. Do not use cookies,
publisher identity, owner overrides, private keys or a human-signed fallback.
The personal caller must have Autopilot `SessionsManage` access.

Ownership is **the verified signer**, even when broker authentication supplies
an advisory/delegated human owner. The access check also uses this signer.
Every response has `Cache-Control: no-store`. CORS permits only exact origins
configured in `SPACE_EXPLAIN_APP_ORIGINS`; no browser credentials are needed.
Preflight permits GET/POST and Authorization/Content-Type. Query parameters are
unsupported. A CLI may omit Origin and still must authenticate normally.

```
POST /api/pipelines/space-explain.v1/runs
GET  /api/pipelines/space-explain.v1/runs/:runId
GET  /api/pipelines/space-explain.v1/runs/:runId/output
```

POST takes the request directly, without an `input` wrapper:

```json
{
  "requestId": "10000000-0000-4000-8000-000000000001",
  "conceptId": "moon",
  "mode": "explain",
  "question": "Why does the Moon orbit Earth?",
  "style": "simple",
  "graphVersion": "2026-09-27.1",
  "graphHash": "<64 lowercase hexadecimal characters from the public snapshot>",
  "learnerHints": [{"conceptId": "moon", "state": "viewed", "views": 2, "due": false}]
}
```

`conceptId` is a bounded lowercase kebab ID. Mode is `explain`, `compare`, or
`check-understanding`; style is `simple`, `standard`, or `technical`.
Question is 1–2000 characters after trimming. `learnerHints` is optional, at most
six strict coarse records, with state `unseen|viewed|tested|demonstrated|remembered`,
optional views 0–1000 and optional boolean due. These are unverified tailoring
hints supplied from the caller's signed overlay, never assessment evidence.
No raw assessment answer field is accepted. Do not copy answers into questions.
`check-understanding` offers a practice prompt; it does not evaluate a submitted
assessment, assign a score, or change mastery. Compare is bounded to the focused
guide's neighbourhood. No arbitrary second-concept lookup or prompt is accepted.

Unknown fields (including npub/owner, Tower/callback URLs, channel/thread,
authority, prompt, answer, tokens) are rejected. Body limit is 16 KB.

New POST: **202** `{run, replayed:false}`. Identical retry: **200** with the same
run ID and `replayed:true`, including after reload or process replacement.
Owner + requestId + normalized schema input hash is reserved/bound atomically
in SQLite before work starts. Same requestId with changed input: **409**
`idempotency_conflict`. Different owners have independent request IDs.

Run envelope, also returned by status GET:

```json
{
  "run": {
    "contract": "space-explain.v1",
    "id": "<run UUID>",
    "requestId": "<original request UUID>",
    "scope": "user",
    "status": "running",
    "createdAt": "<ISO timestamp>",
    "error": null,
    "response": null
  }
}
```

Status is `running|completed|error`. Completed response is present in status
GET and in output GET `{response}`. Output before completion returns **409**
`output_not_ready` with status/error. Another signer gets **404**
`run_not_found`. No list, steps, events, callbacks, child runs, analysis,
session history or resume endpoints exist. Generic pipeline APIs cannot see
these IDs because this store is separate. There is no public definition with
private question defaults or a private payload hidden in a shared list.

Validated response:

```json
{
  "contract": "space-explain.v1",
  "requestId": "<request UUID>",
  "mode": "explain",
  "graphVersion": "<requested version>",
  "graphHash": "<requested hash>",
  "status": "supported",
  "claims": [{"text": "<short supported explanation>", "supportIds": ["support:<hash>"]}],
  "inferences": [],
  "unknowns": [],
  "citations": [{
    "supportId": "support:<hash>", "sourceId": "<guide source ID>",
    "targetType": "concept", "targetId": "moon",
    "url": "<exact guide URL>", "title": "<exact guide title>",
    "locator": "<exact guide locator>"
  }],
  "suggestedConceptIds": ["moon"],
  "followUpQuestion": "<optional practice question>",
  "disclaimer": "Generated explanation; assessment evidence unchanged."
}
```

`claims` is the explanation prose, split into at most six cited claims. There is
no uncited `explanation` field. Render `inferences` as **Inference**, each
`{text,basisSupportIds}`, and `unknowns` as **Unknown / not supported**.
Status `partial` requires inference or unknown labels; `supported` excludes
them. `no_supported_match` has no claims/inferences/citations and at least one
explicit unknown. No model request is needed when the guide has no supports.

Tower supports currently have tuple identity, not standalone support IDs.
The exact guide support ID is `support:` + SHA-256 of JSON array
`[targetType,targetId,sourceId,locator,summary]`. Every citation's ID, source ID,
target type/ID, URL, title and locator must exactly equal a supplied support.
Every claim/inference must use existing, cited IDs; suggested concepts must be
in the fetched guide. Schema/reference errors fail visibly. Reference validation
does not prove semantic entailment: generated synthesis must remain labelled
and never becomes independently reviewed assessment evidence.

## Runtime configuration (operator activation)

Disabled by default. Configure these in the managed server environment:

| Setting | Meaning |
| --- | --- |
| `SPACE_EXPLAIN_ENABLED=1` | Enables new request creation |
| `SPACE_EXPLAIN_APP_ORIGINS` | Comma-separated exact approved Atlas HTTPS origins |
| `SPACE_EXPLAIN_TOWER_URL` | Configured HTTPS Tower origin, no path/query/credentials |
| `SPACE_EXPLAIN_GUIDE_MANIFEST_PATH` | Absolute prepared public guide manifest path |
| `SPACE_EXPLAIN_GUIDE_MANIFEST_SHA256` | Operator-pinned SHA-256 of manifest bytes |
| `SPACE_EXPLAIN_MODEL` | Operator-selected OpenRouter model supporting JSON output |

Provider credentials use the existing classifier credential resolver (configured
classifier, caller provider setting, or instance/environment OpenRouter key).
No provider credential or Nostr private key is returned to the app. The app
runtime has no worker capability/session dependency and performs no Tower
requests. Existing broker issuance/refresh requires a live managed agent session;
a transient capability cannot become a durable app service binding. Preparation
is separate explicit public read work under that worker's own identity.

Prepare a new cache using an active worker's broker environment:

```sh
bun clis/space-explain-cache.ts --ids moon,solar-system --version VERSION --hash GRAPH_HASH --output data/space-explain-guides/NEW_CACHE
```

Preparation requires `SPACE_EXPLAIN_CLI_PATH` (absolute trusted Space CLI path),
`SPACE_EXPLAIN_TOWER_URL`, and the worker's existing `SESSION_ID`,
`WINGMAN_CAPABILITY`, `WINGMAN_URL`, `BOT_NPUB`. These are not managed app-runtime
settings. The command returns manifestPath/manifestHash/concepts; pin the first
two in server configuration. Its broker policy must allow public research GETs
for that worker. No key is read and no human authority is substituted.

Pass every published concept ID to cover the full graph (maximum 99 distinct
IDs). Preparing a subset intentionally makes other concepts `guide_not_cached`.
This is a version-pinned public guide cache, not a private learner snapshot.
There is no fallback to live reads, another graph version, or another signer.
The command refuses an existing output directory and publishes a manifest only
when every guide validates. Failed preparation leaves no usable manifest;
inspect/remove its partial directory and choose a new one for a retry.

During preparation the Space CLI receives only focused ID and pinned version,
never question/hints. A preloaded Autopilot guard permits one depth-1/13-node
walk and at most 13 distinct public `/research/concepts/:id/sources` GETs at
that version. Only NIP-98 signing/refresh at the configured broker is allowed;
redirects, other hosts, private Tower routes, learner writes and source URL
fetching are blocked. Broker `signedBy` must equal the worker's `BOT_NPUB`.
Signing is paced at 1100 ms; preparing a large cache takes minutes.

The guide must match version/hash/focus and have no missing-source notices.
Only normalized public fields are cached; extra fields are discarded. Each app
run checks manifest bytes against the operator's hash pin, configured Tower
origin, graph version/hash, concept mapping and selected guide file hash.
Missing, tampered or mismatched cache data fails visibly, never as empty state.
Up to six guide facts/24 provenance tuples, at most 24 KB of supports, enter the
model. Inconsistent source data fails rather than becoming a broad fallback.

One tool-free model request, no retry/web search/agent session. The model sees
question and coarse hints as private data; source text is untrusted data, not
instructions. Output is capped at 1800 tokens / 32 KB; whole-run deadline is
180 seconds. Provider routing requests `data_collection:deny,zdr:true` (see
[OpenRouter's provider policy](https://github.com/OpenRouterTeam/docs/blob/main/guides/routing/provider-selection.mdx)).
This is a provider routing requirement, not a claim that local code can audit
provider retention. Tell users their private question/hints go to an AI provider.

SQLite storage is `space-explain.sqlite` beside the configured pipeline DB;
protect it and its backups as private application storage. Only owner/request
IDs, input hash, times, status, sanitized error codes and validated response are
persisted. Questions, hints, raw answers, prompts, raw provider responses/errors
and source payloads are not persisted. No shared event/log/comment emission.
One active run per owner, four globally, at most 20 new runs per owner per hour.
Rate exhaustion returns **429**; matching retries still replay. Terminal runs
never relaunch. After a crash, an orphan becomes `timeout` on owner read/replay
after 180 seconds; raw input is intentionally unavailable for automatic resume.
An explicit new request ID is required for a new user-requested attempt.

## Atlas integration and activation checks

1. Add the approved Autopilot origin to the Atlas managed config/native signing
   policy. Keep personal learning calls direct to Tower. Verify the caller's
   real signer and Autopilot permission; do not route through Rick as Pete.
2. Persist a pending UUID + exact normalized request in identity-partitioned
   Dexie before POST. Do not persist raw assessment answers in this flow.
   Reuse the same UUID/input on uncertain retries; sign a fresh event each time.
3. Store run ID and validated response in that identity's Dexie, then render via
   Alpine/liveQuery. Poll signed status every 2 seconds, backing off to 5–10.
   Reload retrieves the existing run or replays the same POST; never creates an
   automatic replacement request. Clear visible state on identity change.
4. Render cited claims, labelled inference/unknown, practice prompt and
   disclaimer. Keep true tests/mastery on Tower's reviewed assessment flow.
   Show `running`, `error`, unsupported result, and retry conflict explicitly.
5. Rick prepares/pins the public guides, then verifies approved-origin preflight, signed creation/status/output,
   replay/conflict, provider timeout and a second test identity's denials using
   Rick-only test data. No Pete/child run is needed for implementation validation.

Source tests use disposable stores and worker stubs. They cannot prove installed
runtime config, broker policy, provider behaviour, browser/native signing policy
or actual learner permission. This change adds imported TypeScript route code;
a normal non-watch Autopilot host must load it through an operator-approved
restart/deployment. Merely loading a JSON definition will not activate it.
No restart or runtime activation is part of source validation.
