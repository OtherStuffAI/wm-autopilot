# Remote Instruct

Remote Instruct exposes an operator-authored free-text prompt for remote agents.

Endpoint:

```text
GET /api/remote-instruct
```

Access uses the existing Autopilot sessions permission path. A caller must be authenticated as a user who can use Autopilot, including NIP-98 callers accepted by the normal sessions access rules. There is no separate Remote Instruct allow list.

The prompt is read from `data/remote-instruct.md`. If the file is missing, the endpoint returns `503 remote-instruct-not-configured` instead of generating fallback instructions.

Set `REMOTE_INSTRUCT_PROJECT_REFERENCE` to control the value inserted for `$project_reference`. If it is unset, the variable resolves to `autopilot`.

Supported template variables:

- `$hostname`
- `$project_reference`
- `$autopilot_url`
- `$default_workdir`
- `$agent_types`
- `$viewer_npub`
- `$auth_method`

Unknown `$variable` tokens are left in the content and returned in `missingVariables`.

Admin template editing:

```text
GET /api/remote-instruct/template
PUT /api/remote-instruct/template
```

The template routes use the existing admin/system access gate because the prompt is machine-level configuration. The Settings page exposes this editor under Settings -> Admin -> Remote Instruct.

CLI:

```bash
bun clis/remote-instruct.ts get --url http://localhost:3600
bun clis/remote-instruct.ts get --bot-crypto
bun clis/remote-instruct.ts get --json
```
