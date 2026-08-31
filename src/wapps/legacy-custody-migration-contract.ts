import { nip19 } from "nostr-tools";

export interface LegacyWappInstallationMetadata {
  installationId: string;
  title: string;
  description?: string | null;
  ownerNpub: string;
  createdByNpub: string;
  workspaceOwnerNpub: string;
  scopeId: string;
  allowedNpubs: string[];
  launchUrl: string;
  sourceWingmanUrl?: string | null;
  subdomainAlias?: string | null;
  registeredOpenOrigins?: string[];
}

export interface LegacyWappCustodyMigrationInput {
  appId: string;
  sourceEnvFile: string;
  expectedAppNpub: string;
  towerBindingId: string;
  installation: LegacyWappInstallationMetadata;
  apply?: boolean;
  autoStart?: boolean;
}

export interface LegacyWappCustodyMigrationResult {
  dryRun: boolean;
  appId: string;
  installationId: string;
  appNpub: string;
  towerBindingId: string;
  assignment: "create" | "verified";
  custodyVerified: boolean;
  sourceSecretPresent: boolean;
  sourceSecretRemoved: boolean;
  reviewReason: "clear" | "already-clear";
  remainingReviewReasons: string[];
  autoStart: boolean;
}

export class LegacyWappCustodyMigrationError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "LegacyWappCustodyMigrationError";
  }
}

export function legacyCustodyInvalid(message: string): never {
  throw new LegacyWappCustodyMigrationError("legacy_custody_invalid", 400, message);
}

export function legacyCustodyConflict(message: string): never {
  throw new LegacyWappCustodyMigrationError("legacy_custody_conflict", 409, message);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) legacyCustodyInvalid(`${field} is required`);
  return value.trim();
}

function optionalString(value: unknown, field: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") legacyCustodyInvalid(`${field} must be a string or null`);
  return value.trim() || null;
}

function validNpub(value: unknown, field: string): string {
  const npub = requiredString(value, field);
  try {
    const decoded = nip19.decode(npub);
    if (decoded.type !== "npub" || typeof decoded.data !== "string") throw new Error("wrong type");
  } catch {
    legacyCustodyInvalid(`${field} must be a valid npub`);
  }
  return npub;
}

function validUrl(value: unknown, field: string): string {
  const input = requiredString(value, field);
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    legacyCustodyInvalid(`${field} must be an absolute HTTP URL`);
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) {
    legacyCustodyInvalid(`${field} must be an absolute HTTP URL without credentials`);
  }
  return parsed.toString();
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) legacyCustodyInvalid(`${field} must be an array`);
  return value.map((entry, index) => requiredString(entry, `${field}[${index}]`));
}

function npubArray(value: unknown, field: string): string[] {
  const values = stringArray(value, field).map((entry, index) => validNpub(entry, `${field}[${index}]`));
  const unique = Array.from(new Set(values)).sort();
  if (unique.length === 0) legacyCustodyInvalid(`${field} must contain at least one npub`);
  return unique;
}

function rejectUnexpectedFields(record: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(record).some((key) => !allowedSet.has(key))) {
    legacyCustodyInvalid(`${field} contains unsupported fields`);
  }
}

export function parseLegacyWappCustodyMigrationInput(value: unknown): LegacyWappCustodyMigrationInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) legacyCustodyInvalid("Migration input must be an object");
  const record = value as Record<string, unknown>;
  rejectUnexpectedFields(record, ["appId", "sourceEnvFile", "expectedAppNpub", "towerBindingId", "installation", "apply", "autoStart"], "Migration input");
  const installationValue = record.installation;
  if (!installationValue || typeof installationValue !== "object" || Array.isArray(installationValue)) {
    legacyCustodyInvalid("installation must be an object");
  }
  const installation = installationValue as Record<string, unknown>;
  rejectUnexpectedFields(installation, [
    "installationId",
    "title",
    "description",
    "ownerNpub",
    "createdByNpub",
    "workspaceOwnerNpub",
    "scopeId",
    "allowedNpubs",
    "launchUrl",
    "sourceWingmanUrl",
    "subdomainAlias",
    "registeredOpenOrigins",
  ], "installation");
  const ownerNpub = validNpub(installation.ownerNpub, "installation.ownerNpub");
  const allowedNpubs = npubArray(installation.allowedNpubs, "installation.allowedNpubs");
  if (!allowedNpubs.includes(ownerNpub)) legacyCustodyInvalid("installation.allowedNpubs must include installation.ownerNpub");
  if (record.apply !== undefined && typeof record.apply !== "boolean") legacyCustodyInvalid("apply must be a boolean");
  if (record.autoStart !== undefined && typeof record.autoStart !== "boolean") legacyCustodyInvalid("autoStart must be a boolean");
  const registeredOpenOrigins = installation.registeredOpenOrigins === undefined
    ? undefined
    : stringArray(installation.registeredOpenOrigins, "installation.registeredOpenOrigins")
      .map((entry, index) => validUrl(entry, `installation.registeredOpenOrigins[${index}]`));
  return {
    appId: requiredString(record.appId, "appId"),
    sourceEnvFile: requiredString(record.sourceEnvFile, "sourceEnvFile"),
    expectedAppNpub: validNpub(record.expectedAppNpub, "expectedAppNpub"),
    towerBindingId: requiredString(record.towerBindingId, "towerBindingId"),
    installation: {
      installationId: requiredString(installation.installationId, "installation.installationId"),
      title: requiredString(installation.title, "installation.title"),
      description: optionalString(installation.description, "installation.description"),
      ownerNpub,
      createdByNpub: validNpub(installation.createdByNpub, "installation.createdByNpub"),
      workspaceOwnerNpub: validNpub(installation.workspaceOwnerNpub, "installation.workspaceOwnerNpub"),
      scopeId: requiredString(installation.scopeId, "installation.scopeId"),
      allowedNpubs,
      launchUrl: validUrl(installation.launchUrl, "installation.launchUrl"),
      sourceWingmanUrl: installation.sourceWingmanUrl === undefined || installation.sourceWingmanUrl === null
        ? optionalString(installation.sourceWingmanUrl, "installation.sourceWingmanUrl")
        : validUrl(installation.sourceWingmanUrl, "installation.sourceWingmanUrl"),
      subdomainAlias: optionalString(installation.subdomainAlias, "installation.subdomainAlias"),
      registeredOpenOrigins,
    },
    apply: record.apply === true,
    autoStart: record.autoStart as boolean | undefined,
  };
}
