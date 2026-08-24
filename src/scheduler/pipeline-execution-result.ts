interface PipelineExecutionResult {
  id: string;
  status: string;
  error?: string | null;
}

export function requireSuccessfulPipelineExecution(run: PipelineExecutionResult): string {
  if (run.status === "ok") return run.id;

  const detail = run.error?.trim() || `Pipeline finished with status ${run.status}`;
  throw new Error(`Pipeline run ${run.id} failed: ${detail}`);
}
