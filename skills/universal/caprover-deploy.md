---
description: Configure and deploy an app to CapRover using Wingman MCP tools
---

# Deploy to CapRover

CapRover is a self-hosted PaaS. Wingman tracks CapRover apps locally and can deploy to them via MCP tools. This skill covers the full flow from setup to deployment.

## Prerequisites

The Wingman server must have CapRover configured:
- `CAPROVER_URL` — CapRover dashboard URL (e.g. `https://captain.example.com`)
- `LOGIN_CODE` — CapRover login password

If these are not set, CapRover tools will return a 503 error.

## Step 1: Check What's Already Tracked

Call `list_caprover_apps` (no parameters) to see apps Wingman already tracks. Each app has:
- `id` — Wingman tracking UUID (use this for deployments)
- `caproverName` — the app name on CapRover
- `liveUrl` — the app's public URL
- `deployedVersion` — last deployed version number
- `appId` — linked local Wingman app (if any)

If your app is already listed, skip to **Step 3**.

## Step 2: Register the App

If your app isn't tracked yet, register it via the Wingman HTTP API:

```
POST /api/caprover/apps
Content-Type: application/json

{
  "caproverName": "my-app",
  "createOnCaprover": true,
  "appId": "optional-local-app-uuid",
  "projectId": "optional-project-uuid",
  "notes": "What this app does"
}
```

Rules for `caproverName`:
- Lowercase letters, numbers, and hyphens only
- Must start with a letter
- Max 50 characters
- Must be unique on the CapRover instance

Set `createOnCaprover: true` to create the app on CapRover at the same time. If the app already exists on CapRover but isn't tracked by Wingman, set it to `false`.

The response includes the `id` you'll use for deployment.

## Step 3: Deploy

Call `deploy_caprover_app` with:
- `app_id` — the Wingman tracking UUID from `list_caprover_apps` (NOT the caproverName)
- `docker_image` — Docker image to deploy (e.g. `myregistry/myapp:latest`)
- `git_hash` — optional commit hash to tag the deployment

### Deploy from Docker Image

```
deploy_caprover_app(
  app_id: "tracking-uuid",
  docker_image: "myregistry/myapp:v1.2.3",
  git_hash: "abc123"
)
```

CapRover pulls the image and starts the container. This is the fastest method.

### Deploy from Local Source (Tarball)

If you omit `docker_image` and the tracked app is linked to a local Wingman app (`appId`), Wingman will:

1. Package the local app directory into a tarball
2. Upload it to CapRover
3. CapRover builds from the `captain-definition` or `Dockerfile`

The local app **must** have a `captain-definition` at its root. Wingman also accepts the legacy `captain-definition.json` filename:

```json
{
  "schemaVersion": 2,
  "dockerfilePath": "./Dockerfile"
}
```

Or use an image directly in captain-definition:

```json
{
  "schemaVersion": 2,
  "imageName": "node:20-alpine"
}
```

The tarball automatically excludes `.git`, `node_modules`, `.env`, `*.sqlite`, and other build artifacts.

## Step 4: Verify

After deployment, call `list_caprover_apps` again to confirm the `deployedVersion` incremented and note the `liveUrl`.

## Updating App Configuration

Use the Wingman HTTP API for config changes — these are not exposed as MCP tools:

```
POST /api/caprover/apps/{id}/config
Content-Type: application/json

{
  "envVars": [
    { "key": "NODE_ENV", "value": "production" },
    { "key": "DATABASE_URL", "value": "postgres://..." }
  ],
  "instanceCount": 2,
  "containerHttpPort": 3000,
  "forceSsl": true
}
```

### Enable SSL

Include `"forceSsl": true` in the config, or use:

```
POST /api/caprover/apps/{id}/config
{ "enableSsl": true }
```

### Custom Domains

```
POST /api/caprover/apps/{id}/config
{ "customDomain": "app.example.com" }
```

Point your DNS to the CapRover server first, then enable SSL on the custom domain.

## Checking Build Logs

If a deployment fails, fetch build logs:

```
GET /api/caprover/apps/{id}/logs
```

Returns CapRover build output and whether the app is still building.

## Quick Reference

| Action | Method |
|--------|--------|
| List tracked apps | `list_caprover_apps` MCP tool |
| Deploy from Docker image | `deploy_caprover_app` MCP tool with `docker_image` |
| Deploy from local source | `deploy_caprover_app` MCP tool (omit `docker_image`, requires linked local app) |
| Register new app | `POST /api/caprover/apps` |
| Update env vars / config | `POST /api/caprover/apps/{id}/config` |
| Check build logs | `GET /api/caprover/apps/{id}/logs` |
| List remote CapRover apps | `GET /api/caprover/remote/apps` |
