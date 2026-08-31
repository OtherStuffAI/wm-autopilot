import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AGENTAPI_PATCH_RELATIVE_PATH,
  createAgentApiProvenance,
  getAgentApiProvenancePath,
  isCompatibleGoVersion,
  verifyAgentApiLoopbackBuild,
  type AgentApiBuildOptions,
} from "./agentapi-build";
import { ensureAgentApiBinary } from "./agentapi";

const temporaryDirectories: string[] = [];

const createBuildFixture = async (): Promise<AgentApiBuildOptions> => {
  const projectRootDirectory = await mkdtemp(join(tmpdir(), "wingman-agentapi-test-"));
  temporaryDirectories.push(projectRootDirectory);
  const agentApiBinaryPath = join(projectRootDirectory, "out", "agentapi");
  await mkdir(join(projectRootDirectory, "vendor", "agentapi"), { recursive: true });
  await writeFile(join(projectRootDirectory, AGENTAPI_PATCH_RELATIVE_PATH), "loopback patch\n");
  return { agentApiBinaryPath, projectRootDirectory };
};

const writeVerifiedBuild = async (
  options: AgentApiBuildOptions,
  binary = "agentapi",
): Promise<void> => {
  await mkdir(join(options.projectRootDirectory, "out"), { recursive: true });
  await writeFile(options.agentApiBinaryPath, binary, { mode: 0o755 });
  const provenance = await createAgentApiProvenance(
    options.agentApiBinaryPath,
    options.projectRootDirectory,
  );
  await writeFile(getAgentApiProvenancePath(options.agentApiBinaryPath), JSON.stringify(provenance));
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(
    (directory) => rm(directory, { recursive: true, force: true }),
  ));
});

describe("AgentAPI loopback bootstrap", () => {
  test("accepts the minimum compatible Go version and newer releases", () => {
    expect(isCompatibleGoVersion("go version go1.24.11 linux/amd64")).toBe(true);
    expect(isCompatibleGoVersion("go version go1.25.0 linux/amd64")).toBe(true);
    expect(isCompatibleGoVersion("go version go1.24.10 linux/amd64")).toBe(false);
    expect(isCompatibleGoVersion("unexpected output")).toBe(false);
  });

  test("accepts a binary whose binary and patch hashes match provenance", async () => {
    const options = await createBuildFixture();
    await writeVerifiedBuild(options);

    expect(await verifyAgentApiLoopbackBuild(options)).toBe(true);
  });

  test("rejects provenance after the reviewed patch changes", async () => {
    const options = await createBuildFixture();
    await writeVerifiedBuild(options);
    await writeFile(
      join(options.projectRootDirectory, AGENTAPI_PATCH_RELATIVE_PATH),
      "changed patch\n",
    );

    expect(await verifyAgentApiLoopbackBuild(options)).toBe(false);
  });

  test("builds a missing binary automatically and verifies the result", async () => {
    const options = await createBuildFixture();
    let buildCalls = 0;

    await ensureAgentApiBinary({
      ...options,
      buildBinary: async (buildOptions) => {
        buildCalls += 1;
        await writeVerifiedBuild(buildOptions);
      },
    });

    expect(buildCalls).toBe(1);
    expect(await verifyAgentApiLoopbackBuild(options)).toBe(true);
  });

  test("does not rebuild an already verified binary", async () => {
    const options = await createBuildFixture();
    await writeVerifiedBuild(options);
    let buildCalls = 0;

    await ensureAgentApiBinary({
      ...options,
      buildBinary: async () => {
        buildCalls += 1;
      },
    });

    expect(buildCalls).toBe(0);
  });
});
