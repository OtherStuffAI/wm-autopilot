import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const files: Record<string, string> = {
  "package.json": JSON.stringify({
    type: "module",
    scripts: {
      start: "bun run src/server.ts",
    },
    dependencies: {
      "nostr-tools": "^2.17.2",
    },
  }, null, 2),
  "README.md": `# WApp

A small Nostr-authenticated Bun WApp template managed by Autopilot.

## Flight Deck activity publishing

Autopilot injects only public installation and Tower metadata. Publisher signing
is performed through Autopilot's installation-scoped broker; a managed WApp
never receives or persists a private signing key. Use the authenticated
Autopilot WApp activity endpoint after committing canonical business data.
`,
  "data/.gitkeep": "",
  "public/index.html": `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>WApp</title>
    <link rel="stylesheet" href="/styles.css">
  </head>
  <body>
    <main>
      <h1>WApp</h1>
      <p id="status">Sign in with your Nostr browser extension.</p>
      <button id="login">Sign in</button>
    </main>
    <script type="module" src="/app.js"></script>
  </body>
</html>
`,
  "public/styles.css": `body { font-family: system-ui, sans-serif; margin: 0; min-height: 100vh; display: grid; place-items: center; }
main { width: min(520px, calc(100vw - 32px)); }
button { padding: 10px 14px; }
`,
  "public/app.js": `const statusEl = document.getElementById("status");
document.getElementById("login")?.addEventListener("click", async () => {
  if (!window.nostr) {
    statusEl.textContent = "Nostr extension not found.";
    return;
  }
  const challenge = await fetch("/api/auth/challenge").then((res) => res.json());
  const event = await window.nostr.signEvent(challenge.event);
  const result = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ event }),
  }).then((res) => res.json());
  statusEl.textContent = result.ok ? "Signed in." : result.error || "Sign in failed.";
});
`,
  "src/auth/allowlist.ts": `export function allowedNpubs(): Set<string> {
  const raw = process.env.WAPP_ALLOWED_NPUBS_JSON || "[]";
  try {
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}

export function canAccess(npub: string): boolean {
  return npub === process.env.WAPP_OWNER_NPUB || allowedNpubs().has(npub);
}
`,
  "src/auth/nostr.ts": `import { nip19, verifyEvent } from "nostr-tools";

export function eventNpub(event: any): string | null {
  if (!event || !verifyEvent(event)) return null;
  return nip19.npubEncode(event.pubkey);
}
`,
  "src/auth/session.ts": `const sessions = new Map<string, string>();

export function createSession(npub: string): string {
  const id = crypto.randomUUID();
  sessions.set(id, npub);
  return id;
}

export function readSession(cookie: string | null): string | null {
  const id = cookie?.match(/(?:^|; )wapp_session=([^;]+)/)?.[1];
  return id ? sessions.get(decodeURIComponent(id)) ?? null : null;
}
`,
  "src/db.ts": `import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const dbPath = process.env.WAPP_DB_PATH || new URL("../data/db.sqlite", import.meta.url).pathname;
mkdirSync(dirname(dbPath), { recursive: true });
export const db = new Database(dbPath);
db.run("CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, body TEXT NOT NULL)");
`,
  "src/routes.ts": `import { canAccess } from "./auth/allowlist";
import { eventNpub } from "./auth/nostr";
import { createSession, readSession } from "./auth/session";
import "./db";

export async function route(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/api/auth/challenge") {
    return Response.json({ event: { kind: 27235, content: "wapp-login", tags: [["challenge", crypto.randomUUID()]], created_at: Math.floor(Date.now() / 1000) } });
  }
  if (url.pathname === "/api/auth/login" && request.method === "POST") {
    const body = await request.json().catch(() => null);
    const npub = eventNpub(body?.event);
    if (!npub || !canAccess(npub)) return Response.json({ error: "Not allowed" }, { status: 403 });
    const session = createSession(npub);
    return Response.json({ ok: true, npub }, { headers: { "set-cookie": \`wapp_session=\${encodeURIComponent(session)}; HttpOnly; SameSite=Lax; Path=/\` } });
  }
  if (url.pathname.startsWith("/api/")) {
    const npub = readSession(request.headers.get("cookie"));
    if (!npub || !canAccess(npub)) return Response.json({ error: "Not authenticated" }, { status: 401 });
    return Response.json({ ok: true, npub });
  }
  return new Response(null, { status: 404 });
}
`,
  "src/server.ts": `import { route } from "./routes";

const root = new URL("../public", import.meta.url).pathname;
Bun.serve({
  port: Number(process.env.PORT || 3000),
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return route(request);
    const file = Bun.file(root + (url.pathname === "/" ? "/index.html" : url.pathname));
    return (await file.exists()) ? new Response(file) : new Response("Not found", { status: 404 });
  },
});
`,
};

export interface CreateWappTemplateOptions {
  force?: boolean;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function findTemplateConflicts(root: string): Promise<string[]> {
  const conflicts = new Set<string>();
  if (await exists(root)) {
    const entries = await readdir(root);
    for (const entry of entries) {
      conflicts.add(entry);
    }
  }
  for (const relativePath of Object.keys(files)) {
    if (await exists(join(root, relativePath))) {
      conflicts.add(relativePath);
    }
  }
  return Array.from(conflicts.values()).sort();
}

export async function createWappTemplate(
  root: string,
  options: CreateWappTemplateOptions = {},
): Promise<{ root: string; files: string[] }> {
  if (!options.force) {
    const conflicts = await findTemplateConflicts(root);
    if (conflicts.length > 0) {
      throw new Error(`WApp template target is not empty: ${conflicts.join(", ")}`);
    }
  }
  const written: string[] = [];
  for (const [relativePath, content] of Object.entries(files)) {
    const target = join(root, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
    written.push(relativePath);
  }
  return { root, files: written };
}
