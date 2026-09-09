import {
  FipsAppIngressManager,
  type FipsAppEndpoint,
  type FipsAppIngressManagerOptions,
  type FipsIngressEnvironment,
  type TcpPeer,
} from "../apps/fips-app-ingress-manager";
import { configuredPublicRequestUrl, forwardedRequestUrl } from "./request-url";
import { shouldUseSecureCookies } from "./cookie-security";

export interface FipsControlPlaneEnvironment extends FipsIngressEnvironment {
  FIPS_AUTOPILOT_ENABLED?: string;
  FIPS_AUTOPILOT_PORT?: string;
}

export function controlPlaneFipsPort(value: string | undefined, targetPort: number): number {
  const configured = value ?? "3601";
  const port = Number(configured);
  if (!/^[0-9]{4,5}$/.test(configured) || !Number.isInteger(port) || port < 1024 || port >= 41000 || port === targetPort) {
    throw new Error("FIPS_AUTOPILOT_PORT must be 1024-40999 and differ from PORT");
  }
  return port;
}

/** A separate listener on the existing node, forwarding to the unchanged HTTP service. */
export class FipsControlPlane {
  private readonly manager: FipsAppIngressManager;
  private readonly env: FipsControlPlaneEnvironment;
  private service = { id: "autopilot-control-plane", port: null as number | null };
  private configurationError: string | null = null;

  constructor(options: Omit<FipsAppIngressManagerOptions, "env"> & { env?: FipsControlPlaneEnvironment } = {}) {
    this.env = options.env ?? (Bun.env as FipsControlPlaneEnvironment);
    this.manager = new FipsAppIngressManager({
      ...options,
      env: { ...this.env, FIPS_APPS_ENABLED: this.env.FIPS_AUTOPILOT_ENABLED ?? this.env.FIPS_APPS_ENABLED },
    });
  }

  async start(targetPort: number): Promise<FipsAppEndpoint> {
    try {
      this.service.port = controlPlaneFipsPort(this.env.FIPS_AUTOPILOT_PORT, targetPort);
      this.configurationError = null;
    } catch (error) {
      this.configurationError = (error as Error).message;
      return this.getEndpoint();
    }
    return this.manager.startService(this.service, targetPort);
  }

  getEndpoint(): FipsAppEndpoint {
    const endpoint = this.manager.getServiceEndpoint(this.service);
    return this.configurationError && endpoint.enabled
      ? { ...endpoint, status: "error", url: null, error: this.configurationError }
      : endpoint;
  }

  isMeshUrl(url: URL): boolean {
    const endpoint = this.getEndpoint();
    return endpoint.status === "listening" && endpoint.url !== null
      && url.origin === new URL(endpoint.url).origin;
  }

  authenticationBaseUrl(url: URL, publicBaseUrl: string): string {
    return this.isMeshUrl(url) ? url.origin : publicBaseUrl;
  }

  homeUrl(request: Request, url: URL, publicBaseUrl: string): URL {
    const home = this.isMeshUrl(url) ? new URL(url)
      : configuredPublicRequestUrl(url, publicBaseUrl) ?? forwardedRequestUrl(request, url);
    home.pathname = "/home";
    return home;
  }

  secureCookies(request: Request): boolean {
    return this.isMeshUrl(new URL(request.url)) ? false : shouldUseSecureCookies(request);
  }

  externalRequestPeer(peer: TcpPeer | null): TcpPeer | null {
    // A TCP hop must not grant access to loopback-only capability broker routes.
    return peer && !this.manager.isForwardedPeer(peer) ? peer : null;
  }

  shutdown(): Promise<void> {
    return this.manager.shutdown();
  }
}

export const fipsControlPlane = new FipsControlPlane();
