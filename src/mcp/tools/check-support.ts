/**
 * MCP Tool: check_nip98_support
 *
 * Probes a URL to determine whether it supports NIP-98 authentication.
 * Checks OpenAPI/Swagger docs and WWW-Authenticate response headers.
 */

import { z } from "zod";

export const checkSupportSchema = {
  base_url: z
    .string()
    .url()
    .describe('Base URL of the API to check, e.g. "https://api.example.invalid"'),
  swagger_path: z
    .string()
    .optional()
    .default("/api/docs")
    .describe('Path to Swagger/OpenAPI docs (default: "/api/docs")'),
};

export const checkSupportDescription =
  "Check whether an API supports NIP-98 (Nostr HTTP Auth). " +
  "Probes Swagger/OpenAPI docs for a Nostr security scheme and checks " +
  "WWW-Authenticate headers for Nostr mentions.";

interface CheckSupportParams {
  base_url: string;
  swagger_path?: string;
}

export async function handleCheckSupport(params: CheckSupportParams) {
  const { base_url, swagger_path = "/api/docs" } = params;
  const results: string[] = [`Checking NIP-98 support for ${base_url}`, ""];

  // ---- Swagger / OpenAPI detection ----
  const swaggerUrls = [
    `${base_url}${swagger_path}/swagger.json`,
    `${base_url}${swagger_path}/openapi.json`,
    `${base_url}/swagger.json`,
    `${base_url}/openapi.json`,
  ];

  let swaggerFound = false;
  for (const swaggerUrl of swaggerUrls) {
    try {
      const res = await fetch(swaggerUrl, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) continue;

      const spec = await res.json() as {
        components?: { securitySchemes?: Record<string, Record<string, string>> };
        securityDefinitions?: Record<string, unknown>;
      };

      // OpenAPI 3.x
      const schemes = spec.components?.securitySchemes ?? {};
      for (const [name, scheme] of Object.entries(schemes) as [string, Record<string, string>][]) {
        if (
          (scheme.type === "http" && scheme.scheme === "nostr") ||
          name.toLowerCase().includes("nip98") ||
          name.toLowerCase() === "nostr"
        ) {
          results.push(`Swagger: NIP-98 security scheme found ("${name}") at ${swaggerUrl}`);
          swaggerFound = true;
          break;
        }
      }

      // Swagger 2.x
      if (!swaggerFound) {
        const defs = spec.securityDefinitions ?? {};
        for (const [name] of Object.entries(defs)) {
          if (name.toLowerCase().includes("nip98") || name.toLowerCase() === "nostr") {
            results.push(`Swagger 2.x: NIP-98 definition found ("${name}") at ${swaggerUrl}`);
            swaggerFound = true;
            break;
          }
        }
      }

      if (swaggerFound) break;
    } catch {
      // URL not reachable or not JSON — try next
    }
  }
  if (!swaggerFound) {
    results.push("Swagger: No NIP-98 security scheme found in API docs");
  }

  // ---- WWW-Authenticate header detection ----
  let wwwAuthFound = false;
  try {
    const res = await fetch(base_url, {
      method: "OPTIONS",
      signal: AbortSignal.timeout(5000),
    });
    const wwwAuth = res.headers.get("WWW-Authenticate");
    if (wwwAuth?.toLowerCase().includes("nostr")) {
      results.push(`WWW-Authenticate: Nostr auth detected ("${wwwAuth}")`);
      wwwAuthFound = true;
    }
  } catch {
    // Ignore — OPTIONS may not be supported
  }

  if (!wwwAuthFound) {
    // Try a GET to see if 401 includes WWW-Authenticate
    try {
      const res = await fetch(base_url, {
        signal: AbortSignal.timeout(5000),
      });
      if (res.status === 401 || res.status === 403) {
        const wwwAuth = res.headers.get("WWW-Authenticate");
        if (wwwAuth?.toLowerCase().includes("nostr")) {
          results.push(`WWW-Authenticate: Nostr auth detected on ${res.status} ("${wwwAuth}")`);
          wwwAuthFound = true;
        }
      }
    } catch {
      // Ignore
    }
  }

  if (!wwwAuthFound) {
    results.push("WWW-Authenticate: No Nostr auth header detected");
  }

  // ---- Summary ----
  const supported = swaggerFound || wwwAuthFound;
  results.push("");
  results.push(supported ? "Result: NIP-98 IS supported" : "Result: NIP-98 support NOT detected (may still work — try a request with a token)");

  return {
    content: [{ type: "text" as const, text: results.join("\n") }],
  };
}
