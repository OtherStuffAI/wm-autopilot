# Session restart recovery

Controlled restart persistence is based on durable work, not advisory session
metadata. In particular, `nextAction: reflect` does not by itself prove that an
automatically-started session still has work to perform.

A live session is included in a warm-restart marker when at least one of these
conditions applies:

- its agent turn or prompt delivery is active;
- its ordinary prompt queue contains pending or claimed work, including an
  uncertain delivery whose response may have been lost;
- it owns a nonterminal Agent Direct turn;
- it owns an active supervised worker or a callback that still needs review or
  closeout;
- it belongs to a scheduled job; or
- it is user-created and therefore expected to persist while idle.

An automatically-started session with none of those conditions is settled. A
controlled restart stops it cleanly but does not put it in the recovery marker,
so warm bootstrap cannot create another native-resume or fresh replacement.
Stopping instead of deleting preserves its durable transcript and lifecycle
evidence.

If the supervisor rejects the restart launch, or a different session cannot be
stopped, rollback recreates only recovery-eligible sessions that were already
stopped. Settled automatic sessions remain stopped, while restored eligible
sessions retain their prompt-queue and supervised-dispatch bindings.

Agent Direct idle retirement remains a separate safeguard. Idle intercepts
reschedule their retention timer on startup, but restart eligibility does not
depend on intercept state being internally consistent: durable turn, queue, and
supervision records are the work authority.

The restart coordinator records its classification for every session. When
diagnosing an unexpected recovery, inspect the controlled-restart operation and
the durable store corresponding to the recorded reason before changing state.
