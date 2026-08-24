import {
  AcpProcessClient,
  type AcpEvent,
  type AcpProcessClientOptions,
  type AcpRequest,
  type AcpResponse,
} from "./acp-process-client";

export type GooseAcpEvent = AcpEvent;
export type GooseAcpRequest = AcpRequest;
export type GooseAcpResponse = AcpResponse;

export interface GooseAcpClientOptions {
  cliPath: string;
  workingDirectory: string;
  env: Record<string, string>;
}

/** Compatibility wrapper for existing Goose tests and imports. */
export class GooseAcpClient extends AcpProcessClient {
  constructor(options: GooseAcpClientOptions) {
    const processOptions: AcpProcessClientOptions = {
      command: options.cliPath,
      args: ["acp"],
      workingDirectory: options.workingDirectory,
      env: options.env,
      label: "Goose ACP",
    };
    super(processOptions);
  }
}
