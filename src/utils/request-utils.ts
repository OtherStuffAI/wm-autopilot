/**
 * Shared HTTP request/response utilities for API route handlers.
 */

export async function parseBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    if (!body || typeof body !== "object") {
      throw new Error("Expected JSON object");
    }
    return body as Record<string, unknown>;
  } catch {
    throw new Error("Invalid JSON body");
  }
}

export function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}
