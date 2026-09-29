# Calling Autopilot pipelines

Autopilot hosts its API reference at `/api/docs` and machine-readable OpenAPI at
`/api/docs/openapi.json`. URLs use the current installation origin. The maintained
specification is generated from `src/api-docs/openapi.ts`, schemas and the curated
endpoint catalog; tests parse it and check examples, routes and authority metadata.
The reference, OpenAPI definition and locally served Swagger UI assets are public;
reading them requires no signer, including on mobile browsers. Protected interactive
requests require a NIP-07 browser signer; each request gets a fresh signature,
including identical retries within one second. No private key is sent to Autopilot.

## One start endpoint, three modes

`POST /api/pipelines/definitions/{id}/runs` accepts a JSON object:

```json
{"mode":"wait","waitSeconds":60,"idempotencyKey":"report-01","input":{"topic":"Quarterly report"}}
```

- `wait` is the default. HTTP execution wait is capped at 60 seconds. A terminal
  run returns HTTP 200, including pipeline failure; inspect `status` and `error`.
  If the deadline expires, HTTP 202 includes `timedOut: true` and the **same** run
  ID and polling URL. Execution continues. No second run is started.
- `poll` returns HTTP 202 as soon as the run is durably accepted. Existing
  `?async=1` selects this mode when `mode` is omitted; explicit mode wins.
- `webhook` returns HTTP 202 immediately after durable acceptance and registration
  of a result delivery. Include `"webhook":{"url":"https://receiver.example/result"}`.
  Polling remains available regardless of delivery failure.

Set `waitSeconds` to a number between 0 and 60 for a shorter execution wait.
Validation and authentication happen before acceptance. Invalid bodies, modes,
waits, keys or destinations return HTTP 400; authentication/authorization uses
401/403, missing or foreign resources 404, idempotency conflicts 409, unexpected
pre-acceptance failures 500, and missing webhook signer service 503. A client or
proxy disconnect does not cancel an accepted run. If a response is lost, retry
with the same idempotency key and a **fresh** signature.

Start, polling and webhook responses share these fields:

```json
{
  "runId":"8b7e40cc-540b-4ab3-9049-f21c997562a1",
  "status":"ok",
  "terminal":true,
  "result":{"summary":"Ready"},
  "error":null,
  "pollingUrl":"/api/pipelines/runs/8b7e40cc-540b-4ab3-9049-f21c997562a1",
  "deliveryUrl":"/api/pipelines/runs/8b7e40cc-540b-4ab3-9049-f21c997562a1/delivery"
}
```

`GET /api/pipelines/runs/{id}` always supplies the top-level result envelope.
Legacy `run` and `steps` remain. Existing payload query switches still work.
Terminal status is determined by `completedAt`; `ok`, `error`, `needs_input`,
`skipped` and `cancelled` can be terminal. `needs_input` is a halted result for the
caller to handle. Start responses additionally include `timedOut` and `replayed`.
HTTP 200 from polling means the read succeeded; inspect `terminal` before using
`result`. Webhook bodies add `deliveryId`.

## Idempotency and ownership

Use body `idempotencyKey` (recommended because NIP-98 signs the body) or
`Idempotency-Key`. If both are present they must match. Keys are nonempty strings
up to 200 characters, scoped to the effective authorized caller and resolved
pipeline definition ID. Canonically equivalent JSON input and the same normalized
webhook URL return the original run. Different input or webhook target returns
409. Wait settings can change on a retry; mode can change between wait/poll when
the target remains unchanged. A webhook registration cannot be added or removed
by reusing an existing key. Keys have no automatic expiry. Without a key, every
POST intentionally starts another run.

New calls through this start endpoint are private to their owner, including when
the selected definition is shared. Legacy shared runs retain the installation's
existing visibility policy. Current `sessions:manage` approval/admin/execution
rules remain in force; merely signing with a new identity grants no execution
permission. NIP-98 preserves the signer as effective caller; advisory bot ownership
is not an execution grant. Learning definitions retain their stricter existing
input and session-bound Tower requirements and `input.idempotencyKey` behavior.

## Exact NIP-98 signing

The authorization header is `Nostr <base64(JSON signed event)>`. Sign kind 27235,
empty content, the current timestamp, exactly one `u` tag containing the absolute
public URL including query encoding/order, and exactly one `method` tag with the
uppercase HTTP method. Every nonempty body requires exactly one `payload` tag
with hex SHA-256 of the actual transmitted bytes. An empty body must omit it.

Events older than 60 seconds, over 15 seconds in the future, or already consumed
are rejected. Re-sign every poll/retry; never reuse the auth event. Behind a proxy,
the configured Autopilot public base URL supplies the signed origin while retaining
the request path and query. Configure that public URL correctly at activation.

Browser example (use your trusted installation origin):

