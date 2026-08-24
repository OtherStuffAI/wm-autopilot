import {
  parseModelProviderSettings,
  serializeModelProviderSettings,
} from "./openrouter-models";

export type InstanceSettingType = "string" | "number" | "boolean" | "json" | "list" | "secret";

export type InstanceSettingCategory =
  | "branding"
  | "runtime"
  | "agents"
  | "integrations"
  | "pipelines"
  | "identity"
  | "internal";

export interface InstanceSettingDefinition {
  key: string;
  label: string;
  description: string;
  category: InstanceSettingCategory;
  type: InstanceSettingType;
  envAliases: string[];
  secret?: boolean;
  bootstrapOnly?: boolean;
  autoImport?: boolean;
  requiresRestart?: boolean;
  cleanupAllowed?: boolean;
  compatibilityEnvName?: string;
  defaultValue?: string;
  options?: readonly string[];
  validate?: (value: string) => string | null;
  normalize?: (value: string) => string;
}

const nonEmpty = (label: string) => (value: string): string | null => {
  return value.trim().length > 0 ? null : `${label} is required`;
};

const optionalUrl = (label: string) => (value: string): string | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? null : `${label} must be an HTTP URL`;
  } catch {
    return `${label} must be a valid URL`;
  }
};

const positiveInteger = (label: string) => (value: string): string | null => {
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? null : `${label} must be a positive integer`;
};

const booleanValue = (label: string) => (value: string): string | null => {
  const normalized = value.trim().toLowerCase();
  return ["true", "false", "1", "0", "yes", "no", "on", "off"].includes(normalized)
    ? null
    : `${label} must be a boolean`;
};

const jsonValue = (label: string) => (value: string): string | null => {
  try {
    JSON.parse(value);
    return null;
  } catch {
    return `${label} must be valid JSON`;
  }
};

const acpPermissionPolicy = (value: string): string | null => {
  return ["auto_approve", "ask"].includes(value.trim().toLowerCase())
    ? null
    : "ACP permission policy must be auto_approve or ask";
};

