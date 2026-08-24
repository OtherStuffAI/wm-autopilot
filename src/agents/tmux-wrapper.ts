import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export interface TmuxProcessConfig {
  sessionName: string;
  windowName: string;
  workingDirectory: string;
  command: string[];
  env: Record<string, string | undefined>;
  logFile: string;
}

export interface TmuxCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface TmuxLaunchResult {
  sessionName: string;
  windowName: string;
  target: string;
  logFile: string;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function readStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) {
    return '';
  }
  return await new Response(stream).text();
}

export async function runTmux(args: string[]): Promise<TmuxCommandResult> {
  const proc = Bun.spawn(['tmux', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    readStream(proc.stdout),
    readStream(proc.stderr),
    proc.exited,
  ]);
  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}

async function requireTmux(args: string[], action: string): Promise<TmuxCommandResult> {
  const result = await runTmux(args);
  if (result.exitCode !== 0) {
    const detail = result.stderr || result.stdout || `tmux ${args.join(' ')} failed`;
    throw new Error(`${action}: ${detail}`);
  }
  return result;
}

function commandToShell(config: TmuxProcessConfig): string {
  const envPairs = Object.entries(config.env)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([key, value]) => `${key}=${shellQuote(value)}`);
  const command = config.command.map(shellQuote).join(' ');
  return ['exec env', ...envPairs, command].join(' ');
}

export async function ensureTmuxSession(sessionName: string, workingDirectory: string): Promise<void> {
  const existing = await runTmux(['has-session', '-t', sessionName]);
  if (existing.exitCode === 0) {
    return;
  }

  await requireTmux(
    ['new-session', '-d', '-s', sessionName, '-c', workingDirectory],
    `failed to create tmux session ${sessionName}`,
  );
}

export async function hasTmuxWindow(sessionName: string, windowName: string): Promise<boolean> {
  const result = await runTmux(['has-session', '-t', `${sessionName}:${windowName}`]);
  return result.exitCode === 0;
}

export async function startTmuxProcess(config: TmuxProcessConfig): Promise<TmuxLaunchResult> {
  await mkdir(dirname(config.logFile), { recursive: true });
  await ensureTmuxSession(config.sessionName, config.workingDirectory);

  const target = `${config.sessionName}:${config.windowName}`;
  if (await hasTmuxWindow(config.sessionName, config.windowName)) {
    throw new Error(`tmux window already exists: ${target}`);
  }

  await requireTmux(
    [
      'new-window',
      '-t',
      config.sessionName,
      '-n',
      config.windowName,
      '-c',
      config.workingDirectory,
      commandToShell(config),
    ],
    `failed to create tmux window ${target}`,
  );
  await runTmux(['pipe-pane', '-t', target, '-o', `cat >> ${shellQuote(resolve(config.logFile))}`]);

  return {
    sessionName: config.sessionName,
    windowName: config.windowName,
    target,
    logFile: config.logFile,
  };
}

export async function stopTmuxWindow(sessionName: string, windowName: string): Promise<boolean> {
  const target = `${sessionName}:${windowName}`;
  const result = await runTmux(['kill-window', '-t', target]);
  return result.exitCode === 0;
}

export function buildTmuxLogFile(root: string, sessionId: string): string {
  return join(root, 'data', 'agent-tmux-logs', `${sessionId}.log`);
}
