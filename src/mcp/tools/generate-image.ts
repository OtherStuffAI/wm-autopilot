/**
 * MCP Tool: generate_image
 *
 * Generate images using OpenRouter's image-capable models.
 * Saves generated images to the session's working directory
 * and registers them as session artifacts.
 */

import { z } from "zod";

export const generateImageSchema = {
  prompt: z.string().describe("Description of the image to generate"),
  filename: z
    .string()
    .optional()
    .describe("Optional filename (without extension)"),
  model: z
    .string()
    .optional()
    .describe(
      "OpenRouter model ID (default: google/gemini-2.5-flash-image). " +
      "Supported: google/gemini-2.5-flash-image, google/gemini-3.1-flash-image-preview, " +
      "google/gemini-3-pro-image-preview, openai/gpt-5-image, openai/gpt-5-image-mini",
    ),
};

export const generateImageDescription =
  "Generate images using AI models via OpenRouter. " +
  "The image is saved to your session's working directory and registered as a session artifact. " +
  "Returns the file path(s) of generated images plus any text content from the model.";

interface GenerateImageParams {
  prompt: string;
  filename?: string;
  model?: string;
}

export async function handleGenerateImage(
  params: GenerateImageParams,
  wingmanUrl: string,
  sessionId: string,
) {
  const { prompt, filename, model } = params;

  try {
    const response = await fetch(
      `${wingmanUrl}/api/mcp/wingman/generate-image`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          prompt,
          filename,
          model,
        }),
      },
    );

    if (!response.ok) {
      const error = await response.text();
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `Image generation failed (${response.status}): ${error}`,
          },
        ],
      };
    }

    const result = await response.json() as {
      content?: string;
      images?: Array<{ path: string; mimeType: string }>;
    };
    const lines: string[] = [];

    if (result.content) {
      lines.push(result.content);
    }

    if (result.images && result.images.length > 0) {
      lines.push("");
      lines.push(`Generated ${result.images.length} image(s):`);
      for (const img of result.images) {
        lines.push(`  - ${img.path} (${img.mimeType})`);
      }
    }

    if (lines.length === 0) {
      lines.push("Image generation completed but no output was returned.");
    }

    return {
      content: [
        {
          type: "text" as const,
          text: lines.join("\n"),
        },
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
