# Registered app protected environment merge

`PATCH /api/owners/:ownerNpub/apps/:appId/caprover/environment` merges runtime variables without returning the existing or submitted values. It uses the normal owner-space authorization, `deployments:manage` delegation scope, app resource filters and central `AppsManage` access check. The equivalent central app route uses the same handler and ACL.

The JSON body contains:

- `caproverName`: must match the app's existing CapRover tracking record.
- `caproverTarget`: one exact configured target name; `all` is forbidden.
- `expectedServerUrl`: must exactly match that target's configured server URL, as reported by the existing deployments read route.
- `expectedDomain`: must match a custom domain on the live remote app.
- `envVars`: a nonempty array of `{key, value}` entries to insert or replace.
- `unsetKeys`: optional explicit variable names to remove, for example when replacing file-based configuration with inline protected configuration.

Unknown fields, invalid names, duplicate keys and overlapping set/remove keys are rejected. Missing or inconsistent remote environment data fails closed. The broker reads the remote environment, retains all unrelated entries, applies the explicit removals and replacements, and sends only `envVars` through the existing partial-config PATCH client. It does not change webhook, volumes, ports or deployment settings. No environment values are included in responses or logged; errors are fixed messages and omit upstream descriptions. Success returns only the local app ID, remote app name, target name and success flag. Responses use `Cache-Control: no-store`.

The endpoint serializes its own read/merge/write requests per server URL and app name. CapRover does not provide an environment compare-and-swap contract here; avoid simultaneous edits through other administrator/configuration paths during a merge. A failed upstream operation can have an uncertain outcome; inspect through the trusted administrator surface before retrying.

The target must support the existing partial-config PATCH endpoint. Unsupported PATCH fails without a POST fallback, because a full update could reset unrelated configuration. Source tests do not establish a specific deployment target's PATCH support. Activation requires the normal explicit approval to restart Autopilot; route implementation never authorizes a restart. Protected configuration should enter through the existing body-bound capability/NIP-98 request mechanism, never raw identity keys, credentials in command arguments, or a direct CapRover call.
