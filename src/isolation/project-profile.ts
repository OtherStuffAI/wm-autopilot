export const PROJECT_PROFILE = Object.freeze({
  pids: 128,
  memoryBytes: 512 * 1024 * 1024,
  workspaceBytes: 64 * 1024 * 1024,
  stateBytes: 32 * 1024 * 1024,
  snapshotBytes: 16 * 1024 * 1024,
  maxFiles: 2048,
  outputBytes: 48 * 1024 * 1024,
  maxDurationMs: 120_000,
});

export interface ProjectFile {
  path: string;
  base64: string;
}

export interface ProjectExecution {
  project: ProjectFile[];
  continuity: ProjectFile[];
  command: string[];
  durationMs: number;
  providerModel?: string;
}

export function validateSnapshot(files: ProjectFile[]): void {
  if (!Array.isArray(files) || files.length > PROJECT_PROFILE.maxFiles) {
    throw new Error("Invalid or oversized isolation snapshot");
  }
  let bytes = 0;
  const paths = new Set<string>();
  for (const file of files) {
    if (!file || typeof file.path !== "string" || typeof file.base64 !== "string" ||
      !/^[A-Za-z0-9_. -]+(?:\/[A-Za-z0-9_. -]+)*$/.test(file.path) ||
      file.path.split("/").some((part) => part === "." || part === "..") ||
      paths.has(file.path) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.base64)) {
      throw new Error("Invalid isolation snapshot path or encoding");
    }
    paths.add(file.path);
    bytes += Buffer.byteLength(file.base64, "base64");
    if (bytes > PROJECT_PROFILE.snapshotBytes) throw new Error("Isolation snapshot byte limit exceeded");
  }
  for (const path of paths) {
    const parts = path.split("/");
    parts.pop();
    while (parts.length) {
      if (paths.has(parts.join("/"))) throw new Error("Isolation snapshot file/directory conflict");
      parts.pop();
    }
  }
}

export function validateExecution(input: ProjectExecution): void {
  if (input.providerModel !== undefined && !/^[A-Za-z0-9._-]{1,80}$/.test(input.providerModel)) {
    throw new Error("Invalid isolated model name");
  }
  validateSnapshot(input.project);
  validateSnapshot(input.continuity);
  if (!Array.isArray(input.command) || !input.command.length || input.command.length > 64 ||
    input.command.some((arg) => typeof arg !== "string" || arg.includes("\0") || arg.length > 32768) ||
    !Number.isInteger(input.durationMs) || input.durationMs < 1 || input.durationMs > PROJECT_PROFILE.maxDurationMs) {
    throw new Error("Invalid isolation command or deadline");
  }
}

export function containerArguments(name: string, image: string): string[] {
  if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error("Isolation requires an audited immutable local image ID");
  if (!/^wm-project-[a-f0-9-]+$/.test(name)) throw new Error("Invalid isolation container name");
  return ["create", "--name", name, "--pull=never", "--interactive", "--init",
    "--network=none", "--read-only", "--user=10001:10001", "--cap-drop=ALL",
    "--security-opt=no-new-privileges:true", `--pids-limit=${PROJECT_PROFILE.pids}`, "--cpus=1",
    `--memory=${PROJECT_PROFILE.memoryBytes}`, `--memory-swap=${PROJECT_PROFILE.memoryBytes}`,
    "--ulimit=nofile=256:256", "--ulimit=core=0:0", "--ulimit=fsize=16777216:16777216",
    "--log-driver=none", "--ipc=private", "--cgroupns=private",
    `--tmpfs=/workspace:rw,nosuid,nodev,size=${PROJECT_PROFILE.workspaceBytes},uid=10001,gid=10001,mode=0700`,
    `--tmpfs=/continuity:rw,nosuid,nodev,noexec,size=${PROJECT_PROFILE.stateBytes},uid=10001,gid=10001,mode=0700`,
    "--tmpfs=/tmp:rw,nosuid,nodev,size=16777216,uid=10001,gid=10001,mode=0700",
    "--workdir=/workspace", "--env=HOME=/continuity", "--env=CODEX_HOME=/continuity/.codex",
    "--entrypoint=/usr/local/bin/bun", image, "/opt/isolation/container-worker.ts"];
}