export const INSTANCE_SETTING_DEFINITIONS: InstanceSettingDefinition[] = [
  {
    key: "branding.name",
    label: "Autopilot Name",
    description: "Name shown in the header and browser title.",
    category: "branding",
    type: "string",
    envAliases: ["AUTOPILOT_NAME", "WINGMAN_NAME"],
    autoImport: true,
    requiresRestart: false,
    cleanupAllowed: true,
    compatibilityEnvName: "AUTOPILOT_NAME",
    defaultValue: "Wingman",
    validate: nonEmpty("Autopilot name"),
  },
  {
    key: "branding.highlight_color",
    label: "Highlight Colour",
    description: "Base colour used to derive the Autopilot accent palette.",
    category: "branding",
    type: "string",
    envAliases: ["AUTOPILOT_HIGHLIGHT_COLOR", "WINGMAN_HIGHLIGHT_COLOR"],
    autoImport: true,
    requiresRestart: false,
    cleanupAllowed: true,
    compatibilityEnvName: "AUTOPILOT_HIGHLIGHT_COLOR",
    defaultValue: "#10b981",
    validate: (value) => /^#[0-9a-f]{6}$/i.test(value.trim())
      ? null
      : "Highlight colour must be a six-digit hex colour",
  },
  {
    key: "runtime.port",
    label: "Port",
    description: "Primary Autopilot UI/API listen port.",
    category: "runtime",
    type: "number",
    envAliases: ["PORT"],
    bootstrapOnly: true,
    requiresRestart: true,
    cleanupAllowed: false,
    validate: positiveInteger("Port"),
  },
  {
    key: "runtime.base_url",
    label: "Base URL",
    description: "Public base URL used for generated links and callbacks.",
    category: "runtime",
    type: "string",
    envAliases: ["WINGMAN_BASE_URL"],
    autoImport: true,
    requiresRestart: true,
    cleanupAllowed: true,
    compatibilityEnvName: "WINGMAN_BASE_URL",
    validate: optionalUrl("Base URL"),
  },
  {
    key: "runtime.host_url_base",
    label: "Legacy Host URL Base",
    description: "Optional legacy port-proxy URL template.",
    category: "runtime",
    type: "string",
    envAliases: ["HOST_URL_BASE", "WINGMAN_HOST_URL_BASE"],
    autoImport: true,
    requiresRestart: true,
    cleanupAllowed: true,
    compatibilityEnvName: "HOST_URL_BASE",
  },
  {
    key: "runtime.connect_relays",
    label: "Connect Relays",
    description: "Comma-separated Nostr relay URLs used by identity/connect flows.",
    category: "runtime",
    type: "list",
    envAliases: ["CONNECT_RELAYS", "WINGMAN_CONNECT_RELAYS"],
    autoImport: true,
    requiresRestart: true,
    cleanupAllowed: true,
    compatibilityEnvName: "CONNECT_RELAYS",
  },
  {
    key: "runtime.app_routing",
    label: "App Routing Mode",
    description: "Hosted app routing mode: path or subdomain.",
    category: "runtime",
    type: "string",
    envAliases: ["APP_ROUTING", "WINGMAN_APP_ROUTING"],
    autoImport: true,
    requiresRestart: true,
    cleanupAllowed: true,
    compatibilityEnvName: "WINGMAN_APP_ROUTING",
    options: ["path", "subdomain"],
    validate: (value) => ["path", "subdomain"].includes(value.trim().toLowerCase())
      ? null
      : "App routing must be path or subdomain",
  },
  {
    key: "runtime.subdomain_base_domain",
    label: "Subdomain Base Domain",
    description: "Base domain used for subdomain app routing.",
    category: "runtime",
    type: "string",
    envAliases: ["SUBDOMAIN_BASE_DOMAIN", "WINGMAN_SUBDOMAIN_BASE_DOMAIN"],
    autoImport: true,
    requiresRestart: true,
    cleanupAllowed: true,
    compatibilityEnvName: "WINGMAN_SUBDOMAIN_BASE_DOMAIN",
  },
  {
    key: "runtime.subdomain_proxy_enabled",
    label: "Subdomain Proxy Enabled",
    description: "Enables proxy handling for app subdomains.",
    category: "runtime",
    type: "boolean",
    envAliases: ["SUBDOMAIN_PROXY_ENABLED", "WINGMAN_SUBDOMAIN_PROXY_ENABLED"],
    autoImport: true,
    requiresRestart: true,
    cleanupAllowed: true,
    compatibilityEnvName: "WINGMAN_SUBDOMAIN_PROXY_ENABLED",
    options: ["true", "false"],
    validate: booleanValue("Subdomain proxy enabled"),
  },
  {
    key: "runtime.identity_session_secret",
    label: "Identity Session Secret",
    description: "Bootstrap encryption/session root. This remains environment-managed.",
    category: "identity",
    type: "secret",
    envAliases: ["IDENTITY_SESSION_SECRET", "WINGMAN_IDENTITY_SESSION_SECRET"],
    secret: true,
    bootstrapOnly: true,
    requiresRestart: true,
    cleanupAllowed: false,
    validate: nonEmpty("Identity session secret"),
  },
  {
    key: "runtime.env_file",
    label: "Writable Env File",
    description: "Optional writable mounted env file used for explicit cleanup.",
    category: "runtime",
    type: "string",
    envAliases: ["WINGMAN_ENV_FILE"],
    bootstrapOnly: true,
    requiresRestart: true,
    cleanupAllowed: false,
  },
  {
    key: "agents.default_agent",
    label: "Default Agent",
    description: "Default agent used for new AI features.",
    category: "agents",
    type: "string",
    envAliases: ["DEFAULT_AGENT", "WINGMAN_DEFAULT_AGENT"],
    autoImport: true,
    requiresRestart: true,
    cleanupAllowed: true,
    compatibilityEnvName: "DEFAULT_AGENT",
  },
  {
    key: "agents.acp_permission_policy",
    label: "ACP Permission Policy",
    description: "Default for new ACP runtime sessions only. Auto approve prefers an offered persistent allow option, then allow once; ask keeps the interactive permission prompt.",
    category: "agents",
    type: "string",
    envAliases: ["ACP_PERMISSION_POLICY", "WINGMAN_ACP_PERMISSION_POLICY"],
    autoImport: true,
    requiresRestart: false,
    cleanupAllowed: true,
    compatibilityEnvName: "ACP_PERMISSION_POLICY",
    defaultValue: "auto_approve",
    options: ["auto_approve", "ask"],
    normalize: (value) => value.trim().toLowerCase(),
    validate: acpPermissionPolicy,
  },
  {
    key: "agents.default_directory",
    label: "Default Directory",
    description: "Default working directory for launched agent sessions.",
    category: "agents",
    type: "string",
    envAliases: ["DIRECTORY_DEF", "WINGMAN_DIRECTORY_DEF"],
    autoImport: true,
    requiresRestart: true,
    cleanupAllowed: true,
    compatibilityEnvName: "DIRECTORY_DEF",
  },
  {
    key: "agents.dispatch_directory",
    label: "Agent Dispatch Directory",
    description: "Default working directory for Flight Deck dispatch agents.",
    category: "agents",
    type: "string",
    envAliases: ["AGENT_DISPATCH_DIRECTORY", "WINGMAN_AGENT_DISPATCH_DIRECTORY"],
    autoImport: true,
    requiresRestart: true,
    cleanupAllowed: true,
    compatibilityEnvName: "AGENT_DISPATCH_DIRECTORY",
  },
  {
    key: "agents.folder_access",
    label: "Folder Access",
    description: "Comma-separated directories exposed to file browsers and pickers.",
    category: "agents",
    type: "list",
    envAliases: ["FOLDERACCESS", "WINGMAN_FOLDERACCESS"],
    autoImport: true,
    requiresRestart: true,
    cleanupAllowed: true,
    compatibilityEnvName: "FOLDERACCESS",
  },
  {
    key: "agents.spawn_mode",
    label: "Agent Spawn Mode",
    description: "Agent processes use direct Bun spawning so restart recovery does not depend on supervisor metadata.",
    category: "agents",
    type: "string",
    envAliases: ["AGENT_SPAWN_MODE", "WINGMAN_AGENT_SPAWN_MODE"],
    autoImport: true,
    requiresRestart: true,
    cleanupAllowed: true,
    compatibilityEnvName: "AGENT_SPAWN_MODE",
    options: ["bun"],
    validate: (value) => value.trim().toLowerCase() === "bun"
      ? null
      : "Agent spawn mode must be bun",
  },
  {
    key: "agents.agent_ports",
    label: "Agent Port Start",
    description: "Starting port assigned to agent subprocesses.",
    category: "agents",
    type: "number",
    envAliases: ["AGENT_PORTS", "WINGMAN_AGENT_PORTS"],
    autoImport: true,
    requiresRestart: true,
    cleanupAllowed: true,
    compatibilityEnvName: "AGENT_PORTS",
    validate: positiveInteger("Agent port start"),
  },
  {
    key: "agents.agent_max",
    label: "Agent Port Count",
    description: "Total number of concurrent agent ports available.",
    category: "agents",
    type: "number",
    envAliases: ["AGENT_MAX", "WINGMAN_AGENT_MAX"],
    autoImport: true,
    requiresRestart: true,
    cleanupAllowed: true,
    compatibilityEnvName: "AGENT_MAX",
    validate: positiveInteger("Agent port count"),
  },
  {
    key: "agents.codex_cli",
    label: "Codex CLI",
    description: "Path or command used to launch Codex.",
    category: "agents",
    type: "string",
    envAliases: ["CODEX_CLI", "WINGMAN_CODEX_CLI"],
    autoImport: true,
    requiresRestart: true,
    cleanupAllowed: true,
    compatibilityEnvName: "CODEX_CLI",
  },
  {
    key: "agents.codex_acp_cli",
    label: "Codex ACP CLI",
    description: "Path to the codex-acp executable used when codex-use-acp is enabled.",
    category: "agents",
    type: "string",
    envAliases: ["CODEX_ACP_CLI", "WINGMAN_CODEX_ACP_CLI"],
    autoImport: true,
    requiresRestart: true,
    cleanupAllowed: true,
    compatibilityEnvName: "CODEX_ACP_CLI",
  },
  {
    key: "agents.claude_cli",
    label: "Claude CLI",
    description: "Path or command used to launch Claude.",
    category: "agents",
    type: "string",
    envAliases: ["CLAUDE_CLI", "WINGMAN_CLAUDE_CLI"],
    autoImport: true,
    requiresRestart: true,
    cleanupAllowed: true,
    compatibilityEnvName: "CLAUDE_CLI",
  },
  {
    key: "agents.goose_cli",
    label: "Goose CLI",
    description: "Path or command used to launch Goose.",
    category: "agents",
    type: "string",
    envAliases: ["GOOSE_CLI", "WINGMAN_GOOSE_CLI"],
    autoImport: true,
    requiresRestart: true,
    cleanupAllowed: true,
    compatibilityEnvName: "GOOSE_CLI",
  },
  {
    key: "agents.goose_provider",
    label: "Goose Provider",
    description: "Default provider used by native Goose ACP sessions.",
    category: "agents",
    type: "string",
    envAliases: ["GOOSE_PROVIDER", "WINGMAN_GOOSE_PROVIDER"],
    autoImport: true,
    requiresRestart: true,
    cleanupAllowed: true,
    compatibilityEnvName: "GOOSE_PROVIDER",
    defaultValue: "openrouter",
    validate: nonEmpty("Goose provider"),
  },
  {
    key: "agents.goose_model",
    label: "Goose Model",
    description: "Optional operator model override used by native Goose ACP sessions.",
    category: "agents",
    type: "string",
    envAliases: ["GOOSE_MODEL", "WINGMAN_GOOSE_MODEL"],
    autoImport: true,
    requiresRestart: true,
    cleanupAllowed: true,
    compatibilityEnvName: "GOOSE_MODEL",
    validate: nonEmpty("Goose model"),
  },
  {
    key: "agents.opencode_cli",
    label: "OpenCode CLI",
    description: "Path or command used to launch OpenCode.",
    category: "agents",
    type: "string",
    envAliases: ["OPENCODE_CLI", "WINGMAN_OPENCODE_CLI"],
    autoImport: true,
    requiresRestart: true,
    cleanupAllowed: true,
    compatibilityEnvName: "OPENCODE_CLI",
  },
  {
    key: "agents.pi_cli",
    label: "Pi CLI",
    description: "Path or command used to launch Pi.",
    category: "agents",
    type: "string",
    envAliases: ["PI_CLI", "WINGMAN_PI_CLI"],
    autoImport: true,
    requiresRestart: true,
    cleanupAllowed: true,
    compatibilityEnvName: "PI_CLI",
  },
  {
    key: "agents.pi_acp_cli",
    label: "Pi ACP CLI",
    description: "Path to the pi-acp executable used when pi-use-acp is enabled.",
    category: "agents",
    type: "string",
    envAliases: ["PI_ACP_CLI", "WINGMAN_PI_ACP_CLI"],
    autoImport: true,
    requiresRestart: true,
    cleanupAllowed: true,
    compatibilityEnvName: "PI_ACP_CLI",
  },
  {
    key: "agents.maple_acp_cli",
    label: "Maple Desktop ACP Executable",
    description: "Absolute path to Maple Desktop's packaged ACP connector executable.",
    category: "agents",
    type: "string",
    envAliases: ["MAPLE_ACP_CLI", "WINGMAN_MAPLE_ACP_CLI"],
    autoImport: true,
    requiresRestart: true,
    cleanupAllowed: true,
    compatibilityEnvName: "MAPLE_ACP_CLI",
    defaultValue: "/Applications/Maple.app/Contents/MacOS/maple",
    validate: (value) => value.trim().startsWith("/")
      ? null
      : "Maple Desktop ACP executable must be an absolute path",
  },
  {
    key: "models.providers",
    label: "Model Providers",
    description: "Ordered launch models grouped by provider.",
    category: "agents",
    type: "json",
    envAliases: [],
    requiresRestart: false,
    cleanupAllowed: false,
    validate: (value) => {
      try {
        parseModelProviderSettings(value);
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
    normalize: (value) => {
      const settings = parseModelProviderSettings(value);
      return serializeModelProviderSettings(settings.providers.openrouter.models);
    },
  },
  {
    key: "integrations.maple_proxy_url",
    label: "Maple Proxy URL",
    description: "Maple proxy base URL for private chat AI completion.",
    category: "integrations",
    type: "string",
    envAliases: ["MAPLE_PROXY_URL"],
    autoImport: true,
    requiresRestart: true,
    cleanupAllowed: true,
    compatibilityEnvName: "MAPLE_PROXY_URL",
    validate: optionalUrl("Maple proxy URL"),
  },
  {
    key: "integrations.maple_default_model",
    label: "Maple Default Model",
    description: "Default model for new private chats.",
    category: "integrations",
    type: "string",
    envAliases: ["MAPLE_DEFAULT_MODEL"],
    autoImport: true,
    requiresRestart: true,
    cleanupAllowed: true,
    compatibilityEnvName: "MAPLE_DEFAULT_MODEL",
  },
  {
    key: "integrations.maple_api_key",
    label: "Maple API Key",
    description: "API key for Maple proxy authentication.",
    category: "integrations",
    type: "secret",
    envAliases: ["MAPLE_API"],
    secret: true,
    autoImport: true,
    requiresRestart: true,
    cleanupAllowed: true,
    compatibilityEnvName: "MAPLE_API",
  },
  {
    key: "integrations.gitea_url",
    label: "Gitea URL",
    description: "Gitea instance base URL.",
    category: "integrations",
    type: "string",
    envAliases: ["GITEA_URL"],
    autoImport: true,
    requiresRestart: true,
    cleanupAllowed: true,
    compatibilityEnvName: "GITEA_URL",
    validate: optionalUrl("Gitea URL"),
  },
  {
    key: "integrations.gitea_api_token",
    label: "Gitea API Token",
    description: "Gitea API token for repository creation.",
    category: "integrations",
    type: "secret",
    envAliases: ["GITEA_API_TOKEN"],
    secret: true,
    autoImport: true,
    requiresRestart: true,
    cleanupAllowed: true,
    compatibilityEnvName: "GITEA_API_TOKEN",
  },
  {
    key: "integrations.gitea_owner",
    label: "Gitea Owner",
    description: "Gitea username or organization used for created repositories.",
    category: "integrations",
    type: "string",
    envAliases: ["GITEA_OWNER"],
    autoImport: true,
    requiresRestart: true,
    cleanupAllowed: true,
    compatibilityEnvName: "GITEA_OWNER",
  },
  {
    key: "integrations.openrouter_api_key",
    label: "OpenRouter API Key",
    description: "OpenRouter runtime API key.",
    category: "integrations",
    type: "secret",
    envAliases: ["OPENROUTER_API", "OPENROUTER_API_KEY", "OPENROUTER_TEAM_RUNTIME_KEY", "OPENROUTER_BILLING_RUNTIME_KEY"],
    secret: true,
    autoImport: true,
    requiresRestart: true,
    cleanupAllowed: true,
    compatibilityEnvName: "OPENROUTER_API",
  },
  {
    key: "integrations.openrouter_management_key",
    label: "OpenRouter Management Key",
    description: "OpenRouter management/provisioning key for team billing.",
    category: "integrations",
    type: "secret",
    envAliases: ["OPENROUTER_PROVISIONING_KEY", "OPENROUTER_MANAGEMENT_KEY"],
    secret: true,
    autoImport: true,
    requiresRestart: true,
    cleanupAllowed: true,
    compatibilityEnvName: "OPENROUTER_PROVISIONING_KEY",
  },
  {
    key: "integrations.caprover_primary_url",
    label: "CapRover URL",
    description: "Primary CapRover server URL.",
    category: "integrations",
    type: "string",
    envAliases: ["CAPROVER_URL", "CAPROVER_PRIMARY_URL"],
    secret: false,
    autoImport: true,
    requiresRestart: true,
    cleanupAllowed: true,
    compatibilityEnvName: "CAPROVER_URL",
    validate: optionalUrl("CapRover URL"),
  },
  {
    key: "integrations.caprover_primary_login",
    label: "CapRover Login Secret",
    description: "Primary CapRover login code or password.",
    category: "integrations",
    type: "secret",
    envAliases: ["CAPROVER_LOGIN_CODE", "CAPROVER_PASSWORD", "CAPROVER_PRIMARY_LOGIN_CODE", "CAPROVER_PRIMARY_PASSWORD"],
    secret: true,
    autoImport: true,
    requiresRestart: true,
    cleanupAllowed: true,
    compatibilityEnvName: "CAPROVER_LOGIN_CODE",
  },
  {
    key: "identity.admin_npubs",
    label: "Admin Npubs",
    description: "Comma-separated admin npubs. This remains environment-managed.",
    category: "identity",
    type: "list",
    envAliases: ["ADMIN_NPUBS", "ADMIN_NPUB", "WINGMAN_ADMIN_NPUB"],
    bootstrapOnly: true,
    requiresRestart: true,
    cleanupAllowed: false,
  },
  {
    key: "identity.registration_enabled",
    label: "Registration Toggle",
    description: "Set false to block new signups.",
    category: "identity",
    type: "boolean",
    envAliases: ["REGISTER", "WINGMAN_REGISTER"],
    autoImport: true,
    requiresRestart: true,
    cleanupAllowed: true,
    compatibilityEnvName: "REGISTER",
    options: ["true", "false"],
    validate: (value) => ["true", "false", "1", "0", "yes", "no", "on", "off"].includes(value.trim().toLowerCase())
      ? null
      : "Registration toggle must be a boolean",
  },
  {
    key: "identity.wingman_priv",
    label: "Wingman Instance Private Key",
    description: "Canonical Wingman instance private key.",
    category: "identity",
    type: "secret",
    envAliases: ["WINGMAN_PRIV"],
    secret: true,
    autoImport: true,
    requiresRestart: true,
    cleanupAllowed: true,
    compatibilityEnvName: "WINGMAN_PRIV",
  },
  {
    key: "internal.keyteleport_privkey",
    label: "Key Teleport Private Key",
    description: "Private key used to decrypt Key Teleport blobs.",
    category: "internal",
    type: "secret",
    envAliases: ["KEYTELEPORT_PRIVKEY", "WINGMAN_KEYTELEPORT_PRIVKEY"],
    secret: true,
    autoImport: true,
    requiresRestart: true,
    cleanupAllowed: true,
    compatibilityEnvName: "KEYTELEPORT_PRIVKEY",
  },
  {
    key: "internal.keyteleport_welcome_pubkey",
    label: "Key Teleport Welcome Pubkey",
    description: "Trusted Welcome pubkey for Key Teleport event verification.",
    category: "internal",
    type: "string",
    envAliases: ["KEYTELEPORT_WELCOME_PUBKEY", "WINGMAN_KEYTELEPORT_WELCOME_PUBKEY"],
    autoImport: true,
    requiresRestart: true,
    cleanupAllowed: true,
    compatibilityEnvName: "KEYTELEPORT_WELCOME_PUBKEY",
  },
  {
    key: "internal.keyteleport_welcome_url",
    label: "Key Teleport Welcome URL",
    description: "Welcome Key Teleport app URL.",
    category: "internal",
    type: "string",
    envAliases: ["KEYTELEPORT_WELCOME_URL", "WINGMAN_KEYTELEPORT_WELCOME_URL"],
    autoImport: true,
    requiresRestart: true,
    cleanupAllowed: true,
    compatibilityEnvName: "KEYTELEPORT_WELCOME_URL",
    validate: optionalUrl("Key Teleport Welcome URL"),
  },
  {
    key: "pipelines.root",
    label: "Pipelines Root",
    description: "Root directory for declarative pipeline definitions.",
    category: "pipelines",
    type: "string",
    envAliases: ["WINGMEN_PIPELINES_ROOT"],
    autoImport: true,
    requiresRestart: true,
    cleanupAllowed: true,
    compatibilityEnvName: "WINGMEN_PIPELINES_ROOT",
  },
  {
    key: "pipelines.http_trigger_token",
    label: "Pipeline HTTP Trigger Token",
    description: "Token used to authorize pipeline HTTP triggers.",
    category: "pipelines",
    type: "secret",
    envAliases: ["WINGMEN_PIPELINE_HTTP_TRIGGER_TOKEN"],
    secret: true,
    autoImport: true,
    requiresRestart: true,
    cleanupAllowed: true,
    compatibilityEnvName: "WINGMEN_PIPELINE_HTTP_TRIGGER_TOKEN",
  },
  {
    key: "pipelines.classifier_openrouter_api_key",
    label: "Pipeline Classifier OpenRouter Key",
    description: "OpenRouter key used by pipeline classifier steps.",
    category: "pipelines",
    type: "secret",
    envAliases: ["PIPELINE_CLASSIFIER_OPENROUTER_API_KEY"],
    secret: true,
    autoImport: true,
    requiresRestart: true,
    cleanupAllowed: true,
    compatibilityEnvName: "PIPELINE_CLASSIFIER_OPENROUTER_API_KEY",
  },
  {
    key: "internal.webhook_off_token",
    label: "Webhook Off Token",
    description: "Token used to authorize webhook-off actions.",
    category: "internal",
    type: "secret",
    envAliases: ["WEBHOOK_OFF_TOKEN"],
    secret: true,
    autoImport: true,
    requiresRestart: true,
    cleanupAllowed: true,
    compatibilityEnvName: "WEBHOOK_OFF_TOKEN",
  },
  {
    key: "internal.signing_secret",
    label: "Runner Signing Secret",
    description: "Secret used to mint runner capability tokens.",
    category: "internal",
    type: "secret",
    envAliases: ["WINGMAN_SIGNING_SECRET"],
    secret: true,
    autoImport: true,
    requiresRestart: true,
    cleanupAllowed: true,
    compatibilityEnvName: "WINGMAN_SIGNING_SECRET",
  },
  {
    key: "internal.wapp_tower_url",
    label: "WApp Tower URL",
    description: "Tower URL injected into WApp runtimes.",
    category: "internal",
    type: "string",
    envAliases: ["WAPP_TOWER_URL", "TOWER_URL", "WINGMAN_TOWER_URL"],
    autoImport: true,
    requiresRestart: true,
    cleanupAllowed: true,
    compatibilityEnvName: "WAPP_TOWER_URL",
    validate: optionalUrl("WApp Tower URL"),
  },
  {
    key: "internal.wapp_allowed_npubs_json",
    label: "WApp Allowed Npubs JSON",
    description: "JSON allowlist used by standalone WApp runtimes.",
    category: "internal",
    type: "json",
    envAliases: ["WAPP_ALLOWED_NPUBS_JSON"],
    autoImport: true,
    requiresRestart: true,
    cleanupAllowed: true,
    compatibilityEnvName: "WAPP_ALLOWED_NPUBS_JSON",
    validate: jsonValue("WApp allowed npubs"),
  },
];

export const INSTANCE_SETTING_DEFINITION_BY_KEY = new Map(
  INSTANCE_SETTING_DEFINITIONS.map((definition) => [definition.key, definition]),
);

export const INSTANCE_SETTING_ALIAS_TO_DEFINITION = new Map<string, InstanceSettingDefinition>();

for (const definition of INSTANCE_SETTING_DEFINITIONS) {
  for (const alias of definition.envAliases) {
    INSTANCE_SETTING_ALIAS_TO_DEFINITION.set(alias, definition);
  }
}

export function getInstanceSettingDefinition(key: string): InstanceSettingDefinition | null {
  return INSTANCE_SETTING_DEFINITION_BY_KEY.get(key) ?? null;
}

export function validateInstanceSettingValue(definition: InstanceSettingDefinition, value: string): string | null {
  if (definition.validate) {
    return definition.validate(value);
  }
  if (definition.type === "json") {
    return jsonValue(definition.label)(value);
  }
  if (definition.type === "number") {
    return positiveInteger(definition.label)(value);
  }
  if (definition.type === "boolean") {
    return booleanValue(definition.label)(value);
  }
  return null;
}
