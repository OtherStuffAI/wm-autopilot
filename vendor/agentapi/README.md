# AgentAPI loopback build

Autopilot's AgentAPI fallback is built from upstream `coder/agentapi` v0.12.2,
commit `9ff117e231822f670305254ef24f6389f75953f4`. Upstream binds its HTTP server
to every interface and provides no bind-address option. The patch in this
directory changes the listener to IPv4 loopback.

`bun install` prepares the binary when needed, and startup repairs a missing or
stale binary before accepting sessions. The bootstrap uses a compatible system
Go installation when available. Otherwise it downloads the checksummed pinned
Go toolchain into the ignored project-local `.cache/toolchains` directory. It
then verifies the upstream commit, applies the reviewed patch, builds
`out/agentapi`, and writes `out/agentapi.provenance.json` with hashes for both
the binary and current patch. `bun run build:agentapi-loopback` remains
available as an idempotent manual check.

A release update must preserve the real-listener isolation test before
replacing the AgentAPI or Go pins.

Host and CORS checks are retained as defence in depth; they are not treated as
network access control. AgentAPI has no application-authentication facility,
so any process running as the same host user can still reach a session through
loopback. Native agent transports remain preferable where available.
