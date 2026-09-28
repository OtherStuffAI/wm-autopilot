/**
 * CapRover API Client
 *
 * HTTP client for interacting with a CapRover server.
 * Handles authentication, app management, and deployments.
 */

import type {
  CaptainDefinition,
  CaproverApiResponse,
  CaproverAppDefinition,
  CaproverAppsResponse,
  CaproverClientConfig,
  CaproverEnvVar,
  CaproverPortMapping,
  CaproverLoginResponse,
  CaproverRepoInfo,
  CaproverVolume,
} from "./types";

export class CaproverClientError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly apiStatus?: number,
  ) {
    super(message);
    this.name = "CaproverClientError";
  }
}

export class CaproverClient {
  private readonly serverUrl: string;
  private readonly password: string;
  private authToken: string | null = null;
  private tokenExpiresAt: number | null = null;

  constructor(config: CaproverClientConfig, private readonly policy: { timeoutMs?: number; rejectRedirects?: boolean } = {}) {
    // Normalize server URL - remove trailing slash
    this.serverUrl = config.serverUrl.replace(/\/+$/, "");
    this.password = config.password;
  }

  /**
   * Authenticate with CapRover and get an auth token.
   * Token is cached for 1 hour.
   */
  async authenticate(): Promise<string> {
    // Return cached token if still valid (with 5 min buffer)
    if (this.authToken && this.tokenExpiresAt && Date.now() < this.tokenExpiresAt - 5 * 60 * 1000) {
      return this.authToken;
    }

    const response = await this.request<CaproverLoginResponse>(
      "/api/v2/login",
      "POST",
      { password: this.password },
      false,
    );

    this.authToken = response.token;
    // Cache token for 1 hour
    this.tokenExpiresAt = Date.now() + 60 * 60 * 1000;
    return this.authToken;
  }

  /**
   * Get all apps from CapRover.
   */
  async getAllApps(): Promise<{ apps: CaproverAppDefinition[]; rootDomain: string }> {
    const response = await this.request<CaproverAppsResponse>(
      "/api/v2/user/apps/appDefinitions",
      "GET",
      {},
      true,
    );
    return {
      apps: response.appDefinitions,
      rootDomain: response.rootDomain,
    };
  }

  /**
   * Get a single app by name.
   */
  async getApp(appName: string): Promise<CaproverAppDefinition | null> {
    const { apps } = await this.getAllApps();
    return apps.find((app) => app.appName === appName) ?? null;
  }

  /**
   * Register (create) a new app.
   */
  async createApp(appName: string, hasPersistentData = false): Promise<void> {
    await this.request(
      "/api/v2/user/apps/appDefinitions/register",
      "POST",
      { appName, hasPersistentData },
      true,
    );
  }

  /**
   * Delete an app.
   */
  async deleteApp(appName: string): Promise<void> {
    await this.request(
      "/api/v2/user/apps/appDefinitions/delete",
      "POST",
      { appName },
      true,
    );
  }

  /**
   * Deploy app from a Docker image.
   */
  async deployFromImage(appName: string, imageName: string): Promise<void> {
    const captainDefinition: CaptainDefinition = {
      schemaVersion: 2,
      imageName,
    };
    await this.deployCaptainDefinition(appName, captainDefinition);
  }

  /**
   * Deploy app from a captain-definition object.
   * Note: This only works if captain-definition specifies an imageName.
   * For source code deployment, use deployFromTarball instead.
   */
  async deployCaptainDefinition(
    appName: string,
    captainDefinition: CaptainDefinition,
    gitHash?: string,
  ): Promise<void> {
    await this.request(
      `/api/v2/user/apps/appData/${encodeURIComponent(appName)}`,
      "POST",
      {
        captainDefinitionContent: JSON.stringify(captainDefinition),
        gitHash: gitHash ?? "",
      },
      true,
    );
  }

  /**
   * Deploy app from a tarball containing source code.
   * The tarball must contain a captain-definition or captain-definition.json at the root,
   * and either a Dockerfile or the captain-definition must specify
   * imageName or dockerfileLines.
   */
  async deployFromTarball(appName: string, tarBuffer: Buffer, gitHash?: string): Promise<void> {
    const token = await this.authenticate();
    const url = `${this.serverUrl}/api/v2/user/apps/appData/${encodeURIComponent(appName)}`;

    // Create form data with the tarball
    const formData = new FormData();
    const blob = new Blob([tarBuffer], { type: "application/x-tar" });
    formData.append("sourceFile", blob, "source.tar");
    if (gitHash) {
      formData.append("gitHash", gitHash);
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "x-captain-auth": token,
        },
        body: formData,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new CaproverClientError(`Network error: ${message}`);
    }

    let data: CaproverApiResponse<unknown>;
    try {
      data = (await response.json()) as CaproverApiResponse<unknown>;
    } catch {
      throw new CaproverClientError(`Invalid JSON response from CapRover`, response.status);
    }

