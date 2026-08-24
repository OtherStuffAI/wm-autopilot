# AgentAPI loopback build

Autopilot's AgentAPI fallback is built from upstream `coder/agentapi` v0.12.2,
commit `9ff117e231822f670305254ef24f6389f75953f4`. Upstream binds its HTTP server
to every interface and provides no bind-address option. The patch in this
directory changes the listener to IPv4 loopback.

Rebuild with `bun run build:agentapi-loopback`. The build script verifies the
upstream commit, applies the reviewed patch, builds `out/agentapi`, and writes
`out/agentapi.provenance.json` with the resulting SHA-256 digest. A release
update must preserve the real-listener isolation test before replacing this
pin.

Host and CORS checks are retained as defence in depth; they are not treated as
network access control. AgentAPI has no application-authentication facility,
so any process running as the same host user can still reach a session through
loopback. Native agent transports remain preferable where available.
