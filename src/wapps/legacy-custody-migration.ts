import { randomUUID } from "node:crypto";
import { lstat, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

import {
  WAPP_TOWER_BROKER_REVIEW_REASON,
  appRegistry,
  type AppLifecycleScripts,
  type AppRecord,
  type AppRegistry,
} from "../apps/app-registry";
import { parseDotenvText } from "../apps/dotenv-file";
import { removeForbiddenAppSigningEnv } from "../apps/app-env";
import { deriveWappAppNpubFromNsec } from "./app-key";
import {
  LegacyWappCustodyMigrationError,
  legacyCustodyConflict as conflict,
  legacyCustodyInvalid as invalid,
  parseLegacyWappCustodyMigrationInput,
  type LegacyWappCustodyMigrationInput,
  type LegacyWappCustodyMigrationResult,
} from "./legacy-custody-migration-contract";
import { normalizeRegisteredOpenOrigins } from "./publication-metadata";
import type { CreateWappInput, WappRecord, WappTowerBinding } from "./types";
import { wappStore, type WappStore } from "./wapp-store";

const LEGACY_NSEC_LINE = /^[\t ]*(?:export[\t ]+)?WAPP_NSEC[\t ]*=([^\r\n]*)(?:\r\n|\n|\r|$)/gm;
const MAX_SOURCE_ENV_BYTES = 1024 * 1024;

interface AppRegistryAccess {
  getApp: AppRegistry["getApp"];
  discoverScripts: AppRegistry["discoverScripts"];
  reviewWappTowerBrokerMigration: AppRegistry["reviewWappTowerBrokerMigration"];
  updateApp: AppRegistry["updateApp"];
}

interface WappStoreAccess {
  get: WappStore["get"];
  getByAppId: WappStore["getByAppId"];
  getTowerBinding: WappStore["getTowerBinding"];
  create: WappStore["create"];
  hasAppSigningKey: WappStore["hasAppSigningKey"];
  withAppSigningKey: WappStore["withAppSigningKey"];
}

interface LegacySource {
  path: string;
  original: string;
  cleaned: string;
  nsec: string | null;
}

function sameStrings(left: string[], right: string[]): boolean {
  return JSON.stringify(Array.from(new Set(left)).sort()) === JSON.stringify(Array.from(new Set(right)).sort());
}

function assertTowerBinding(binding: WappTowerBinding | null, input: LegacyWappCustodyMigrationInput): asserts binding is WappTowerBinding {
  if (!binding) conflict(`Tower binding ${input.towerBindingId} does not exist`);
  if (binding.workspaceOwnerNpub !== input.installation.workspaceOwnerNpub) {
    conflict("Tower binding workspace owner does not match the requested installation");
  }
}

function assertExistingAssignment(record: WappRecord, input: LegacyWappCustodyMigrationInput): void {
  const expected = input.installation;
  const expectedOrigins = normalizeRegisteredOpenOrigins(expected.registeredOpenOrigins, expected.launchUrl);
  const matches = record.id === expected.installationId
    && record.wappInstallationId === expected.installationId
    && record.appId === input.appId
    && record.title === expected.title
    && record.description === (expected.description ?? null)
    && record.ownerNpub === expected.ownerNpub
    && record.createdByNpub === expected.createdByNpub
    && record.workspaceOwnerNpub === expected.workspaceOwnerNpub
    && record.scopeId === expected.scopeId
    && sameStrings(record.allowedNpubs, expected.allowedNpubs)
    && record.launchUrl === expected.launchUrl
    && record.sourceWingmanUrl === (expected.sourceWingmanUrl ?? null)
    && record.subdomainAlias === (expected.subdomainAlias ?? null)
    && record.towerBindingId === input.towerBindingId
    && record.appNpub === input.expectedAppNpub
    && sameStrings(record.registeredOpenOrigins, expectedOrigins)
    && record.status === "active"
    && record.recordState === "active";
  if (!matches) conflict("Existing WApp assignment conflicts with the requested legacy identity or installation metadata");
}

function assertAppRecord(app: AppRecord | undefined, input: LegacyWappCustodyMigrationInput): asserts app is AppRecord {
  if (!app) throw new LegacyWappCustodyMigrationError("legacy_custody_app_not_found", 404, `Unknown app: ${input.appId}`);
  if (app.id !== input.appId) conflict("Registered app id does not match the requested migration");
  if (!app.webApp) conflict("Legacy custody migration requires a registered web app");
  if (app.ownerNpub !== input.installation.ownerNpub) conflict("Registered app owner does not match the requested installation owner");
  if (removeForbiddenAppSigningEnv(app.env).removedKeys.length > 0) {
    conflict("Registered app still contains forbidden signing environment material");
  }
}

async function readLegacySource(appRoot: string, sourceEnvFile: string): Promise<LegacySource> {
  if (!isAbsolute(sourceEnvFile)) invalid("sourceEnvFile must be an absolute path");
  const requestedSourcePath = resolve(sourceEnvFile);
  const requestedRootPath = resolve(appRoot);
  const requestedRelativePath = relative(requestedRootPath, requestedSourcePath);
  if (!requestedRelativePath || requestedRelativePath.startsWith("..") || isAbsolute(requestedRelativePath)) {
    invalid("sourceEnvFile must be a named file inside the registered app root");
  }
  let requestedStats: Awaited<ReturnType<typeof lstat>>;
  let rootPath: string;
  let sourcePath: string;
  try {
    requestedStats = await lstat(requestedSourcePath);
    [rootPath, sourcePath] = await Promise.all([realpath(appRoot), realpath(requestedSourcePath)]);
  } catch {
    invalid("sourceEnvFile must name an existing file inside the registered app root");
  }
  const relativePath = relative(rootPath, sourcePath);
  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    invalid("sourceEnvFile must be a named file inside the registered app root");
  }
  if (!requestedStats.isFile() || requestedStats.isSymbolicLink()) invalid("sourceEnvFile must be a regular file, not a symlink");
  if (requestedStats.size > MAX_SOURCE_ENV_BYTES) invalid(`sourceEnvFile exceeds ${MAX_SOURCE_ENV_BYTES} bytes`);
  const original = await readFile(sourcePath, "utf8");
  const matches = Array.from(original.matchAll(LEGACY_NSEC_LINE));
  if (matches.length > 1) invalid("sourceEnvFile contains multiple WAPP_NSEC assignments");
  if (matches.length === 0) return { path: sourcePath, original, cleaned: original, nsec: null };
  const match = matches[0]!;
  const parsed = parseDotenvText(match[0]).env.WAPP_NSEC;
  if (!parsed?.trim()) invalid("sourceEnvFile WAPP_NSEC assignment is empty or invalid");
  const start = match.index!;
  return {
    path: sourcePath,
    original,
    cleaned: `${original.slice(0, start)}${original.slice(start + match[0].length)}`,
    nsec: parsed,
  };
}

