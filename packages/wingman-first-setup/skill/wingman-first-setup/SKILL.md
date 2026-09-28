---
name: wingman-first-setup
description: "Guide a user through a first Wingman Be Free setup: Docker or native Bun Autopilot, Tower workspace, sovereign bot, and Flight Deck connection over HTTPS, local HTTP, or FIPS."
---

# Wingman first setup (pilot v0.2)

Help the user reach a verified loop: their bot runs in their Autopilot, belongs to their Tower workspace, appears in Flight Deck, and answers a test message. This is an interactive setup guide, not an unattended provisioner. Inspect the current release and its documentation before commands; setup contracts can change. Never claim a step succeeded from a command exit code alone.

## Start with a setup record

On the first run, inspect what is already installed, then ask one compact set of questions for the remaining choices: Tower origin and workspace owner, target host/OS, Docker or native Bun, transport (public HTTPS, local HTTP, FIPS only, or HTTPS plus FIPS), bot name, and agent harness. Explain any access the chosen path needs. Proceed with the answers; ask again only for a missing choice that blocks the next step. Keep choices, completed steps, observed public IDs/URLs, blockers, and next action in a short local record. Resume from observed state; do not create another workspace, bot, or connection after a restart.

Public HTTP and FIPS HTTP are distinct. Local HTTP belongs on loopback or an explicitly trusted private test network. Internet access uses HTTPS. A FIPS URL has the form http://<node-npub>.fips:<port>/ and needs a working peer; it is not a public HTTP deployment.

## 1. Preflight authority and source

- Confirm the user controls the target host and is authorized to create the Tower workspace. Identify the exact Tower service and owner. Do not assume Tower admin authority exists.
- Use the user's chosen checkout or current official Autopilot release. Read its README.md, docs/setup.md and relevant FIPS docs, plus repository agent instructions. Do not run a remote installation script unseen.
- Check disk, runtime, Docker Compose v2 or Bun, persistent storage, and the chosen harness's login requirements. Choose a durable process manager for native Bun and record backup/restart ownership.
- Keep owner, Tower service, workspace service, Autopilot installation, FIPS node, and bot npubs distinct. Never ask for an nsec, provider token, or capability in chat or Tower connection metadata. Bot private identity stays in Autopilot's vault; sessions use brokered capabilities.

## 2. Install or inspect Autopilot

- Docker: follow current docs/setup.md. Current source offers bun run docker:provision with --admin-npub, --instance-name, --env, --host-port, --base-url, and --workspace-host-path. Review the generated env without printing secrets. Use docker compose --env-file .env.<name> up -d --build, then require compose ps, bun run docker:check inside the container, health, and recent logs. Docker FIPS is in the main compose file; the old FIPS overlay is compatibility only.
- Native Bun: follow current README and .env.example; install locked dependencies, configure persistent data, owner admin npub, bind/base URL and process manager, then use the documented bun start entry point. A development shell is not the durable server. Verify process, health, logs, and restart policy. Do not copy another machine's .env or keys.
- Existing instance: inspect configuration and health first. Preserve profiles, data, and signing identities. Do not recreate, rotate, or restart merely to make steps uniform.

## 3. Configure transport

- HTTPS: configure TLS reverse proxy and real public origin. Test advertised Autopilot URL, login, health, WebSocket, and SSE through that origin.
- FIPS: follow current OS-specific FIPS installation and ingress docs. Require a ready daemon, a listening descriptor from GET /api/system/fips or bun clis/status.ts fips, the exact mesh URL, paired client node, and actual client request. Local listening does not prove remote access. Never substitute HTTPS while labelling it FIPS. FIPS-only setups must retain workable management access without assuming a public URL.
- Local HTTP: bind to loopback or the explicitly trusted test network. Record that outside clients cannot use it until a transport is added.
- If the product rejects the selected combination, capture the exact validation error and stop that branch. Do not invent an endpoint or bypass identity checks.

## 4. Create or select the Tower workspace

List the owner's existing workspaces first and reuse the intended one. Current Tower has an admin-only POST /api/v4/admin/flightdeck-pg/workspaces bootstrap route with workspace_name and creator_npub; it creates the PG workspace and defaults. Use an authorized Tower admin signing path for that exact request or the supported Flight Deck flow. A normal bot or new owner's npub is not automatically a Tower admin. Never seek a human secret as a workaround.

Read back the workspace descriptor and membership. Confirm owner npub, creator membership, app namespace, defaults, and that the user can open it in Flight Deck. If no authorized creation path exists, report this blocker precisely.

## 5. Create the bot and connect it

In Autopilot Settings, create a sovereign local agent profile for the selected harness and working directory. Current Settings generates a non-exportable bot identity. Record its public npub and agent ID. Configure harness login in the persistent server/container home without copying credentials into the setup record.

Configure Autopilot's Tower connection for the exact workspace, owner, service, and chosen transport; test before subscribing the bot. Use maintained UI/CLI/API and exact NIP-98 targets with broker authority. Grant only required workspace permissions. A 403 calls for checking target, delegation and route, not extracting a signing key.

Use Autopilot's signed short-lived Connect Package and Flight Deck's Add agent/Autopilot connection flow where available. Verify package, installation identity, and discovered bot before saving. Do not store credentials in Tower metadata. Read back the connection and workspace-agent records and check the expected workspace and bot npub.

Check the live Flight Deck connection form or API contract before creating the connection. The pilot build observed a required `fips_endpoint` even with `https_endpoint`; if that remains true and the user chose HTTPS-only or local HTTP-only, do not fabricate an endpoint. Mark connection blocked by the exact validation result; workspace and bot can still be verified separately.

## 6. Acceptance and handoff

From Flight Deck, open the workspace, see the installed bot, send one tagged test message, and observe the reply in the same thread. For FIPS, test through a paired mesh client; for HTTPS, use the public origin. Check Autopilot logs for the corresponding session and confirm retry created no duplicate records.

Finish with a compact report: hosting mode; transport and tested endpoint; workspace name/ID; bot name/npub; connection/subscription state; health and round-trip evidence; blocked step with exact error; next safe action. Never call the setup ready until the round trip works.
