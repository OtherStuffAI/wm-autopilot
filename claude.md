# Wingman V2 - AI Agent Orchestration Platform

## Project Overview

Wingman V2 is a TypeScript-based AI agent orchestration platform built on Bun that provides a unified control plane for managing multiple AI agent sessions (Codex, Claude, Goose, OpenCode) from a single web interface. The system features real-time communication, Nostr-based identity management, project tracking, and encrypted todo management with Cashu ecash integration.

## Repository Guidelines

- The server.ts and ui/app.js files are getting long and hard to reason about
- Please ensure these files are being refactored when we touch them
- Don't add functions directly - create well structured code, helpers, utils, routes etc and reference them
- When you update code look for ways to refactor and simplify the code base into a cleaner structure
- When adding or moving files under `src/ui`, make sure the static asset service serves them with the correct MIME type (`application/javascript` for modules) so browsers don't block them with `Loading module ... was blocked because of a disallowed MIME type ("text/plain")`

> **Heads-up:** We've repeatedly hit runtime `ReferenceError` issues when arrow-function declarations are referenced before they're defined. When adding new helpers, make sure their definitions appear before any usage (or use function declarations) so the bundle doesn't fail during startup.

## Project Structure & Module Organization

Wingman V2 centers on Bun services in `src/`. `src/server.ts` exposes the HTTP API/UI, `src/agents/` directs session orchestration, and `src/ui/` serves the dashboard bundle. Persisted state lives in `data/`. Keep compiled binaries in `out/agentapi`; the Bun source should not write there at runtime. `Examples/` holds multi-session demos, with `Examples/Example Web Interface` showcasing a reference frontend. Static assets served directly go in `public/`. Review `docs/architecture.md` before reworking subsystems.

### Core Architecture Components

**Backend (Bun/TypeScript)**:

- `src/server.ts` - Main HTTP API and static file server
- `src/agents/` - Agent lifecycle management and process orchestration
- `src/storage/` - Persistent data stores for sessions, messages, and user data
- `src/auth/` - Session management and access control
- `src/ui/` - Frontend JavaScript modules served to browsers
- `src/todos/` - Encrypted todo system with Cashu integration
- `src/projects/` - Project tracking and management
- `src/logging/` - Centralized logging infrastructure

**Frontend (Vanilla JS)**:

- `/home` - Session dashboard for starting/stopping agents
- `/live` - Real-time tabbed interface showing agent conversations and logs
- Modular ES6 architecture with state management

## Build, Test, and Development Commands

Run `bun install` after pulling dependencies. Start the orchestrator locally with `bun start` (alias `bun run src/index.ts`), which respects environment settings from `src/config.ts`. Use `bun run --watch src/index.ts` while iterating to reload on change. Execute `bun test` to run TypeScript tests; add focused runs with `bun test path/to/file.test.ts`. The browser-side bunker client is pre-bundled; when applesauce dependencies change, regenerate it with `bun run build:bunker-client` before serving the dashboard.

## Process Safety

Do not restart, stop, kill, or replace the running Wingman Bun process from inside an agent session. In local Bun process-manager mode, the agent session is a child of the same Wingman host; restarting `bun start`, `bun run src/index.ts`, killing the parent PID, or running local restart scripts can terminate active sessions including your own. If code changes require a server restart, finish the change, state that a restart is required, and let the operator restart Wingman from outside the managed session. Only use `/api/system/restart`, `bun clis/status.ts restart`, or any restart script when the user explicitly asks for a restart and acknowledges active sessions may be interrupted.

## Autopilot Pipeline Authoring

When creating or editing declarative pipelines, add human-readable `display.in` and `display.out` metadata to every non-trivial step. Display rows should explain the business payload moving through the step, not expose routing or runtime plumbing. Prefer labels such as `Chat Message`, `Thread`, `Company`, `Summary`, `Approved`, `Sources`, and `Webhook Delivered`; point each label at the meaningful nested JSON path rather than showing parent objects as `5 fields`. Use `format: "text"`, `"messages"`, `"records"`, `"list"`, or `"count"` where useful, and keep rows compact. Skipped steps intentionally show no data rows in the Pipelines UI, so put the reason in the step `description` or `when` condition.

## Coding Style & Naming Conventions

**YOU SHOULD GIT COMMIT EACH CHANGE YOU MAKE WITH A DESCRIPTIVE NAME**

**NEVER PUSH CHANGES TO GIT - I WILL DO THAT MANUALLY AFTER REVIEWING.**

Tell me in your wrap up message what the git commit message was.

TypeScript is the default; prefer ESM imports and explicit extensions when needed (`./foo.ts`). Use two-space indentation, trailing semicolons, and single quotes only inside template literals. Name files with kebab-case, classes/types with PascalCase, and functions or variables in camelCase. Co-locate agent helpers under `src/agents/` and UI utilities under `src/ui/` to keep files under 400 lines. Follow the strict TypeScript configuration in `tsconfig.json`; address compiler warnings before committing.



Keep changes tightly scoped: satisfy the request with the smallest viable diff unless the user explicitly asks for broader refactors.

When summarising your activity, please state what can be tested currently and if there is remaining work to complete.

## Technology Stack

