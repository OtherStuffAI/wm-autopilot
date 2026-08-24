/**
 * MCP Tool: list_skills
 *
 * Lists available agent skills, optionally filtered by app folder.
 */

import { z } from "zod";

export const listSkillsSchema = {
  app: z.string().optional().describe(
    "Filter by app folder (e.g. 'claude', 'universal'). Omit to list all.",
  ),
};

export const listSkillsDescription =
  "List available skills that you can load and follow. " +
  "Skills are step-by-step instruction files organized by app. " +
  "Use run_skill to load a specific skill.";

export async function handleListSkills(
  params: { app?: string },
  wingmanUrl: string,
  sessionId: string,
) {
  try {
    const qs = new URLSearchParams({ sessionId });
    if (params.app) {
      qs.set("app", params.app);
    }

    const response = await fetch(
      `${wingmanUrl}/api/mcp/wingman/skills?${qs.toString()}`,
    );

    if (!response.ok) {
      const error = await response.text();
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `Failed to list skills (${response.status}): ${error}`,
          },
        ],
      };
    }

    const { skills } = await response.json() as {
      skills?: Array<{ app: string; name: string; source: string; description?: string }>;
    };

    if (!skills || skills.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: "No skills available. Skills are .md files in ~/.wingmen/skills/<app>/ or the project skills/ directory.",
          },
        ],
      };
    }

    const lines = ["Available Skills:", ""];
    let currentApp = "";

    for (const skill of skills) {
      if (skill.app !== currentApp) {
        if (currentApp) lines.push("");
        lines.push(`[${skill.app}]`);
        currentApp = skill.app;
      }
      const source = skill.source === "user" ? " (user)" : "";
      const desc = skill.description ? ` — ${skill.description}` : "";
      lines.push(`  ${skill.name}${desc}${source}`);
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
          text: `Failed to reach Wingman server: ${(err as Error).message}`,
        },
      ],
    };
  }
}
