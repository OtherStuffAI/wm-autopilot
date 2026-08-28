# Flight Deck public asset caching and startup latency

## Goal

Fix the confirmed public delivery contribution to Flight Deck startup stalls in
`/Users/mini/code/wm/autopilot`, without restarting Autopilot itself, pushing,
deploying, or changing Flight Deck/Tower source.

Flight Deck task:
`f1391578-de8e-40ce-b918-e02068444c71` — **Fix Flight Deck public asset
caching and startup proxy latency**.

Originating Flight Deck context:

- workspace: `2e5caefd-dd65-45d2-b747-ee874e8e5fc9`
- channel: `0617d526-88dc-4dc2-9876-08349ab60eca`
- thread: `d2b49b19-6ce9-48ed-ab43-ac119e990efe`
- Pete's implementation approval message: `03201352-8e89-42f5-81b2-aeb5e8bf2a0a`
- related Flight Deck materialisation task:
  `7bb908d2-0a7c-4348-8def-2bfdbff56a45`

## Confirmed evidence

The currently managed app is `WM Flight Deck`:

- app id: `6f0542c2-9688-4f5d-8bd6-0fcc8795bbee`
- root: `/Users/mini/code/wm/flightdeck`
- runtime port: `41045`
- public URL: `https://long-tin-knob.rick.runwingman.com`

Measured with the same built Flight Deck:

- local cache-disabled browser loads reached response start in about 8–10 ms
  and `DOMContentLoaded` in about 142–149 ms;
- public cache-disabled loads reached response start in about 1.56–1.87 s and
  `DOMContentLoaded` in about 3.59–4.37 s;
- both paths had the same single browser initialization long task of about
  83–91 ms, locating the extra seconds before browser compute;
- compressed public HTML requests transferred about 117–118 KB with about
  1.07–1.08 s TTFB and 1.85–1.86 s total time;
- HTML correctly used `Cache-Control: no-cache`, but fingerprinted JavaScript
  and CSS used only `Cache-Control: max-age=30` and sampled as Cloudflare
  `REVALIDATED`, not a durable HIT.

## Required implementation

1. Read `AGENTS.md` completely. The referenced `docs/architecture.md` is absent,
   so inspect the live proxy/static-serving modules and nearest tests/docs.
2. Trace the local subdomain/public proxy path used for managed web apps.
3. Serve content-hashed immutable app assets with a policy equivalent to:
   `Cache-Control: public, max-age=31536000, immutable`.
4. Preserve revalidation/no-cache semantics for HTML entry points and other
   mutable, non-fingerprinted responses.
5. Avoid broad extension-only caching unless the filename/path is proven to be
   content-addressed. Do not make service-worker or HTML updates sticky.
6. Identify any avoidable Autopilot-side buffering, duplicate fetch, or delayed
   first byte in the public proxy path. Change only what the evidence proves.
7. Add focused regression tests for immutable hashed assets, mutable HTML, and
   representative non-hashed responses.
8. Run focused tests and the practical native Autopilot validation required by
   the touched modules.
9. Commit all compatible nonignored tested state on `main` using a Conventional
   Commit. Do not push or deploy.

## Acceptance

- Fingerprinted Flight Deck assets receive long-lived immutable caching.
- HTML remains promptly revalidated after a Flight Deck rebuild/restart.
- Focused tests prevent accidental immutable caching of mutable responses.
- Local proxy/app routing still works.
- Cold/warm response headers and timings are recorded. If Cloudflare behavior
  cannot be changed locally, distinguish the code fix from the external config
  dependency precisely.
- The worker comments on the Flight Deck task with the implementation, commit,
  tests, remaining external dependency, and originating message mention.
- The worker returns a supervised callback to the manager. It must not restart
  Autopilot or the Flight Deck app; the manager owns the approved final restart.

## Shared-tree rules

Work on `main`. Preserve concurrent state. Do not reset, restore, clean, stash,
rebase, force-push, push, deploy, or restart any managed process. Before
committing, inspect the complete worktree and include all compatible nonignored
tested state unless a clear safety conflict requires a manager decision.
