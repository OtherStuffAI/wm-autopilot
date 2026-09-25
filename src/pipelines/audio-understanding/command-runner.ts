import { access } from "node:fs/promises";
import { delimiter, isAbsolute } from "node:path";
import type { AudioCommandResult, AudioCommandRunner } from "./types";

export const bunAudioCommandRunner: AudioCommandRunner = async (command, args) => {
  const child = Bun.spawn([command, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

export async function resolveExecutable(command: string, pathValue = process.env.PATH ?? ""): Promise<string | null> {
  if (!command.trim() || command.includes("\0")) return null;
  if (isAbsolute(command)) return await isExecutable(command) ? command : null;
  if (command.includes("/") || command.includes("\\")) return null;
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    const candidate = `${directory}/${command}`;
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}
export async function runChecked(
  runner: AudioCommandRunner,
  command: string,
  args: string[],
  label: string,
): Promise<AudioCommandResult> {
  const result = await runner(command, args);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim().slice(0, 1000);
    throw new Error(`${label} failed with exit code ${result.exitCode}${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, 1);
    return true;
  } catch {
    return false;
  }
}
