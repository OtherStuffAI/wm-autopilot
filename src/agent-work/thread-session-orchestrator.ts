export interface ThreadSessionRouteState {
  threadId?: string;
  sessionId?: string;
  bindingVerified?: boolean;
  reviewMessageId?: string;
}

export interface ThreadSessionRouteResult {
  threadId: string;
  sessionId: string;
  bindingVerified: true;
  reviewMessageId: string;
  created: {
    thread: boolean;
    session: boolean;
    reviewMessage: boolean;
  };
}

export interface ThreadSessionOrchestratorDeps {
  createThread: () => Promise<{ threadId: string }>;
  createSession: (threadId: string) => Promise<{ sessionId: string }>;
  bindSession: (sessionId: string, threadId: string) => Promise<void>;
  readBinding: (sessionId: string) => Promise<{ bindingType?: string | null; bindingId?: string | null }>;
  postReviewMessage: (threadId: string, sessionId: string) => Promise<{ messageId: string }>;
  compensateSession?: (sessionId: string, reason: string) => Promise<void>;
}

function requiredId(value: string | undefined, label: string): string {
  const id = value?.trim();
  if (!id) throw new Error(`${label} did not return an identifier.`);
  return id;
}

export async function ensureThreadSessionRoute(
  state: ThreadSessionRouteState,
  deps: ThreadSessionOrchestratorDeps,
): Promise<ThreadSessionRouteResult> {
  let threadId = state.threadId?.trim() || "";
  let sessionId = state.sessionId?.trim() || "";
  let createdThread = false;
  let createdSession = false;

  if (!threadId) {
    threadId = requiredId((await deps.createThread()).threadId, "Thread creation");
    createdThread = true;
  }
  if (!sessionId) {
    sessionId = requiredId((await deps.createSession(threadId)).sessionId, "Session creation");
    createdSession = true;
  }

  try {
    if (!state.bindingVerified) await deps.bindSession(sessionId, threadId);
    const binding = await deps.readBinding(sessionId);
    if (binding.bindingType !== "thread" || binding.bindingId !== threadId) {
      throw new Error(`Session ${sessionId} binding verification failed for thread ${threadId}.`);
    }
  } catch (error) {
    if (createdSession && deps.compensateSession) {
      await deps.compensateSession(sessionId, "thread_binding_failed").catch(() => undefined);
    }
    throw error;
  }

  let reviewMessageId = state.reviewMessageId?.trim() || "";
  let createdReviewMessage = false;
  if (!reviewMessageId) {
    reviewMessageId = requiredId(
      (await deps.postReviewMessage(threadId, sessionId)).messageId,
      "Review message creation",
    );
    createdReviewMessage = true;
  }

  return {
    threadId,
    sessionId,
    bindingVerified: true,
    reviewMessageId,
    created: {
      thread: createdThread,
      session: createdSession,
      reviewMessage: createdReviewMessage,
    },
  };
}
