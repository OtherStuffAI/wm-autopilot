const agentName = Bun.env.SESSION_AGENT ?? Bun.env.AGENT_NAME ?? "agent";
const sessionId = Bun.env.SESSION_ID ?? crypto.randomUUID();
const port = Number.parseInt(Bun.env.SESSION_PORT ?? "", 10);

if (!Number.isFinite(port)) {
  console.error("[runtime] SESSION_PORT is required");
  process.exit(1);
}

const startedAt = new Date();

console.log(`[runtime] ${agentName} (${sessionId}) listening on port ${port}`);

const server = Bun.serve({
  port,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/info") {
      return Response.json({
        agent: agentName,
        sessionId,
        startedAt: startedAt.toISOString(),
      });
    }
    return new Response(
      `Agent ${agentName} active on session ${sessionId}. Request path: ${url.pathname}`,
      {
        headers: { "content-type": "text/plain; charset=utf-8" },
      },
    );
  },
});

const interval = setInterval(() => {
  console.log(`[runtime] ${agentName} heartbeat @ ${new Date().toISOString()}`);
}, 10_000);

const shutdown = () => {
  console.log(`[runtime] ${agentName} shutting down`);
  clearInterval(interval);
  server.stop(true);
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
