import type { AppLifecycleAction } from "./app-registry";

export class AppActionError extends Error {
  readonly appId: string;
  readonly action: AppLifecycleAction;

  constructor(appId: string, action: AppLifecycleAction, message: string, cause?: unknown) {
    super(message);
    this.name = "AppActionError";
    this.appId = appId;
    this.action = action;
    if (cause instanceof Error && cause.stack) {
      this.stack = `${this.stack}\nCaused by: ${cause.stack}`;
    }
  }
}

export class AppActionInProgressError extends AppActionError {
  constructor(appId: string, action: AppLifecycleAction) {
    super(appId, action, `Another action is already in progress for app ${appId}`);
    this.name = "AppActionInProgressError";
  }
}

export class AppScriptMissingError extends AppActionError {
  constructor(appId: string, action: AppLifecycleAction) {
    super(appId, action, `No script defined for ${action}`);
    this.name = "AppScriptMissingError";
  }
}
