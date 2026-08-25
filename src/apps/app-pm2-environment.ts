const APP_RUNNER_HOST_ENV_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TMPDIR",
  "TMP",
  "TEMP",
  "BUN_INSTALL",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NO_COLOR",
  "FORCE_COLOR",
] as const;

const APP_RUNNER_CONTROL_ENV_KEYS = new Set([
  "APP_ID",
  "USER_ALIAS",
  "WAPP_ID",
  "WINGMAN_PROCESS_KIND",
]);

const allowedHostKeys = new Set<string>(APP_RUNNER_HOST_ENV_KEYS);

export interface AppPm2EnvironmentBoundary {
  env: Record<string, string>;
  filteredParentKeys: string[];
}

export function buildAppPm2EnvironmentBoundary(
  hostEnv: Record<string, string | undefined>,
): AppPm2EnvironmentBoundary {
  const env: Record<string, string> = {};
  for (const key of APP_RUNNER_HOST_ENV_KEYS) {
    const value = hostEnv[key];
    if (typeof value === "string" && value.length > 0) env[key] = value;
  }

  const filteredParentKeys = Object.keys(hostEnv)
    .filter((key) => !allowedHostKeys.has(key) && !APP_RUNNER_CONTROL_ENV_KEYS.has(key))
    .sort();

  return { env, filteredParentKeys };
}
