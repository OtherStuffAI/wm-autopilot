/**
 * MCP Tool: gitea_info
 *
 * Returns all relevant Gitea details for the current session: whether
 * Gitea is configured, the remote URL and web link if a repo is set up,
 * the Gitea instance base URL, and the user's Gitea username.
 */

import { z } from "zod";

export const giteaInfoSchema = {};

export const giteaInfoDescription =
  "Get Gitea repository details for the current session. " +
  "Returns whether Gitea is configured on this Wingman instance, " +
  "the git remote URL, a web-browsable repo link, the Gitea base URL, " +
  "and the authenticated Gitea username. Use this to understand the " +
  "current git hosting setup and provide repo links to the user.";

export async function handleGiteaInfo(
  _params: Record<string, never>,
  wingmanUrl: string,
  sessionId: string,
) {
  try {
    // Fetch Gitea config status and remote URL in parallel
    const [configResp, remoteResp] = await Promise.all([
      fetch(`${wingmanUrl}/api/config`),
      fetch(`${wingmanUrl}/api/gitea/remote-url?sessionId=${sessionId}`),
    ]);

    // Parse config
    let giteaUrl: string | null = null;
    let giteaUsername: string | null = null;
    if (configResp.ok) {
      const cfg = await configResp.json() as Record<string, unknown>;
      giteaUrl = (cfg.giteaUrl as string) ?? null;
    }

    // Fetch user settings for Gitea username
    try {
      const settingsResp = await fetch(`${wingmanUrl}/api/user/settings`);
      if (settingsResp.ok) {
        const data = await settingsResp.json() as { settings?: Record<string, string> };
        giteaUsername = data.settings?.gitea_username ?? null;
      }
    } catch {
      // Non-critical — username just won't be shown
    }

    // Parse remote URL info
    let remoteConfigured = false;
    let cloneUrl: string | null = null;
    let webUrl: string | null = null;
    let remoteError: string | null = null;

    if (remoteResp.ok) {
      const remote = await remoteResp.json() as {
        configured: boolean;
        cloneUrl?: string;
        webUrl?: string;
        error?: string;
      };
      remoteConfigured = remote.configured;
      cloneUrl = remote.cloneUrl ?? null;
      webUrl = remote.webUrl ?? null;
      remoteError = remote.error ?? null;
    }

    // Build response
    const lines: string[] = [];

    if (!giteaUrl) {
      lines.push("Gitea is not configured on this Wingman instance.");
      lines.push("Set GITEA_URL, GITEA_API_TOKEN, and GITEA_OWNER environment variables to enable.");
      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    }

    lines.push("# Gitea Info");
    lines.push("");
    lines.push(`Instance: ${giteaUrl}`);

    if (giteaUsername) {
      lines.push(`Username: ${giteaUsername}`);
      lines.push(`Profile: ${giteaUrl}/${giteaUsername}`);
    }

    lines.push("");

    if (remoteConfigured && cloneUrl) {
      lines.push("## Repository (this session)");
      lines.push(`Clone URL: ${cloneUrl}`);
      if (webUrl) lines.push(`Web URL: ${webUrl}`);
      lines.push("");
      lines.push("Use `git_push` to push changes to this remote.");
    } else {
      lines.push("## Repository (this session)");
      lines.push("No Gitea remote configured for this session's working directory.");
      if (remoteError) lines.push(`Reason: ${remoteError}`);
      lines.push("");
      lines.push("The user can set one up via the Gitea > Setup menu in the UI.");
    }

    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
    };
  } catch (err) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: `Failed to fetch Gitea info: ${(err as Error).message}`,
        },
      ],
    };
  }
}
