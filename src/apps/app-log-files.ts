import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const ONE_SHOT_LOG_ACTIONS = ["build", "setup"] as const;

interface ClearAppLogFilesInput {
  logsDir: string;
  appId: string;
  processName?: string | null;
}

function getOneShotLogNames(prefix: string): string[] {
  return ONE_SHOT_LOG_ACTIONS.map((action) => `${prefix}-${action}.log`);
}

async function truncateExistingLogFile(filePath: string): Promise<void> {
  try {
    await writeFile(filePath, "", "utf8");
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code !== "ENOENT") {
      throw error;
    }
  }
}

export async function clearAppLogFiles({
  logsDir,
  appId,
  processName,
}: ClearAppLogFilesInput): Promise<void> {
  const targetFiles = new Set<string>();

  if (processName) {
    targetFiles.add(`${processName}-out.log`);
    targetFiles.add(`${processName}-error.log`);
    for (const oneShotLogName of getOneShotLogNames(processName)) {
      targetFiles.add(oneShotLogName);
    }
  }

  for (const oneShotLogName of getOneShotLogNames(appId)) {
    targetFiles.add(oneShotLogName);
  }

  let directoryEntries: string[];
  try {
    directoryEntries = await readdir(logsDir);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return;
    }
    throw error;
  }

  const truncatePromises = directoryEntries
    .filter((entry) => targetFiles.has(entry))
    .map((entry) => truncateExistingLogFile(join(logsDir, entry)));

  await Promise.all(truncatePromises);
}
