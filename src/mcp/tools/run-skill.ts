/**
 * MCP Tool: run_skill
 *
 * Loads a skill's markdown content for the agent to follow.
 */

import { z } from "zod";

export const runSkillSchema = {
  app: z.string().describe(
    "The app folder containing the skill (e.g. 'claude', 'universal').",
  ),
  name: z.string().describe(
    "The skill name (filename without .md extension).",
  ),
};

export const runSkillDescription =
  "Load a skill and follow its instructions. " +
  "Skills are step-by-step guides for specific tasks. " +
  "Use list_skills first to see what's available. " +
  "IMPORTANT: After loading, follow the returned instructions carefully.";

export async function handleRunSkill(
  params: { app: string; name: string },
  wingmanUrl: string,
  sessionId: string,
) {
  try {
    const qs = new URLSearchParams({
      sessionId,
      app: params.app,
      name: params.name,
    });

    const response = await fetch(
      `${wingmanUrl}/api/mcp/wingman/skills/load?${qs.toString()}`,
    );

    if (!response.ok) {
      const error = await response.text();
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `Failed to load skill (${response.status}): ${error}`,
          },
        ],
      };
    }

    const { skill } = await response.json() as {
      skill: { app: string; name: string; description?: string; source: string; content: string };
    };

    const header = [
      `Skill: ${skill.app}/${skill.name}`,
      skill.description ? `Description: ${skill.description}` : "",
      `Source: ${skill.source}`,
      "",
      "--- FOLLOW THESE INSTRUCTIONS ---",
      "",
    ]
      .filter(Boolean)
      .join("\n");

    return {
      content: [
        { type: "text" as const, text: header + skill.content },
      ],
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
