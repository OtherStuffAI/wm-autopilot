import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { arch, platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const AGENTAPI_UPSTREAM = "https://github.com/coder/agentapi.git";
export const AGENTAPI_UPSTREAM_COMMIT = "9ff117e231822f670305254ef24f6389f75953f4";
export const AGENTAPI_PATCH_RELATIVE_PATH = "vendor/agentapi/loopback-listener.patch";

const GO_VERSION = "1.25.4";
const MINIMUM_GO_VERSION = [1, 24, 11] as const;
const GO_DOWNLOAD_BASE_URL = "https://go.dev/dl";

type SupportedGoArchive = {
  fileName: string;
  sha256: string;
};

const GO_ARCHIVES: Record<string, SupportedGoArchive> = {
  "darwin-arm64": {
    fileName: `go${GO_VERSION}.darwin-arm64.tar.gz`,
    sha256: "c1b04e74251fe1dfbc5382e73d0c6d96f49642d8aebb7ee10a7ecd4cae36ebd2",
  },
  "darwin-x64": {
    fileName: `go${GO_VERSION}.darwin-amd64.tar.gz`,
    sha256: "33ba03ff9973f5bd26d516eea35328832a9525ecc4d169b15937ffe2ce66a7d8",
  },
  "linux-arm64": {
    fileName: `go${GO_VERSION}.linux-arm64.tar.gz`,
    sha256: "a68e86d4b72c2c2fecf7dfed667680b6c2a071221bbdb6913cf83ce3f80d9ff0",
  },
  "linux-x64": {
    fileName: `go${GO_VERSION}.linux-amd64.tar.gz`,
    sha256: "9fa5ffeda4170de60f67f3aa0f824e426421ba724c21e133c1e35d6159ca1bec",
  },
};

export type AgentApiBuildOptions = {
  agentApiBinaryPath: string;
  projectRootDirectory: string;
};

export type AgentApiProvenance = {
  upstream: string;
  upstream_commit: string;
  patch: string;
  patch_sha256: string;
  sha256: string;
};

const digest = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");

const run = async (command: string[], cwd?: string): Promise<string> => {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed: ${stderr.trim() || stdout.trim()}`);
  }
  return stdout.trim();
};

export const isCompatibleGoVersion = (versionOutput: string): boolean => {
  const match = versionOutput.match(/\bgo(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return false;
  const candidate = [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
  for (let index = 0; index < MINIMUM_GO_VERSION.length; index += 1) {
    const candidatePart = candidate[index] ?? 0;
    const minimumPart = MINIMUM_GO_VERSION[index] ?? 0;
    if (candidatePart !== minimumPart) {
      return candidatePart > minimumPart;
    }
  }
  return true;
};

const findSystemGo = async (): Promise<string | null> => {
  const goPath = Bun.which("go");
  if (!goPath) return null;
  try {
    const version = await run([goPath, "version"]);
    return isCompatibleGoVersion(version) ? goPath : null;
  } catch {
    return null;
  }
};

const installPinnedGoToolchain = async (projectRootDirectory: string): Promise<string> => {
  const platformKey = `${platform()}-${arch()}`;
  const archive = GO_ARCHIVES[platformKey];
  if (!archive) {
    throw new Error(
      `[agentapi] Automatic Go setup does not support ${platformKey}. Install Go ${GO_VERSION} or newer and retry.`,
    );
  }

  const cacheRoot = join(projectRootDirectory, ".cache", "toolchains");
  const toolchainRoot = join(cacheRoot, `go${GO_VERSION}-${platformKey}`);
  const goBinaryPath = join(toolchainRoot, "bin", "go");
  if (await Bun.file(goBinaryPath).exists()) return goBinaryPath;

  await mkdir(cacheRoot, { recursive: true });
  await rm(toolchainRoot, { recursive: true, force: true });
  const temporaryRoot = await mkdtemp(join(cacheRoot, ".go-download-"));
  try {
    console.log(`[agentapi] Downloading pinned Go ${GO_VERSION} toolchain for ${platformKey}`);
    const response = await fetch(`${GO_DOWNLOAD_BASE_URL}/${archive.fileName}`);
    if (!response.ok) {
      throw new Error(`[agentapi] Go toolchain download failed with HTTP ${response.status}`);
    }
    const archiveBytes = new Uint8Array(await response.arrayBuffer());
    const actualDigest = digest(archiveBytes);
    if (actualDigest !== archive.sha256) {
      throw new Error(
        `[agentapi] Go toolchain checksum mismatch: expected ${archive.sha256}, received ${actualDigest}`,
      );
    }

    const archivePath = join(temporaryRoot, archive.fileName);
    const extractionRoot = join(temporaryRoot, "extracted");
    await Promise.all([
      writeFile(archivePath, archiveBytes, { mode: 0o600 }),
      mkdir(extractionRoot, { recursive: true }),
    ]);
    await run(["tar", "-xzf", archivePath, "-C", extractionRoot]);
    await rename(join(extractionRoot, "go"), toolchainRoot);
    await chmod(goBinaryPath, 0o755);
    return goBinaryPath;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
};

const resolveGoBinary = async (projectRootDirectory: string): Promise<string> => {
  const systemGo = await findSystemGo();
  if (systemGo) return systemGo;
  console.log(`[agentapi] Compatible Go not found; preparing a project-local Go ${GO_VERSION} toolchain`);
  return installPinnedGoToolchain(projectRootDirectory);
};

export const getAgentApiProvenancePath = (binaryPath: string): string =>
  `${binaryPath}.provenance.json`;

export const createAgentApiProvenance = async (
  binaryPath: string,
  projectRootDirectory: string,
): Promise<AgentApiProvenance> => {
  const patchPath = join(projectRootDirectory, AGENTAPI_PATCH_RELATIVE_PATH);
  const [binary, patch] = await Promise.all([readFile(binaryPath), readFile(patchPath)]);
  return {
    upstream: AGENTAPI_UPSTREAM,
    upstream_commit: AGENTAPI_UPSTREAM_COMMIT,
    patch: AGENTAPI_PATCH_RELATIVE_PATH,
    patch_sha256: digest(patch),
    sha256: digest(binary),
  };
};

export const verifyAgentApiLoopbackBuild = async ({
  agentApiBinaryPath,
  projectRootDirectory,
}: AgentApiBuildOptions): Promise<boolean> => {
  try {
    const [provenanceText, expected] = await Promise.all([
      readFile(getAgentApiProvenancePath(agentApiBinaryPath), "utf8"),
      createAgentApiProvenance(agentApiBinaryPath, projectRootDirectory),
    ]);
    const provenance = JSON.parse(provenanceText) as AgentApiProvenance;
    return Object.entries(expected).every(
      ([key, value]) => provenance[key as keyof AgentApiProvenance] === value,
    );
  } catch {
    return false;
  }
};

export const buildAgentApiLoopback = async ({
  agentApiBinaryPath,
  projectRootDirectory,
}: AgentApiBuildOptions): Promise<void> => {
  const patchPath = join(projectRootDirectory, AGENTAPI_PATCH_RELATIVE_PATH);
  const goBinary = await resolveGoBinary(projectRootDirectory);
  await mkdir(dirname(agentApiBinaryPath), { recursive: true });
  const temporaryRoot = await mkdtemp(join(tmpdir(), "wingman-agentapi-"));
  const outputRoot = await mkdtemp(join(dirname(agentApiBinaryPath), ".agentapi-build-"));
  const source = join(temporaryRoot, "source");
  const builtBinaryPath = join(outputRoot, "agentapi");
  const builtProvenancePath = getAgentApiProvenancePath(builtBinaryPath);
  try {
    console.log("[agentapi] Building verified loopback-only AgentAPI binary");
    await run(["git", "clone", "--quiet", AGENTAPI_UPSTREAM, source]);
    await run(["git", "checkout", "--quiet", AGENTAPI_UPSTREAM_COMMIT], source);
    const resolvedCommit = await run(["git", "rev-parse", "HEAD"], source);
    if (resolvedCommit !== AGENTAPI_UPSTREAM_COMMIT) {
      throw new Error(`[agentapi] Unexpected AgentAPI commit: ${resolvedCommit}`);
    }
    await run(["git", "apply", "--check", patchPath], source);
    await run(["git", "apply", patchPath], source);
    await run([goBinary, "build", "-trimpath", "-o", builtBinaryPath, "."], source);

    const provenance = await createAgentApiProvenance(builtBinaryPath, projectRootDirectory);
    await writeFile(
      builtProvenancePath,
      `${JSON.stringify(provenance, null, 2)}\n`,
      { mode: 0o644 },
    );
    await rename(builtBinaryPath, agentApiBinaryPath);
    await rename(builtProvenancePath, getAgentApiProvenancePath(agentApiBinaryPath));
    console.log(`[agentapi] Built loopback-only AgentAPI: ${provenance.sha256}`);
  } finally {
    await Promise.all([
      rm(temporaryRoot, { recursive: true, force: true }),
      rm(outputRoot, { recursive: true, force: true }),
    ]);
  }
};
