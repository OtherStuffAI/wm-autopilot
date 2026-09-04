import { callCapabilityBroker, type CapabilityClientContext } from "../mcp/capability-client";
import {
  canonicalizeGitCredentialRequest,
  formatGitCredentialOutput,
  parseGitCredentialInput,
} from "./wingman-credential-protocol";

export interface CredentialHelperIo {
  readStdin(): Promise<string>;
  writeStdout(value: string): void;
  writeStderr(value: string): void;
}

interface BrokeredGitCredential {
  username: string;
  password: string;
  expiresAt: string;
}

function assertLoopbackContext(context: CapabilityClientContext | undefined): void {
  const value = context?.wingmanUrl
    ?? process.env.WINGMAN_BROKER_URL?.trim()
    ?? "";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("The loopback Wingman capability broker is unavailable.");
  }
  const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
  if (url.protocol !== "http:" || !loopbackHosts.has(url.hostname) || url.username || url.password) {
    throw new Error("The Wingman Git credential helper requires a loopback capability broker.");
  }
}

export async function runWingmanCredentialHelper(
  action: string | undefined,
  io: CredentialHelperIo,
  context?: CapabilityClientContext,
): Promise<number> {
  if (action === "--version") {
    io.writeStdout("git-credential-wingman 1\n");
    return 0;
  }
  if (action === "store" || action === "erase") {
    await io.readStdin();
    return 0;
  }
  if (action !== "get") {
    io.writeStderr("git-credential-wingman supports get, store, and erase.\n");
    return 1;
  }

  try {
    assertLoopbackContext(context);
    const request = canonicalizeGitCredentialRequest(parseGitCredentialInput(await io.readStdin()));
    const credential = await callCapabilityBroker<BrokeredGitCredential>(
      "/api/mcp/capabilities/git-credential",
      { protocol: request.protocol, host: request.host, path: request.path },
      context,
    );
    io.writeStdout(formatGitCredentialOutput(credential));
    return 0;
  } catch (error) {
    io.writeStderr(`${error instanceof Error ? error.message : "Git credential request failed."}\n`);
    return 1;
  }
}
