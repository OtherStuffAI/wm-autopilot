/** Discovery is the only non-workspace route added for bounded record sync. */
export function permitsRecordSyncTransport(
  url: URL,
  method: string,
  workspaceId: string,
): boolean {
  if (url.pathname === "/api/v4/flightdeck-pg/service")
    return method === "GET" && !url.search;
  const base = `/api/v4/flightdeck-pg/workspaces/${encodeURIComponent(workspaceId)}/record-sync`;
  if (url.searchParams.get("protocol_version") !== "2") return false;
  if (url.pathname === base) return method === "GET";
  const suffix = url.pathname.slice(base.length);
  const client =
    /^\/clients\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\/ack)?$/.exec(
      suffix,
    );
  return (
    url.pathname.startsWith(base) &&
    Boolean(client) &&
    (client?.[1] ? method === "POST" : method === "POST" || method === "GET")
  );
}
