// Safe, generic API records for the isolated full-app browser review.
const timestamp = "2026-01-01T09:00:00Z";
const sessions = Array.from({ length: 5 }, (_, i) => ({
  id: `review-session-${i}`, name: i === 0 ? "Review responsive layouts and long session names on a phone" : `Example session ${i}`,
  agent: "codex", status: i === 2 ? "stopped" : "running", agentRuntimeStatus: "idle",
  workingDirectory: "/workspace/example-project/long-directory-name", createdAt: timestamp,
  startedAt: timestamp, ownerNpub: "npub1syntheticreview", origin: { type: i === 4 ? "agent-chat" : "ui" },
}));
export const responses: Record<string, unknown> = {
  "/api/config": { adminNpubs: ["npub1syntheticreview"], defaultDirectory: "/workspace", agents: [{ id: "codex", name: "Codex", available: true }], defaultAgent: "codex", terminalConfigured: true, giteaUrl: "https://git.example.com", webAppBaseUrl: "https://apps.example.com", featureFlags: { projects: true, pipelines: true } },
  "/api/sessions": { sessions, identities: [{ npub: "npub1syntheticreview", alias: "Mobile reviewer" }], filters: { npub: "all" } },
  "/api/apps": { apps: [{ id: "review-app", label: "Example application with a longer descriptive name", name: "Example application", status: { status: "running", updatedAt: timestamp }, root: "/workspace/example-project", port: 4100, createdAt: timestamp, logs: [], ownerNpub: "npub1syntheticreview" }] },
  "/api/feature-flags": { flags: [{ key: "nightwatch_enabled", label: "Night Watch", state: "on" }, { key: "projects_visibility", state: "on", label: "Projects", description: "Manage project directories and linked applications", enabled: true, defaultEnabled: true }, { key: "scheduler", state: "on", label: "Pipelines", description: "Reusable automation workflows", enabled: true, defaultEnabled: true }] },
  "/api/npub-projects": { projects: [{ id: "example-project", name: "Example application project", description: "A project with a longer description to check phone wrapping", rootPath: "/workspace/example-project", root: "/workspace/example-project", directory: "/workspace/example-project", createdAt: timestamp, apps: [] }] },
  "/api/docs/tree": { path: "/workspace", displayPath: "Workspace", parent: null, entries: [{ name: "example-project", path: "/workspace/example-project", type: "directory" }, { name: "long-review-notes-for-phone-layout.md", path: "/workspace/long-review-notes-for-phone-layout.md", type: "file", previewable: true, format: "markdown", size: 2048 }] },
  "/api/chats": { chats: [{ id: "example-chat", name: "Example private conversation", updatedAt: timestamp }] },
  "/api/owners/npub1syntheticreview/delegations": { delegations: [] },
  "/api/identity/profile": { profile: { name: "Mobile reviewer" } },
  "/api/bot-keys/me": { botNpub: null },
  "/api/user/settings": { settings: {} },
  "/api/system/restart": { available: true, restarting: false },
  "/api/auth/keyteleport/config": { enabled: false },
  "/api/admin/users": { users: [{ npub: "npub1syntheticreview", nickname: "Mobile reviewer with a longer display name", alias: "Mobile reviewer", onboarded: true, ports: [4100,4101,4102], createdAt: timestamp }] },
  "/api/admin/starter-projects": { starterProjects: [{ id: "example", name: "Example starter project", description: "A small reusable application template", gitUrl: "https://git.example.com/templates/example", notes: "Reusable example template", setupCommand: "bun run setup", enabled: true }] },
  "/api/remote-instruct/template": { template: "Review the request in {{workingDirectory}}.\nReport concrete results and remaining work.", variables: { default_workdir: "/workspace", hostname: "example-host", project_reference: "example-project", agent_types: "codex" } },
  "/api/instance-settings": { settings: [{ key: "directory.default", label: "Default working directory", category: "runtime", configured: true, maskedValue: "/workspace/example-project", value: "/workspace/example-project", source: "app", type: "string" }, { key: "models.providers", category: "models", configured: true, value: JSON.stringify({ providers: { openrouter: { models: ["example/compact-model", "example/longer-model-name-for-review"] } } }), source: "app" }], candidates: [], cleanupStatus: "cleanupUnavailable" },
  "/api/billing/team": { config: { useCredits: true, teamUuid: "example-team", baseAllocationUsdCents: 10000, perMemberUsdCents: 1000 }, summary: { memberCount: 3, budgetUsd: 130, markupPercent: 5 } },
  "/api/billing/usage": { usage: [{ id: "usage-1", createdAt: timestamp, model: "example/compact-model", endpoint: "/example/completions", wingmanCostUsd: 0.01, npub: "npub1syntheticreview" }] },
  "/api/agent-chat/agents": { agents: [{ agentId: "example-bot", label: "Example review bot", name: "Example review bot", harness: "codex", model: "example/model", workingDirectory: "/workspace/example-project", isDefault: true, botNpub: "npub1syntheticbot", about: "Reviews application layouts and reports concrete results." }] },
  "/api/agent-chat/backend-connections": { backendConnections: [] },
  "/api/agent-chat/subscriptions": { subscriptions: [{ subscriptionId: "example-subscription", workspaceId: "example-workspace", workspaceName: "Example workspace with a longer team name", backendBaseUrl: "https://tower.example.com", healthStatus: "healthy", sseStatus: "connected", candidateAgents: [{ agentId: "example-bot", label: "Example review bot" }], recentDispatches: [{ at: timestamp, action: "review", status: "completed", agentId: "example-bot" }] }] },
  "/api/agent-chat/dispatch-outcomes": { outcomes: [] },
  "/api/admin/signing-policies": { policies: [{ id: "example-policy", name: "Example read access policy", enabled: false, revision: 1 }] },
  "/api/admin/signing-policies/example-policy": { policy: { id: "example-policy", name: "Example read access policy", description: "Synthetic review policy", enabled: false, revision: 1, operations: ["nip98.sign"], assignments: { profileIds: ["example-bot"], workspaceIds: [] }, nip98Targets: [{ origin: "https://tower.example.com", methods: ["GET"], exactPaths: ["/api/example"], pathPrefixes: [] }] }, sessions: [] },
  "/api/archive": { sessions: [{ ...sessions[2], status: "archived", messageCount: 4 }], total: 1 },
  "/api/scheduler/jobs": { jobs: [{ id: "example-job", name: "Daily application review", enabled: true, cron: "0 9 * * *", schedule: "0 9 * * *", triggerType: "cron", actionType: "session", initialPrompt: "Review the application and report progress.", agent: "codex", workingDirectory: "/workspace/example-project", createdAt: timestamp }] },
  "/api/nightwatch/config": { enabled: true, intervalMinutes: 5, prompt: "Report progress", maxCycles: 21 },
  "/api/nightwatch/reports": { reports: [{ id: "example-report", sessionId: "review-session-0", sessionName: "Example application review", workingDirectory: "/workspace/example-project", status: "continue", summary: "Reviewed the application. The next step is to verify the remaining settings pages.", reasoning: "Use representative populated records and inspect the rendered controls.", cycleCount: 2, createdAt: timestamp }] },
  "/api/pipelines/root": { root: "/workspace/pipelines" },
  "/api/pipelines/definitions": { definitions: [{ id: "example-pipeline", name: "Review application layout", description: "Collect screenshots and summarize layout findings", version: 1, steps: [] }] },
  "/api/pipelines/runs": { runs: [{ id: "example-run", definitionId: "example-pipeline", name: "Review application layout and long result descriptions", status: "completed", createdAt: timestamp, completedAt: timestamp, tags: ["review"] }] },
  "/api/pipelines/functions": { functions: [] },
};

responses["/api/projects"] = responses["/api/npub-projects"];

responses["/api/docs/file"] = { path: "/workspace/long-review-notes-for-phone-layout.md", name: "long-review-notes-for-phone-layout.md", format: "markdown", content: "# Review notes\n\nLong file content wraps on small phones.\n\n".repeat(12) };
responses["/api/terminal/status"] = { available: true, shell: "sh", cwd: "/workspace" };

for (const session of sessions) {
  responses[`/api/sessions/${session.id}`] = session;
  responses[`/api/sessions/${session.id}/messages`] = { messages: [{ role: "user", content: "Review this example session.", messageId: "example-message", createdAt: timestamp }] };
  responses[`/api/sessions/${session.id}/logs`] = { logs: [] };
  responses[`/api/sessions/${session.id}/permissions`] = { permissions: [] };
  responses[`/api/sessions/${session.id}/queue`] = { prompts: [] };
  responses[`/api/sessions/${session.id}/artifacts`] = { artifacts: [] };
  responses[`/api/nightwatch/sessions/${session.id}`] = { enabled: false };
}
