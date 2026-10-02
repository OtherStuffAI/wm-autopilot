import type { JsonObject } from "./pipeline-store";

export function buildAgentPrompt(input: {
  prompt: string;
  selectedInput: JsonObject;
  callbackUrl: string;
  callbackToken: string;
  runId: string;
  stepId: string;
}): string {
  return `You are running one step in a Wingmen pipeline.

Step instruction:
${input.prompt}

Selected input:
${JSON.stringify(input.selectedInput, null, 2)}

Completion contract:
- You are not complete until the webhook returns HTTP 200.
- POST exactly one JSON object to:
  ${input.callbackUrl}
- Header: x-wingmen-pipeline-token: ${input.callbackToken}
- Body:
  {
    "runId": "${input.runId}",
    "stepId": "${input.stepId}",
    "status": "ok",
    "result": {}
  }
- status must be "ok", "needs_input", or "error"; result must be a JSON object.
- Use "error" only when the step itself cannot be completed. For transport/auth/probe failures, fix the request and retry until HTTP 200.
- If selected input includes documentUrl and the step asks for document edits, use that reference directly.
- Do not include full document text in result; return concise summary fields, changed sections/lines, comment IDs, and status metadata only.`;
}
