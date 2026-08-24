/**
 * NTFY Notification Helper
 *
 * Sends push notifications via ntfy.sh when Night Watchman
 * reaches a terminal state (humanInput).
 */

import type { NightWatchReport } from "./nightwatch-store";

const NTFY_BASE = "https://ntfy.sh";

export interface NtfyConfig {
  topic: string;
  baseUrl: string; // Wingman UI base URL for session links
}

export function getNtfyConfig(wingmanBaseUrl?: string): NtfyConfig | null {
  const topic = Bun.env.NTFY_TOPIC;
  if (!topic) return null;

  const baseUrl = wingmanBaseUrl || Bun.env.WINGMAN_BASE_URL || `http://localhost:${Bun.env.PORT || "3600"}`;

  return { topic, baseUrl };
}

function formatTitle(report: NightWatchReport): string {
  const statusLabels: Record<string, string> = {
    raw: "Raw Input Sent",
    humanInput: "Human Input Needed",
    complete: "Session Complete",
    error: "Session Error",
  };
  const label = statusLabels[report.status] || report.status;
  const name = report.sessionName || report.sessionId.slice(0, 8);
  return `${label}: ${name}`;
}

function formatBody(report: NightWatchReport, sessionUrl: string): string {
  const lines: string[] = [];

  lines.push(`**Session**: ${report.sessionName || report.sessionId}`);
  if (report.workingDirectory) {
    lines.push(`**Directory**: ${report.workingDirectory}`);
  }
  lines.push(`**Status**: ${report.status}`);
  lines.push(`**Cycles**: ${report.cycleCount}`);
  lines.push("");
  lines.push("## Summary");
  lines.push(report.summary);

  if (report.reasoning) {
    lines.push("");
    lines.push("## Reasoning");
    lines.push(report.reasoning);
  }

  lines.push("");
  lines.push(`[Open Session](${sessionUrl})`);

  return lines.join("\n");
}

function priorityForStatus(status: string): string {
  if (status === "humanInput") return "urgent";
  if (status === "error") return "high";
  return "default";
}

function tagsForStatus(status: string): string {
  if (status === "humanInput") return "warning,hand";
  if (status === "error") return "rotating_light,x";
  return "white_check_mark,tada";
}

export async function sendNtfyNotification(
  report: NightWatchReport,
  config: NtfyConfig,
): Promise<void> {
  const sessionUrl = `${config.baseUrl}/live/${report.sessionId}`;
  const title = formatTitle(report);
  const body = formatBody(report, sessionUrl);

  try {
    const resp = await fetch(`${NTFY_BASE}/${config.topic}`, {
      method: "POST",
      headers: {
        "Title": title,
        "Priority": priorityForStatus(report.status),
        "Tags": tagsForStatus(report.status),
        "Markdown": "yes",
        "Click": sessionUrl,
      },
      body,
    });

    if (resp.ok) {
      console.log(`[ntfy] Sent notification: "${title}"`);
    } else {
      console.warn(`[ntfy] Failed to send notification: ${resp.status} ${resp.statusText}`);
    }
  } catch (err) {
    console.error("[ntfy] Failed to send notification:", err);
  }
}
