# App registry and session MCP custody

Autopilot owns the local application registry and process lifecycle. Shared
workspace state remains a Tower responsibility.

## Registry boundary

`data/app-registry.sqlite` is the sole steady-state app registry. Its typed
schema stores ordinary lifecycle metadata and an opaque `env_binding_id` only.
Environment values are encrypted in the separate local secret-provider store,
`data/app-registry-secrets.sqlite`, and are hydrated in memory only when an app
process is prepared. Raw signing keys are rejected by the app environment
boundary and must use capability-broker custody.

Both files use SQLite rollback journals with `synchronous=FULL` and must be on
the same filesystem. Autopilot checks that constraint, allowing SQLite's
attached-database transaction to commit metadata, bindings, verification, and
the migration marker as one atomic unit.

Legacy `data/apps.json` is a one-time migration input, never an output. The
migration validates every record, transactionally writes the registry, checks
the resulting count and critical identity fields, then records a durable
migration marker. Once explicitly retired, any reappearance of `apps.json` is
a security error.

Operator activation:

1. Stop Autopilot externally and make a private encrypted runtime backup.
2. Run `bun run apps:migrate-registry` and verify the reported app count.
3. Inspect only key names/metadata: confirm the metadata database contains no
   environment values, secret ciphertexts, or raw signing fields.
4. Run `bun run apps:migrate-registry -- --retire-legacy`. This removes the
   verified legacy input and arms the reappearance tripwire.
5. Privately retire legacy `apps.json` backups after confirming the encrypted
   backup and the new app count.
6. Remove the repository-root `.mcp.json`; startup deliberately refuses it.
7. Restart Autopilot externally, verify the app list and start/stop one
   non-critical managed app.

The age-encrypted runtime backup takes a coherently locked snapshot of both
`app-registry.sqlite` and `app-registry-secrets.sqlite` and runs SQLite
`quick_check` on both staged files. The secret-provider database contains only
ciphertext, but recovery still requires the independently custodied instance
wrapping key used by the setting-value encryption service.

## Agent MCP configuration

Claude receives a non-secret MCP config at
`data/runtime/mcp-sessions/<session-id>/mcp.json`, with directory mode `0700`
and file mode `0600`. Autopilot passes both `--mcp-config` and
`--strict-mcp-config`. The capability is inherited through the child process
environment and is not serialized. Session shutdown removes the directory;
stale directories older than 24 hours are removed before a new Claude launch.
Failure to create strict Claude configuration is fatal to that session.

Codex continues to use per-process configuration injection. Goose and OpenCode
still use their supported user configuration mechanisms; those legacy paths
are not project-root files, preserve unrelated user entries, and remove the
Autopilot entry on session cleanup. Moving them to an exclusive session-config
flag requires confirmed upstream CLI contracts.
