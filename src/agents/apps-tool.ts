import { loadConfig } from "../config";

export type AppActionName = "start" | "stop" | "restart" | "build";

export interface AppToolClientOptions {
  baseUrl?: string;
  tail?: number;
}

export interface AppToolActionInput {
  id: string;
  action: AppActionName;
}

export interface AppToolLogsInput {
  id: string;
  lines?: number;
}

export class AppsToolClient {
  private readonly baseUrl: string;
  private readonly defaultTail: number;

  constructor(options?: AppToolClientOptions) {
    const config = loadConfig();
    this.baseUrl = options?.baseUrl ?? `http://127.0.0.1:${config.port}`;
    this.defaultTail = typeof options?.tail === "number" && options.tail > 0 ? options.tail : 5;
  }

  async listApps(tail?: number) {
    const lines = typeof tail === "number" && tail > 0 ? tail : this.defaultTail;
    const response = await fetch(this.buildUrl(`/api/apps?tail=${encodeURIComponent(String(lines))}`));
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const message =
        payload && typeof payload === "object" && typeof (payload as Record<string, unknown>).error === "string"
          ? ((payload as Record<string, unknown>).error as string)
          : response.statusText || "Failed to fetch apps";
      throw new Error(message);
    }
    return payload;
  }

  async appAction(input: AppToolActionInput) {
    if (!input?.id || !input.action) {
      throw new Error("App id and action are required");
    }
    const url = this.buildUrl(`/api/apps/${encodeURIComponent(input.id)}/actions`);
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: input.action }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const message =
        payload && typeof payload === "object" && typeof (payload as Record<string, unknown>).error === "string"
          ? ((payload as Record<string, unknown>).error as string)
          : response.statusText || "Failed to execute app action";
      throw new Error(message);
    }
    return payload;
  }

  async tailAppLogs(input: AppToolLogsInput) {
    if (!input?.id) {
      throw new Error("App id is required");
    }
    const lines = typeof input.lines === "number" && input.lines > 0 ? input.lines : 200;
    const response = await fetch(
      this.buildUrl(`/api/apps/${encodeURIComponent(input.id)}/logs?tail=${encodeURIComponent(String(lines))}`),
    );
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const message =
        payload && typeof payload === "object" && typeof (payload as Record<string, unknown>).error === "string"
          ? ((payload as Record<string, unknown>).error as string)
          : response.statusText || "Failed to load logs";
      throw new Error(message);
    }
    return payload;
  }

  private buildUrl(path: string) {
    if (path.startsWith("http://") || path.startsWith("https://")) {
      return path;
    }
    return new URL(path, this.baseUrl).toString();
  }
}

export const appsToolNamespace = "apps";

export const createAppsTools = (options?: AppToolClientOptions) => {
  const client = new AppsToolClient(options);
  return {
    namespace: appsToolNamespace,
    listApps: (tail?: number) => client.listApps(tail),
    appAction: (input: AppToolActionInput) => client.appAction(input),
    tailAppLogs: (input: AppToolLogsInput) => client.tailAppLogs(input),
  };
};
