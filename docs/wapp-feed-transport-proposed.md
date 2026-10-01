# Autopilot WApp feed discovery and transport — proposed

Status: **proposed / unimplemented**. Companion to canonical
[`wapp-feed-v1-proposed`, revision `1`](../../tower/docs/contract/wapp-feed-v1-proposed.md).
This is an explicitly requested product-contract proposal, an exception to this
index's usual shipped-behavior scope. It contains no runtime handoff or production
data. Canonical schemas and security rules control; revise all companion pins
in the same review. Neither new feed endpoints nor an adapter are claimed to exist.

## Discovery responsibility

Autopilot supplies authorized installed-app listings across each connected
instance, with registered installation identity, origin and selected transport.
Flight Deck selects an app, then independently authenticates the WApp's
`/feed/list`, selects a feed and saves Tower reader state. Autopilot does not own
that shared subscription state, fetch private bodies into Tower, or publish cards
under this proposal. WApps independently enforce list/feed ACL and graph visibility.

The stable source tuple includes connected-instance identity + installation ID +
feed ID. A hostname or app title is not identity. WP0 must ratify a portable logical
connection ID across clients and any registration field gaps; this document
introduces no registry API shape. Registry changes/removal invalidate the reader's
source binding; sparse metadata must not silently substitute an unrelated origin.
See [current registry ownership](app-registry-and-session-mcp-custody.md).

## Signer and FIPS boundaries

NIP-98 binds exact URL, method, freshness and signature. Bots sign as bots; owner
query parameters, app listings, transport consent and publication grants do not
turn them into the owner. Direct requests need actual-reader signing; intermediaries
need explicitly scoped delegation or the exact reader-signed target request.
No new delegation protocol is defined here. Book of Sand graph-reader forwarding
requires separate proof preserving Tower permissions; do not use broader bot
credentials to fill the gap. Keep secrets/capabilities out of feed metadata/logs.

Selected FIPS uses WMapp's endpoint/peer-pinned `window.fipsTransport` handle.
Transport authenticates neither reader nor feed, signs nothing and grants no ACL.
Offline/revoked/missing handles fail closed with no HTTPS, DNS or proxy fallback.
Direct `.fips` navigation is a separate path. WP0 must prove exact URL binding and
reader/graph access over the selected transport before claiming feed support.
No runtime restart or architecture modification follows from this document.

## Conditional A1 public adapter

A1 proceeds only if WP0 establishes public no-CORS feeds cannot use an existing
supported transport. Private Book of Sand delivery does not depend on A1. Do not
invent an adapter route, claim it already exists, or make public feed fetching a
Tower content-ingestion service. The request/response interface remains unresolved.

If selected, an authenticated bounded Autopilot adapter fetches **public** HTTP(S)
feeds without any upstream reader Authorization, cookies or credentials. Reject
userinfo and other schemes; check IPv4/IPv6 including mapped forms, DNS results,
private/loopback/link-local/reserved/metadata destinations, every redirect, and
pin validated IPs while retaining TLS hostname verification. Prevent DNS rebinding,
environment proxy bypass and alternate numeric-host bypasses. Limit redirect hops,
time, decompressed bytes, concurrency/rate and accepted content types. Proposed
maxima: 3 redirects, 10 seconds total, 2 MiB total, subject to WP0 ratification.
Never forward local NIP-98 upstream or proxy a private selected FIPS feed. XML/HTML
hardening remains mandatory in Flight Deck's normalizer even after fetch succeeds.

Acceptance: load a no-CORS public podcast; prove upstream receives no credentials;
block redirect/DNS/private IPv6/cloud-metadata access, compressed bombs, oversized
and slow feeds. Adapter errors affect one source and expose safe error codes, no
secrets. WApp direct CORS/preflight remains W1's responsibility, not a reason to
impersonate a reader through A1.

## Package and release boundary

WP0 resolves auth/transport/interface choices; T1 and W1 may then establish state
and source foundations. F1/F2 implement the reader; A1 is conditional; M1 removes
only Book of Sand's publication dependency after historical and rollback acceptance.
Retain global publishing APIs while other apps depend on them. R1 separately
requires authorized managed activation, two-reader/two-client/browser/WMapp/FIPS
and public-feed tests, source hashes, served Flight Deck build number and rollback
evidence. None was activated by this docs-only work.

See [Tower state](../../tower/docs/design/wapp-feed-state-proposed.md),
[Flight Deck reader](../../flightdeck/docs/design/wapp-feed-reader-proposed.md), and
[Book of Sand editions](../../../../wingmen/wingman21/mycode/book-of-sand-wapp/docs/wapp-feed-editions-proposed.md).
