/** Trust the configured public origin, never client-supplied forwarding headers. */
export function hasTerminalOrigin(request: Request, publicOrigin: string): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    const configured = new URL(publicOrigin);
    return (configured.protocol === "https:" || configured.protocol === "http:") && origin === configured.origin;
  } catch {
    return false;
  }
}
