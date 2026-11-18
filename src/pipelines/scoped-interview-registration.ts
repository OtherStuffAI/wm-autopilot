import { interviewSourceHash } from "../agents/scoped-interview/source-pins.ts";
import { runtimeFunctionHash } from "./pipeline-function-pins.ts";
import type { DeclarativeFunction } from "./declarative.ts";

export const scopedInterviewTurnFunctionName = "session.scopedInterviewTurn.v1";
/** Additive pinned entry; ordinary completed-turn grant identities remain unchanged. */
export const scopedInterviewTurnRegistration: DeclarativeFunction = () => {
  throw Error("Scoped interview requires authenticated native runner context");
};
Object.defineProperty(scopedInterviewTurnRegistration,runtimeFunctionHash,{value:interviewSourceHash()});
export function isNativeCompletedTurnFunction(name: string): boolean {
  return name === "session.completedTurn" || name === scopedInterviewTurnFunctionName;
}
