import { readFileSync } from "node:fs";
import { scheduledSessionContextSchema, type ScheduledSessionContext } from "../../src/scheduler/session-context";
import { parseCommandOptions } from "./command-options";
type TriggerType = "cron" | "file_watcher";

export interface ParsedOptions {
  name?: string;
  agent?: string;
  model?: string;
  workingDirectory?: string;
  prompt?: string;
  actionType?: 'session' | 'pipeline';
  pipelineDefinitionId?: string | null;
  pipelineInput?: Record<string, unknown>;
  pipelineAgent?: string | null;
  triggerType?: TriggerType;
  cronExpression?: string;
  timezone?: string;
  watchDirectory?: string;
  filePattern?: string;
  activeStartTime?: string;
  activeEndTime?: string;
  enabled?: boolean;
  botNpub?: string;
  flightdeckContext?: ScheduledSessionContext | null;
  positional: string[];
}

function parseBooleanFlag(value: string | undefined, flagName: string): boolean {
  if (value === undefined) {
    throw new Error(`${flagName} requires a value: true or false`);
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new Error(`${flagName} must be true or false`);
}

function parseJsonObjectFlag(value: string, flagName: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${flagName} must be valid JSON`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${flagName} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function parseSchedulerOptions(args: string[]): ParsedOptions {
  const parsed: ParsedOptions = { positional: [] };

  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    switch (token) {
      case '--flightdeck-context-file': {
        const path = args[++i];
        if (!path) throw new Error('--flightdeck-context-file requires a path');
        const value = JSON.parse(readFileSync(path, 'utf8'));
        parsed.flightdeckContext = value === null ? null : scheduledSessionContextSchema.parse(value);
        break;
      }
      case '--name': {
        const value = args[++i];
        if (!value) throw new Error('--name requires a value');
        parsed.name = value;
        break;
      }
      case '--agent': {
        const value = args[++i];
        if (!value) throw new Error('--agent requires a value');
        parsed.agent = value;
        break;
      }
      case '--model': {
        const value = args[++i];
        if (!value) throw new Error('--model requires a value');
        parsed.model = value;
        break;
      }
      case '--bot-npub': {
        const value = args[++i];
        if (!value) throw new Error('--bot-npub requires a value');
        parsed.botNpub = value;
        break;
      }
      case '--working-directory':
      case '--directory': {
        const value = args[++i];
        if (!value) throw new Error(`${token} requires a value`);
        parsed.workingDirectory = value;
        break;
      }
      case '--prompt':
      case '--initial-prompt': {
        const value = args[++i];
        if (!value) throw new Error(`${token} requires a value`);
        parsed.prompt = value;
        break;
      }
      case '--prompt-file': {
        const value = args[++i];
        if (!value) throw new Error('--prompt-file requires a path');
        parsed.prompt = readFileSync(value, 'utf8');
        break;
      }
      case '--action-type': {
        const value = args[++i];
        if (!value) throw new Error('--action-type requires a value');
        if (value === 'session' || value === 'pipeline') {
          parsed.actionType = value;
        } else {
          throw new Error('--action-type must be session or pipeline');
        }
        break;
      }
      case '--pipeline-definition-id':
      case '--pipeline':
      case '--pipeline-id': {
        const value = args[++i];
        if (!value) throw new Error(`${token} requires a value`);
        parsed.pipelineDefinitionId = value;
        break;
      }
      case '--pipeline-input':
      case '--pipeline-input-json': {
        const value = args[++i];
        if (!value) throw new Error(`${token} requires a JSON object value`);
        parsed.pipelineInput = parseJsonObjectFlag(value, token);
        break;
      }
      case '--pipeline-agent': {
        const value = args[++i];
        if (!value) throw new Error('--pipeline-agent requires a value');
        parsed.pipelineAgent = value;
        break;
      }
      case '--trigger-type': {
        const value = args[++i];
        if (!value) throw new Error('--trigger-type requires a value');
        if (value === 'cron' || value === 'file_watcher') {
          parsed.triggerType = value;
        } else {
          throw new Error('--trigger-type must be cron or file_watcher; Nostr relay triggers are unsupported');
        }
        break;
      }
      case '--cron':
      case '--cron-expression': {
        const value = args[++i];
        if (!value) throw new Error(`${token} requires a value`);
        parsed.cronExpression = value;
        break;
      }
      case '--timezone': {
        const value = args[++i];
        if (!value) throw new Error('--timezone requires a value');
        parsed.timezone = value;
        break;
      }
      case '--watch-directory': {
        const value = args[++i];
        if (!value) throw new Error('--watch-directory requires a value');
        parsed.watchDirectory = value;
        break;
      }
      case '--file-pattern': {
        const value = args[++i];
        if (!value) throw new Error('--file-pattern requires a value');
        parsed.filePattern = value;
        break;
      }
      case '--active-start': {
        const value = args[++i];
        if (!value) throw new Error('--active-start requires a value (HH:MM)');
        parsed.activeStartTime = value;
        break;
      }
      case '--active-end': {
        const value = args[++i];
        if (!value) throw new Error('--active-end requires a value (HH:MM)');
        parsed.activeEndTime = value;
        break;
      }
      case '--enabled': {
        parsed.enabled = parseBooleanFlag(args[++i], '--enabled');
        break;
      }
      default:
        if (token.startsWith("-")) throw new Error(`Unknown scheduler option: ${token}`);
        parsed.positional.push(token);
    }
  }

  return parsed;
}

export function parseSchedulerCommand(args: string[]) {
  const knownOptions: Record<string, "value"> = {
    "--flightdeck-context-file": "value",
    "--name": "value",
    "--agent": "value",
    "--model": "value",
    "--bot-npub": "value",
    "--working-directory": "value",
    "--directory": "value",
    "--prompt": "value",
    "--initial-prompt": "value",
    "--prompt-file": "value",
    "--action-type": "value",
    "--pipeline-definition-id": "value",
    "--pipeline": "value",
    "--pipeline-id": "value",
    "--pipeline-input": "value",
    "--pipeline-input-json": "value",
    "--pipeline-agent": "value",
    "--trigger-type": "value",
    "--cron": "value",
    "--cron-expression": "value",
    "--timezone": "value",
    "--watch-directory": "value",
    "--file-pattern": "value",
    "--active-start": "value",
    "--active-end": "value",
    "--enabled": "value",
    "--owner": "value",
  };
  const checked = parseCommandOptions(args, knownOptions);
  const owner = checked.options["--owner"] as string | undefined;
  const ownerIndex = args.indexOf("--owner");
  if (ownerIndex >= 0) args.splice(ownerIndex, 2);
  const aliases: Record<string, string> = {
    "--directory": "--working-directory", "--initial-prompt": "--prompt", "--prompt-file": "--prompt",
    "--pipeline": "--pipeline-definition-id", "--pipeline-id": "--pipeline-definition-id",
    "--pipeline-input-json": "--pipeline-input", "--cron-expression": "--cron",
  };
  const seen = new Set<string>();
  for (const flag of Object.keys(checked.options)) {
    const canonical = aliases[flag] ?? flag;
    if (seen.has(canonical)) throw new Error(`Conflicting scheduler options for ${canonical}`);
    seen.add(canonical);
  }
  const options = parseSchedulerOptions(args);
  return { options, owner };

}
