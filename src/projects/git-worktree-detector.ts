import { basename, normalize } from "node:path";

export interface WorktreeInfo {
  isWorktree: boolean;
  worktreeName: string | null;
  mainProjectPath: string | null;
  mainProjectName: string | null;
  autoName: string;
}

async function runGitCommand(cwd: string, args: string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      return null;
    }
    const output = await new Response(proc.stdout).text();
    return output.trim();
  } catch {
    return null;
  }
}

export async function detectWorktree(directoryPath: string): Promise<WorktreeInfo> {
  const normalizedPath = normalize(directoryPath);
  const folderName = basename(normalizedPath);
  const defaultInfo: WorktreeInfo = {
    isWorktree: false,
    worktreeName: null,
    mainProjectPath: null,
    mainProjectName: null,
    autoName: folderName,
  };

  // Check if this is a git repository at all
  const gitDir = await runGitCommand(normalizedPath, ["rev-parse", "--git-dir"]);
  if (!gitDir) {
    return defaultInfo;
  }

  // Check if this is a worktree (not the main working tree)
  // In a worktree, .git is a file pointing to the main repo's worktrees/<name> directory
  const commonDir = await runGitCommand(normalizedPath, ["rev-parse", "--git-common-dir"]);
  const topLevel = await runGitCommand(normalizedPath, ["rev-parse", "--show-toplevel"]);

  if (!commonDir || !topLevel) {
    return defaultInfo;
  }

  // If git-common-dir differs from git-dir, this is a worktree
  const isWorktree = gitDir !== commonDir && gitDir !== ".git";

  if (!isWorktree) {
    // This is the main working directory, not a worktree
    return defaultInfo;
  }

  // This is a worktree - extract the worktree name
  // The worktree name is typically the branch name or the last directory component
  const branchName = await runGitCommand(normalizedPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const worktreeName = branchName ?? folderName;

  // Get the main project path from common-dir
  // common-dir points to the .git folder of the main repo
  // So the main project is the parent of that
  const mainGitDir = normalize(commonDir);
  const mainProjectPath = mainGitDir.endsWith(".git")
    ? normalize(mainGitDir.slice(0, -5))
    : mainGitDir.replace(/\/\.git\/worktrees\/.*$/, "");

  const mainProjectName = basename(mainProjectPath);

  // Generate the auto name in format: "{main project} - {worktree name}"
  const autoName = `${mainProjectName} - ${worktreeName}`;

  return {
    isWorktree: true,
    worktreeName,
    mainProjectPath,
    mainProjectName,
    autoName,
  };
}
