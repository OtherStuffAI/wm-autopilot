---
description: Read other Wingman agent sessions to understand ongoing work and collaborate
---

# Read Other Wingman Sessions

Use the Wingman MCP tools to discover what other agents are working on, read their conversation logs, and coordinate.

## Discover Active Sessions

1. Call `list_sessions` (no parameters) to see all agent sessions
2. Each session includes: `id`, `agent` type, `name`, `status`, `startedAt`, `workingDirectory`, and `port`
3. Look at the `name` and `workingDirectory` to understand what each session is for

## Read Session Logs

1. Call `read_logs` with `source: "session"` and `id` set to the target session ID
2. Set `lines` (1-500, default 100) to control how much history you get
3. Logs are the agent's conversation output — messages, tool calls, and results

## Collaboration Patterns

**Observe before acting:** Read another session's logs to understand its progress before duplicating effort or making conflicting changes.

**Divide and conquer:** If you need a specialist, call `create_session` with the appropriate `agent` type, a descriptive `name`, and the right `workingDirectory`. Then periodically `read_logs` to check on its progress.

**Monitor apps too:** Call `read_logs` with `source: "app"` and the app ID to read process stdout/stderr from registered Wingman apps (not agent sessions).

## Tips

- Session IDs are UUIDs — copy them exactly from `list_sessions` output
- A session with `status: "stopped"` still has readable logs
- You cannot send messages to another session — only read its output
- If you need to coordinate, work in the same `workingDirectory` and use the filesystem (files, git branches) as the shared medium
