export class RestartDrainGate {
  private operationId: string | null = null;

  enter(operationId: string): void {
    if (this.operationId && this.operationId !== operationId) {
      throw new Error("A controlled restart drain is already active");
    }
    this.operationId = operationId;
  }

  leave(operationId?: string): void {
    if (!operationId || this.operationId === operationId) this.operationId = null;
  }

  isDraining(): boolean {
    return this.operationId !== null;
  }

  assertSessionStartAllowed(): void {
    if (this.isDraining()) throw new Error("Controlled restart drain is active; new sessions are temporarily unavailable");
  }

  assertPromptExecutionAllowed(): void {
    if (this.isDraining()) throw new Error("Controlled restart drain is active; prompt execution is temporarily unavailable");
  }
}

export const restartDrainGate = new RestartDrainGate();