- **Runtime**: Bun (TypeScript ESM)
- **Backend**: Custom HTTP server with WebSocket support
- **Frontend**: Vanilla JavaScript ES6 modules (migrating to Dexie + Alpine)
- **Process Management**: Node PTY for terminal sessions
- **Identity**: Nostr protocol with applesauce libraries
- **Persistence**: File-based stores (JSON/encrypted)
- **Cryptography**: Noble cryptography libraries (@noble/hashes, @noble/ciphers)

## Frontend Architecture (Migration Target)

We are migrating the frontend to a **Dexie + Alpine** architecture. When making frontend changes, follow these patterns:

### Core Stack

- **Dexie.js** — All client state lives in IndexedDB via Dexie
- **Alpine.js** — Reactive UI binds directly to Dexie queries
- **Backend DB** — PostgreSQL or SQLite as source of truth

### State Management Rules

- Browser state is Dexie-first; never store app state in memory-only variables
- UI reactivity comes from Alpine watching Dexie liveQueries
- All user-facing data reads come from Dexie, not direct API responses
- No raw `fetch` results displayed directly — always write to Dexie first

### Secrets & Keys

- Store keys/passwords/tokens **encrypted** in IndexedDB
- Encrypt with a key derived from user passphrase (e.g., PBKDF2 + AES-GCM)
- Never store plaintext secrets; decrypt only when needed in memory

### Sync Strategy

- **Real-time**: WebSocket/SSE for server→client pushes; upsert into Dexie on receive
- **Page Load**: `GET /sync?since={timestamp}` for incremental sync
- **Offline**: Queue mutations with `pending: true` flag, flush on reconnect
- Sync timestamps on every record for incremental sync

### Dexie Schema Conventions

```javascript
db.version(1).stores({
  items: '++id, visitorId, [syncedAt+id], *tags',
  secrets: 'id',           // encrypted blobs
  syncMeta: 'key'          // lastSyncTimestamp, etc.
});
```

### Alpine Integration Pattern

```javascript
Alpine.store('items', {
  list: [],
  async init() {
    liveQuery(() => db.items.toArray())
      .subscribe(items => this.list = items);
  }
});
```

## Key Features

1. **Multi-Agent Session Management**: Orchestrates concurrent AI agent sessions with dedicated port allocation (default range 3700-3710)
2. **Real-time Communication**: WebSocket-based live streaming of agent conversations, logs, and terminal output
3. **Identity & Authentication**: Nostr-based identity system with session cookies and role-based access control
4. **Project & Todo Management**: Built-in project tracking and encrypted todo system with Cashu ecash wallet integration
5. **File Monitoring**: Configurable file watchers with automated triggers
6. **Terminal Integration**: PTY support for shell access and terminal-based agents

## Testing Guidelines

Place unit tests beside the code (`feature.test.ts`) or in a sibling `__tests__` folder. Mock subprocesses via lightweight stubs rather than spawning real CLIs. Keep coverage meaningful around session lifecycle code (`ProcessManager`), especially port allocation and cleanup. Add regression tests when modifying API contracts in `src/server.ts`.

## Commit & Pull Request Guidelines

Write imperative, present-tense commit subjects ≤72 characters (e.g., `Add process log streaming guard`). Separate logical changes into individual commits. PRs should describe scope, risks, and any configuration changes (env vars, ports). Link issues when relevant and include screenshots for UI tweaks (`/home`, `/live`).

**NEVER add Claude/AI attribution to commit messages or code comments.** Keep commits clean and professional.

## Agent & Configuration Tips

Confirm agent binaries (`out/agentapi`, `codex`, `claude`, `goose`, `opencode`) resolve on `$PATH` or override via environment variables listed in `README.md`. Update `DIRECTORY_DEF` when demos rely on alternate working directories. Document sensitive configuration changes in `docs/` so other agent operators can reproduce them.

## Environment Configuration

| Variable         | Description                                                                    | Default                 |
|------------------|--------------------------------------------------------------------------------|-------------------------|
| `PORT`           | Primary Wingman UI/API port                                                    | `3600`                  |
| `AGENT_PORTS`    | Starting port assigned to agent subprocesses                                   | `3700`                  |
| `AGENT_MAX`      | Total number of concurrent agent ports available                               | `10`                    |
| `DIRECTORY_DEF`  | Working directory used when launching agent subprocesses                       | `~/code`                |
| `FOLDERACCESS`   | Comma-separated directories exposed to file browsers and pickers               | `DIRECTORY_DEF`         |
| `AGENT_SPAWN_MODE` | Agent launch mode: `bun`, `pm2`, or `tmux`                                  | `bun`                   |
| `AGENT_TMUX_SESSION` | Tmux session used for tmux-spawned agent windows                          | `wm-ap-agents`          |
| `AGENT_MODE`     | Deprecated compatibility input                                                | unset                   |

## Important Implementation Notes

- Always use stated libraries for cryptography if you are unsure ask
- Do not hardcode variables to make things work
- You should think carefully before acting
- Maintain strict module boundaries and file size limits
- Follow the existing patterns for authentication and session management
- Use the existing logging infrastructure rather than console.log
- Respect the Nostr identity system when implementing user features
