export function canResumeNativeAgentSession(session) {
  const nativeSession = session?.metadata?.nativeAgentSession;
  return Boolean(
    nativeSession &&
    typeof nativeSession.sessionId === "string" &&
    nativeSession.sessionId.trim().length > 0 &&
    typeof nativeSession.workingDirectory === "string" &&
    nativeSession.workingDirectory.trim().length > 0,
  );
}
