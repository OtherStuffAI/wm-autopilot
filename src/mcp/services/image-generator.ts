/**
 * Image Generation Service
 *
 * Calls OpenRouter's API with image-capable models to generate images.
 * Saves results to disk and returns file paths.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// ============================================================
// Constants
// ============================================================

const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";

const DEFAULT_MODEL = "google/gemini-2.5-flash-image";

export const IMAGE_MODELS = new Set([
  "google/gemini-2.5-flash-image",
  "google/gemini-3.1-flash-image-preview",
  "google/gemini-3-pro-image-preview",
  "openai/gpt-5-image",
  "openai/gpt-5-image-mini",
]);

// ============================================================
// Types
// ============================================================

export interface GeneratedImage {
  path: string;
  mimeType: string;
  filename: string;
}

export interface ImageGenerationResult {
  content: string;
  images: GeneratedImage[];
}

interface OpenRouterImageResponse {
  choices?: Array<{
    message?: {
      content?: string | Array<{
        type?: string;
        text?: string;
        image_url?: { url?: string };
      }>;
    };
  }>;
}

// ============================================================
// Implementation
// ============================================================

/**
 * Call OpenRouter to generate an image from a text prompt.
 */
export async function callOpenRouterImage(
  prompt: string,
  model: string,
  apiKey: string,
): Promise<{ textContent: string; imageDataUrls: string[] }> {
  const response = await fetch(OPENROUTER_CHAT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model || DEFAULT_MODEL,
      messages: [{ role: "user", content: prompt }],
      modalities: ["text", "image"],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenRouter API error (${response.status}): ${errorText}`);
  }

  const data = await response.json() as OpenRouterImageResponse;

  let textContent = "";
  const imageDataUrls: string[] = [];

  const choices = data.choices ?? [];
  for (const choice of choices) {
    const parts = choice.message?.content;
    if (typeof parts === "string") {
      textContent += parts;
      continue;
    }
    if (!Array.isArray(parts)) continue;

    for (const part of parts) {
      if (part.type === "text") {
        textContent += part.text ?? "";
      } else if (part.type === "image_url") {
        const url = part.image_url?.url ?? "";
        if (url) {
          imageDataUrls.push(url);
        }
      }
    }
  }

  return { textContent, imageDataUrls };
}

/**
 * Parse a base64 data URL and write the image to disk.
 * Returns the absolute path of the saved file.
 */
export function saveImageToDirectory(
  dataUrl: string,
  directory: string,
  filename?: string,
): GeneratedImage {
  // Parse data:image/png;base64,... format
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    throw new Error("Invalid data URL format — expected base64-encoded image");
  }

  const mimeType = match[1];
  const base64Data = match[2];
  if (!mimeType || !base64Data) {
    throw new Error("Invalid data URL format — image MIME type or payload is missing");
  }

  const ext = mimeToExtension(mimeType);
  const finalName = filename
    ? `${sanitiseFilename(filename)}.${ext}`
    : `image-${randomUUID().slice(0, 8)}.${ext}`;

  const filePath = join(directory, finalName);
  const buffer = Buffer.from(base64Data, "base64");
  writeFileSync(filePath, buffer);

  return { path: filePath, mimeType, filename: finalName };
}

/**
 * High-level: generate images and save them to a directory.
 */
export async function generateAndSaveImages(
  prompt: string,
  directory: string,
  apiKey: string,
  options: { model?: string; filename?: string } = {},
): Promise<ImageGenerationResult> {
  const model = options.model || DEFAULT_MODEL;
  const { textContent, imageDataUrls } = await callOpenRouterImage(prompt, model, apiKey);

  const images: GeneratedImage[] = [];
  for (let i = 0; i < imageDataUrls.length; i++) {
    const name = options.filename
      ? (imageDataUrls.length > 1 ? `${options.filename}-${i + 1}` : options.filename)
      : undefined;
    const dataUrl = imageDataUrls[i];
    if (!dataUrl) continue;
    const saved = saveImageToDirectory(dataUrl, directory, name);
    images.push(saved);
  }

  return { content: textContent, images };
}

// ============================================================
// Helpers
// ============================================================

function mimeToExtension(mime: string): string {
  const map: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/svg+xml": "svg",
  };
  return map[mime] ?? "png";
}

function sanitiseFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
}
