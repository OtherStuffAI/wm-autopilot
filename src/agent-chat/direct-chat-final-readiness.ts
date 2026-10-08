import { isNativeFinalReady } from "../agents/native-sdk-contract";

export function isDirectChatFinalReady(input: {
  nativeCodexReady: boolean;
  agentTransport?: string;
  runtimeStatus: string | null;
}): boolean {
  // SDK snapshots include an in-flight assistant bubble. A captured native
  // session id does not turn that streaming bubble into a completed answer.
  return isNativeFinalReady({ ...input, nativeTranscriptReady: input.nativeCodexReady });
}
