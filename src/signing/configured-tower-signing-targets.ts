import type { BackendConnectionRecord } from "../agent-chat/types";
import { effectiveTowerEndpoint, normalizeTowerTransport } from "../agent-chat/tower-transport-config";
import type { CapabilityBrokerDependencies, Nip98Constraint } from "./capability-broker";
import { hasAdminSigningBaseline } from "./admin-signing-policy";
import { liveAdminSigningTargets } from "./admin-signing-targets";

type SigningInput = Parameters<NonNullable<CapabilityBrokerDependencies["liveNip98Targets"]>>[0];
type Connection = Pick<BackendConnectionRecord, "backendBaseUrl" | "transport">;

/** Connection availability is evaluated as the signer, never its custodian/owner. */
export function createLiveAdminSigningTargets(input: {
  autopilotUrl: string;
  isAdminNpub: (npub: string) => boolean;
  listAvailableConnections: (npub: string) => Connection[];
}): NonNullable<CapabilityBrokerDependencies["liveNip98Targets"]> {
  return (request: SigningInput) => {
    const local = liveAdminSigningTargets({ ...request, ...input });
    if (!hasAdminSigningBaseline(request.policy, new URL(input.autopilotUrl).origin)
      || !input.isAdminNpub(request.botNpub)) return local;
    const targets: NonNullable<Nip98Constraint["targets"]> = [...local];
    for (const connection of input.listAvailableConnections(request.botNpub)) {
      // Only the selected endpoint is authorized. An HTTPS alias of a selected
      // FIPS connection (or the inverse) is not an alternate signing destination.
      const endpoint = new URL(effectiveTowerEndpoint(normalizeTowerTransport(connection.transport, connection.backendBaseUrl)));
      if (endpoint.origin !== request.url.origin) continue;
      const root = `${endpoint.pathname.replace(/\/+$/, "")}/api/v4/flightdeck-pg`;
      const path = request.url.pathname;
      const workspaceSuffix = path.startsWith(`${root}/workspaces/`) ? path.slice(`${root}/workspaces/`.length) : "";
      if (path !== `${root}/service` && path !== `${root}/workspaces`
        && !/^[A-Za-z0-9_-]+\/(descriptor|me|scopes)$/.test(workspaceSuffix)) continue;
      // An explicit existing path grant may intentionally restrict methods,
      // payloads or challenge tags. Do not override it with a new exact target.
      if (request.policy.nip98?.targets?.some(target => target.origin === endpoint.origin
        && (target.exactPaths?.some(exact => exact.path === path)
          || target.pathPrefixes.some(prefix => path === prefix || path.startsWith(`${prefix.replace(/\/+$/, "")}/`))))) continue;
      targets.push({
        origin: endpoint.origin,
        methods: ["GET"],
        pathPrefixes: [],
        exactPaths: [{ path, methods: ["GET"] }],
      });
    }
    return targets;
  };
}