async function atomicallyCleanLegacySource(source: LegacySource): Promise<void> {
  if (!source.nsec) return;
  const current = await readFile(source.path, "utf8");
  if (current !== source.original) conflict("sourceEnvFile changed during migration; no plaintext cleanup was attempted");
  const temporaryPath = `${dirname(source.path)}/.${basename(source.path)}.wapp-custody-${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(source.cleaned, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporaryPath, source.path);
    const directoryHandle = await open(dirname(source.path), "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function createInput(input: LegacyWappCustodyMigrationInput, appNsec: string): CreateWappInput {
  const installation = input.installation;
  return {
    id: installation.installationId,
    appId: input.appId,
    title: installation.title,
    description: installation.description ?? null,
    ownerNpub: installation.ownerNpub,
    createdByNpub: installation.createdByNpub,
    workspaceOwnerNpub: installation.workspaceOwnerNpub,
    scopeId: installation.scopeId,
    allowedNpubs: installation.allowedNpubs,
    launchUrl: installation.launchUrl,
    sourceWingmanUrl: installation.sourceWingmanUrl ?? null,
    subdomainAlias: installation.subdomainAlias ?? null,
    towerBindingId: input.towerBindingId,
    appKeyMode: "import",
    appNsec,
    registeredOpenOrigins: installation.registeredOpenOrigins,
  };
}

async function requireSafeScripts(registry: AppRegistryAccess, app: AppRecord): Promise<AppLifecycleScripts> {
  const scripts = await registry.discoverScripts(app.root);
  if (Object.keys(scripts).length === 0) conflict(`App ${app.id} has no safe lifecycle scripts to review`);
  return scripts;
}

export class LegacyWappCustodyMigration {
  constructor(
    private readonly store: WappStoreAccess = wappStore,
    private readonly registry: AppRegistryAccess = appRegistry,
  ) {}

  async migrate(rawInput: unknown): Promise<LegacyWappCustodyMigrationResult> {
    const input = parseLegacyWappCustodyMigrationInput(rawInput);
    const app = await this.registry.getApp(input.appId);
    assertAppRecord(app, input);
    await requireSafeScripts(this.registry, app);
    const binding = this.store.getTowerBinding(input.towerBindingId);
    assertTowerBinding(binding, input);
    const source = await readLegacySource(app.root, input.sourceEnvFile);
    if (source.nsec) {
      let derived: string;
      try {
        derived = deriveWappAppNpubFromNsec(source.nsec);
      } catch {
        invalid("sourceEnvFile WAPP_NSEC is invalid or does not derive the expected public identity");
      }
      if (derived !== input.expectedAppNpub) {
        conflict("sourceEnvFile WAPP_NSEC does not derive the expected public identity");
      }
    }

    const byId = this.store.get(input.installation.installationId);
    const byApp = this.store.getByAppId(input.appId);
    if (byId && byApp && byId.id !== byApp.id) conflict("WApp installation id and app assignment refer to different records");
    const existing = byId ?? byApp;
    if (existing) assertExistingAssignment(existing, input);
    if (!existing && !source.nsec) conflict("sourceEnvFile has no WAPP_NSEC and no matching custodial WApp assignment exists");

    const reasonPresent = (app.lifecycleReviewReasons ?? []).includes(WAPP_TOWER_BROKER_REVIEW_REASON);
    const requestedAutoStart = input.autoStart ?? Boolean(app.autoStart);
    if (!input.apply) {
      let custodyVerified = false;
      if (existing) {
        custodyVerified = await this.verifyCustody(existing.id, input.expectedAppNpub);
      }
      return {
        dryRun: true,
        appId: input.appId,
        installationId: input.installation.installationId,
        appNpub: input.expectedAppNpub,
        towerBindingId: input.towerBindingId,
        assignment: existing ? "verified" : "create",
        custodyVerified,
        sourceSecretPresent: Boolean(source.nsec),
        sourceSecretRemoved: false,
        reviewReason: reasonPresent ? "clear" : "already-clear",
        remainingReviewReasons: (app.lifecycleReviewReasons ?? []).filter((reason) => reason !== WAPP_TOWER_BROKER_REVIEW_REASON),
        autoStart: requestedAutoStart,
      };
    }

    const assignment = existing ?? this.store.create(createInput(input, source.nsec!));
    assertExistingAssignment(assignment, input);
    await this.verifyCustody(assignment.id, input.expectedAppNpub);
    await atomicallyCleanLegacySource(source);

    let reviewed = app;
    if (reasonPresent) reviewed = await this.registry.reviewWappTowerBrokerMigration(input.appId);
    if (input.autoStart !== undefined && Boolean(reviewed.autoStart) !== input.autoStart) {
      reviewed = await this.registry.updateApp(input.appId, { autoStart: input.autoStart });
    }
    return {
      dryRun: false,
      appId: input.appId,
      installationId: assignment.id,
      appNpub: assignment.appNpub!,
      towerBindingId: assignment.towerBindingId!,
      assignment: existing ? "verified" : "create",
      custodyVerified: true,
      sourceSecretPresent: Boolean(source.nsec),
      sourceSecretRemoved: Boolean(source.nsec),
      reviewReason: reasonPresent ? "clear" : "already-clear",
      remainingReviewReasons: reviewed.lifecycleReviewReasons ?? [],
      autoStart: Boolean(reviewed.autoStart),
    };
  }

  private async verifyCustody(installationId: string, expectedAppNpub: string): Promise<boolean> {
    if (!this.store.hasAppSigningKey(installationId)) conflict("Encrypted WApp signing custody is unavailable");
    let derived: string;
    try {
      derived = await this.store.withAppSigningKey(
        installationId,
        (nsec) => deriveWappAppNpubFromNsec(nsec),
      );
    } catch {
      conflict("Encrypted WApp signing custody could not verify the expected public identity");
    }
    if (derived !== expectedAppNpub) conflict("Encrypted WApp signing custody has a conflicting public identity");
    return true;
  }
}

export const legacyWappCustodyMigration = new LegacyWappCustodyMigration();