    // CapRover uses status 100 for success
    if (data.status !== 100) {
      throw new CaproverClientError(
        data.description || "Unknown CapRover error",
        response.status,
        data.status,
      );
    }
  }

  /**
   * Update app configuration (instance count, env vars, ports, etc.).
   */
  async updateAppConfig(
    appName: string,
    config: {
      instanceCount?: number;
      containerHttpPort?: number;
      envVars?: CaproverEnvVar[];
      volumes?: CaproverVolume[];
      ports?: CaproverPortMapping[];
      repoInfo?: CaproverRepoInfo;
      appPushWebhook?: {
        repoInfo: CaproverRepoInfo;
        pushWebhookToken: string;
      };
      notExposeAsWebApp?: boolean;
      forceSsl?: boolean;
      nodeId?: string;
    },
  ): Promise<void> {
    await this.request(
      "/api/v2/user/apps/appDefinitions/update",
      "POST",
      {
        appName,
        ...config,
      },
      true,
    );
  }

  /** Requires CapRover's partial-update endpoint; never falls back to POST. */
  async patchAppConfig(
    appName: string,
    config: {
      instanceCount?: number;
      containerHttpPort?: number;
      envVars?: CaproverEnvVar[];
      volumes?: CaproverVolume[];
      forceSsl?: boolean;
    },
  ): Promise<void> {
    await this.request("/api/v2/user/apps/appDefinitions/update", "PATCH", { appName, ...config }, true);
  }

  /**
   * Enable SSL on the default subdomain.
   */
  async enableSsl(appName: string): Promise<void> {
    await this.request(
      "/api/v2/user/apps/appDefinitions/enablebasedomainssl",
      "POST",
      { appName },
      true,
    );
  }

  /**
   * Add a custom domain to an app.
   */
  async addCustomDomain(appName: string, domain: string): Promise<void> {
    await this.request(
      "/api/v2/user/apps/appDefinitions/customdomain",
      "POST",
      { appName, customDomain: domain },
      true,
    );
  }

  /**
   * Remove a custom domain from an app.
   */
  async removeCustomDomain(appName: string, domain: string): Promise<void> {
    await this.request(
      "/api/v2/user/apps/appDefinitions/removecustomdomain",
      "POST",
      { appName, customDomain: domain },
      true,
    );
  }

  /**
   * Enable SSL on a custom domain.
   */
  async enableSslOnDomain(appName: string, domain: string): Promise<void> {
    await this.request(
      "/api/v2/user/apps/appDefinitions/enablecustomdomainssl",
      "POST",
      { appName, customDomain: domain },
      true,
    );
  }

  /**
   * Get build logs for an app.
   */
  async getBuildLogs(appName: string): Promise<{ logs: string; isAppBuilding: boolean }> {
    const response = await this.request<{ logs: string; isAppBuilding: boolean }>(
      `/api/v2/user/apps/appData/${encodeURIComponent(appName)}`,
      "GET",
      {},
      true,
    );
    return {
      logs: response.logs ?? "",
      isAppBuilding: response.isAppBuilding ?? false,
    };
  }

  /**
   * Get the root domain for the CapRover instance.
   */
  async getRootDomain(): Promise<string> {
    const { rootDomain } = await this.getAllApps();
    return rootDomain;
  }

  /**
   * Compute the live URL for an app.
   */
  async getAppUrl(appName: string, useHttps = true): Promise<string> {
    const rootDomain = await this.getRootDomain();
    const protocol = useHttps ? "https" : "http";
    return `${protocol}://${appName}.${rootDomain}`;
  }

  /**
   * Make an authenticated request to the CapRover API.
   */
  private async request<T>(
    path: string,
    method: "GET" | "POST" | "PATCH",
    body: Record<string, unknown>,
    requiresAuth: boolean,
  ): Promise<T> {
    const url = `${this.serverUrl}${path}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (requiresAuth) {
      const token = await this.authenticate();
      headers["x-captain-auth"] = token;
    }

    const options: RequestInit = {
      method,
      headers,
      redirect: this.policy.rejectRedirects ? "error" : undefined,
      signal: this.policy.timeoutMs ? AbortSignal.timeout(this.policy.timeoutMs) : undefined,
    };

    if (method !== "GET") {
      options.body = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await fetch(url, options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new CaproverClientError(`Network error: ${message}`);
    }

    let data: CaproverApiResponse<T>;
    try {
      data = (await response.json()) as CaproverApiResponse<T>;
    } catch {
      throw new CaproverClientError(
        `Invalid JSON response from CapRover`,
        response.status,
      );
    }

    // CapRover uses status 100 for success
    if (data.status !== 100) {
      throw new CaproverClientError(
        data.description || "Unknown CapRover error",
        response.status,
        data.status,
      );
    }

    return data.data;
  }
}

export interface CaproverTargetClient {
  name: string;
  serverUrl: string;
  client: CaproverClient;
}

export { createCaproverClientFromEnv, createCaproverTargetClientsFromEnv } from "./caprover-targets";
