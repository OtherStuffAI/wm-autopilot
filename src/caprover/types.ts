/**
 * CapRover Integration Types
 *
 * Types for the CapRover API client, store, and API handler.
 */

// ============================================================
// CapRover API Response Types
// ============================================================

export interface CaproverApiResponse<T = unknown> {
  status: number;
  description: string;
  data: T;
}

export interface CaproverAppDefinition {
  appName: string;
  hasPersistentData: boolean;
  hasDefaultSubDomainSsl: boolean;
  containerHttpPort: number;
  notExposeAsWebApp: boolean;
  instanceCount: number;
  captainDefinitionRelativeFilePath: string;
  envVars: CaproverEnvVar[];
  volumes: CaproverVolume[];
  ports: CaproverPortMapping[];
  appPushWebhook?: {
    repoInfo: CaproverRepoInfo;
    pushWebhookToken: string;
  };
  customDomain?: CaproverCustomDomain[];
  isAppBuilding?: boolean;
  deployedVersion?: number;
}

export interface CaproverEnvVar {
  key: string;
  value: string;
}

export interface CaproverVolume {
  containerPath: string;
  hostPath?: string;
  volumeName?: string;
}

export interface CaproverPortMapping {
  containerPort: number;
  hostPort: number;
  protocol?: "tcp" | "udp";
}

export interface CaproverRepoInfo {
  user: string;
  password: string;
  sshKey: string;
  repo: string;
  branch: string;
}

export interface CaproverCustomDomain {
  publicDomain: string;
  hasSsl: boolean;
}

export interface CaproverLoginResponse {
  token: string;
}

export interface CaproverAppsResponse {
  appDefinitions: CaproverAppDefinition[];
  rootDomain: string;
  defaultNginxConfig: string;
}

// ============================================================
// Local Store Types
// ============================================================

export interface CaproverAppRecord {
  id: string;
  /** Link to local app in app-registry */
  appId: string | null;
  /** Link to project */
  projectId: string | null;
  /** CapRover app name */
  caproverName: string;
  /** Full URL to the app (e.g., https://myapp.captain.example.com) */
  liveUrl: string | null;
  /** Custom domain if configured */
  customDomain: string | null;
  /** Whether SSL is enabled */
  hasSsl: boolean;
  /** Environment variables (stored encrypted) */
  envVarsEncrypted: string | null;
  /** Last known deployment version */
  deployedVersion: number | null;
  /** Notes about this deployment */
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CaproverDeploymentRecord {
  id: string;
  /** Link to caprover_apps record */
  caproverAppId: string;
  /** CapRover target name that received this deployment */
  targetName: string;
  /** Deployment version number */
  version: number | null;
  /** Deployment status */
  status: DeploymentStatus;
  /** How the deployment was initiated */
  deployMethod: DeployMethod;
  /** Docker image if deployed from image */
  dockerImage: string | null;
  /** Git commit hash if deployed from repo */
  gitHash: string | null;
  /** Deployment started at */
  startedAt: string;
  /** Deployment completed at */
  completedAt: string | null;
  /** Error message if failed */
  errorMessage: string | null;
  /** Build logs (stored encrypted) */
  logsEncrypted: string | null;
}

export type DeploymentStatus = "pending" | "building" | "success" | "failed";

export type DeployMethod = "docker_image" | "tar_upload" | "git_push" | "captain_definition";

// ============================================================
// API Handler Types
// ============================================================

export interface CreateCaproverAppInput {
  /** CapRover app name (must be lowercase, alphanumeric with hyphens) */
  caproverName: string;
  /** Link to local app (optional) */
  appId?: string | null;
  /** Link to project (optional) */
  projectId?: string | null;
  /** Whether app has persistent data */
  hasPersistentData?: boolean;
  /** Notes */
  notes?: string | null;
}

export interface UpdateCaproverAppInput {
  /** Link to local app */
  appId?: string | null;
  /** Link to project */
  projectId?: string | null;
  /** Custom domain */
  customDomain?: string | null;
  /** Notes */
  notes?: string | null;
}

export interface DeployAppInput {
  /** Deploy from Docker image */
  dockerImage?: string;
  /** Deploy from captain-definition JSON */
  captainDefinition?: CaptainDefinition;
}

export interface CaptainDefinition {
  schemaVersion: 2;
  imageName?: string;
  dockerfilePath?: string;
  dockerfileLines?: string[];
  templateId?: string;
}

export interface UpdateAppConfigInput {
  /** Instance count */
  instanceCount?: number;
  /** Container HTTP port */
  containerHttpPort?: number;
  /** Environment variables */
  envVars?: CaproverEnvVar[];
  /** Persistent directory mappings */
  volumes?: CaproverVolume[];
  /** Enable/disable SSL on default subdomain */
  enableSsl?: boolean;
  /** Add custom domain */
  addCustomDomain?: string;
  /** Remove custom domain */
  removeCustomDomain?: string;
  /** Enable SSL on custom domain */
  enableSslOnDomain?: string;
}

// ============================================================
// Client Config Types
// ============================================================

export interface CaproverClientConfig {
  /** CapRover dashboard URL (e.g., https://captain.example.com) */
  serverUrl: string;
  /** Login password */
  password: string;
}
