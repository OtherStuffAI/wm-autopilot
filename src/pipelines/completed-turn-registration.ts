import type { DeclarativeFunction } from "./declarative.ts";

/** Catalog entry; the runner supplies trusted owner, run, step and runtime context. */
export const completedTurnRegistration: DeclarativeFunction = () => {
  throw new Error("session.completedTurn requires the authenticated pipeline runner context");
};