```javascript
async function signedJson(url, method, payload) {
  const body = payload === undefined ? undefined : JSON.stringify(payload);
  const tags = [["u", url], ["method", method]];
  if (body !== undefined && body.length) {
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
    tags.push(["payload", [...new Uint8Array(hash)]
      .map(byte => byte.toString(16).padStart(2, "0")).join("")]);
  }
  const event = await window.nostr.signEvent({
    kind: 27235, created_at: Math.floor(Date.now() / 1000), content: "", tags,
  });
  return fetch(url, {
    method, credentials: "omit",
    headers: { Authorization: `Nostr ${btoa(JSON.stringify(event))}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body }),
  });
}
const origin = "https://autopilot.example";
const start = await signedJson(`${origin}/api/pipelines/definitions/report/runs`, "POST", {
  mode: "poll", idempotencyKey: "report-02", input: { topic: "Quarterly report" },
});
if (!start.ok) throw new Error(`Start failed: ${start.status}`);
const accepted = await start.json();
// On a later poll, obtain another signature. Do not issue another start.
const poll = await signedJson(new URL(accepted.pollingUrl, origin).href, "GET");
if (!poll.ok) throw new Error(`Poll failed: ${poll.status}`);
const result = await poll.json();
```

An independently hosted browser site needs an explicit exact-origin allowlist:

```text
WINGMEN_PIPELINE_CORS_ORIGINS=https://site.example,https://second.example
```

Unset means cross-origin access is denied. No wildcard, `null` origin, cookie
credentials or auth bypass is supported. Preflight permits GET/POST and
Authorization, Content-Type, Idempotency-Key only for definition listing, start,
run polling, delivery inspection and signer discovery. Other API families do not
inherit this CORS policy.

## Receiving signed result webhooks

Discover and pin the expected instance public key using authenticated
`GET /api/pipelines/webhook-signer` on a trusted Autopilot host. It returns only
`pubkey` and `scheme`; callers never receive an instance credential or signer.

Deliveries use NIP-98 with that instance key, exact receiver URL, POST and SHA-256
of the immutable body. Signed `delivery`, `run` and `attempt` tags identify the
stable delivery ID, run ID and attempt number. The body contains `deliveryId` and
`runId`; `X-Wingman-Delivery-Id`/`X-Wingman-Run-Id` match them. Verify the event
signature, pinned key, kind, timestamp, exact public receiver URL/method/body hash,
and identity tags before accepting it. Do not trust the headers alone.

Receivers must atomically persist a unique `deliveryId` with their business effect
(or transactional outbox). A valid duplicate of an applied delivery must return
2xx. Do not deduplicate on the changing Nostr event ID. Each retry is freshly
signed, including an attempt tag. This is at-least-once delivery, not exactly-once
business execution. The first captured terminal payload remains immutable across
retries, including after a manual run resume.

`GET /api/pipelines/runs/{id}/delivery` returns the run envelope plus `delivery`:
null without a webhook, otherwise `id`, `runId`, `url`, `status`, `attempts`,
`nextAttemptAt` (Unix milliseconds), `lastError`, `lastHttpStatus`, `deliveredAt`.
The stored signed-body payload is not exposed here. Only the run owner can read
this record. Status is pending/delivering/delivered/failed, independent of execution.

The worker waits for terminal execution, claims a durable 30-second lease and
tries at most five times. Failed attempts retry after 1, 2, 4 and 8 seconds.
Transport has a 10-second deadline, DNS a 5-second deadline. A process interruption
recovers the same delivery after the lease expires; interruption counts as an
attempt. Non-2xx, timeouts, unsafe destinations and network failures consume retries.
Only public HTTPS destinations on port 443 without credentials or fragments are
allowed. Every attempt revalidates all DNS answers, rejects private/reserved and
transition ranges, pins an approved address and retains TLS hostname verification.
Redirects are never followed. Polling remains usable when delivery is exhausted.
These result webhooks are separate from internal agent-step token callbacks.

## Catalog scope and maintenance

The OpenAPI catalog includes selected pipeline, session, app, WApp, scheduler,
filesystem, delegation, agent-chat and control-plane operations whose dispatch
actually resolves NIP-98. Each inventory entry records its source and access policy.
Variable DTOs in inventory-only operations remain open rather than inventing a
contract. The three call modes, polling, delivery and signer endpoints have explicit
schemas/examples. Cookie-only management, internal signing/MCP broker APIs,
agent-step callbacks and separately configured HTTP triggers are excluded.

`@apidevtools/swagger-parser` is pinned to 12.1.0 because the repository's js-yaml
4.x override is incompatible with parser 13.x's js-yaml 5.x imports. Schema and
example validation additionally uses Ajv. Swagger UI is a production dependency.

Source validation can run without restarting the host:

```sh
bun test ./src/api-docs/openapi.test.ts ./src/pipelines/public-call-api.test.ts ./src/pipelines/result-webhooks.test.ts
bun run typecheck
```

Live activation requires an operator-authorized Autopilot restart/rebuild, correct
public base URL and browser-origin configuration, then a smoke test for fresh
NIP-98 start/poll/wait timeout and a signed delivery to a public receiver. The
source tests use a fake wait clock and isolated local HTTP docs server; they do not
activate or restart the managed host.

References: [NIP-98](https://github.com/nostr-protocol/nips/blob/master/98.md),
[Swagger UI installation](https://swagger.io/docs/open-source-tools/swagger-ui/usage/installation/).
