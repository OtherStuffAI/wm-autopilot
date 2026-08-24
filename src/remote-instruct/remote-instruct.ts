import { hostname } from "node:os";
import { writeFile } from "node:fs/promises";

export interface RemoteInstructVariables {
  [key: string]: string;
}

export interface RenderRemoteInstructResult {
  content: string;
  variables: RemoteInstructVariables;
  missingVariables: string[];
}

export interface LoadRemoteInstructOptions {
  promptPath: string;
  variables: RemoteInstructVariables;
}

export interface RemoteInstructTemplate {
  template: string;
  promptPath: string;
}

export class RemoteInstructConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteInstructConfigError";
  }
}

const VARIABLE_PATTERN = /\$([A-Za-z_][A-Za-z0-9_]*)/g;
const hasOwn = Object.prototype.hasOwnProperty;

export function buildRemoteInstructVariables(input: {
  autopilotUrl: string;
  defaultWorkdir: string;
  agentTypes: string[];
  viewerNpub: string | null;
  authMethod: string | null;
  projectReference?: string | null;
}): RemoteInstructVariables {
  const sortedAgentTypes = [...input.agentTypes].sort((a, b) => a.localeCompare(b));
  return {
    hostname: hostname(),
    autopilot_url: input.autopilotUrl,
    project_reference: input.projectReference?.trim() || "autopilot",
    default_workdir: input.defaultWorkdir,
    agent_types: sortedAgentTypes.join(", "),
    viewer_npub: input.viewerNpub ?? "",
    auth_method: input.authMethod ?? "",
  };
}

export function renderRemoteInstructTemplate(
  template: string,
  variables: RemoteInstructVariables,
): RenderRemoteInstructResult {
  const missingVariables = new Set<string>();
  const content = template.replace(VARIABLE_PATTERN, (match, key: string) => {
    if (hasOwn.call(variables, key)) {
      return variables[key] ?? "";
    }
    missingVariables.add(key);
    return match;
  });

  return {
    content,
    variables,
    missingVariables: Array.from(missingVariables).sort(),
  };
}

export async function loadRemoteInstruct(
  options: LoadRemoteInstructOptions,
): Promise<RenderRemoteInstructResult> {
  const { template } = await readRemoteInstructTemplate(options.promptPath);
  return renderRemoteInstructTemplate(template, options.variables);
}

export async function readRemoteInstructTemplate(promptPath: string): Promise<RemoteInstructTemplate> {
  const file = Bun.file(promptPath);
  if (!(await file.exists())) {
    throw new RemoteInstructConfigError(
      `Remote Instruct prompt is not configured at ${promptPath}`,
    );
  }

  return {
    template: await file.text(),
    promptPath,
  };
}

export async function writeRemoteInstructTemplate(
  promptPath: string,
  template: string,
): Promise<RemoteInstructTemplate> {
  await writeFile(promptPath, template, "utf8");
  return {
    template,
    promptPath,
  };
}
