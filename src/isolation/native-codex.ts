import { mkdir } from "node:fs/promises";
import { nativeCodexCommand } from "./native-codex-command.ts";
import type { NativeCodexRequest } from "./native-codex-command.ts";
import { jsonLines } from "./json-lines.ts";
const request = JSON.parse(process.argv[2] ?? "") as NativeCodexRequest;
const command = nativeCodexCommand(request, process.env.OPENAI_BASE_URL ?? "");
await mkdir("/continuity/.codex", { recursive: true, mode: 0o700 });
const child = Bun.spawn(command, { cwd: "/workspace", env: process.env, stdin: "pipe", stdout: "pipe", stderr: "inherit" });
child.stdin.write(request.prompt);
child.stdin.end();
for await (const value of jsonLines(child.stdout, 65536)) {
  const event = value as { type: string; message?: string; error?: { message?: string } };
  if (event.type === "error" || event.type === "turn.failed") {
    const message = typeof event.message === "string" ? event.message : typeof event.error?.message === "string" ? event.error.message : "Native turn failed";
    console.error(message.slice(0, 1024));
  }
  console.log(JSON.stringify(event));
}
process.exit(await child.exited);
