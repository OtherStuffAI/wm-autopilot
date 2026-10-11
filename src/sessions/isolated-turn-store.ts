import type { Database } from "bun:sqlite";
import type { ProjectFile } from "../isolation/project-profile.ts";
import type { CompletedTurnRequest } from "./completed-turn-contract.ts";

export interface IsolatedTurnState {
  executionId: string;
  owner: string;
  conversationKey: string;
  config: string;
  nativeReference: string | null;
  turns: number;
  pendingRequestId: string;
  prompt: string;
  projectJson: string;
  continuityJson: string;
  completedRequestId: string | null;
  reply: string | null;
}

/** Actual isolated runtime records. They are not Wingman process/session records. */
export class IsolatedTurnStore {
  constructor(private readonly db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS isolated_turn_state (
      executionId TEXT PRIMARY KEY, owner TEXT NOT NULL, conversationKey TEXT NOT NULL,
      config TEXT NOT NULL, nativeReference TEXT, turns INTEGER NOT NULL DEFAULT 0,
      pendingRequestId TEXT NOT NULL, prompt TEXT NOT NULL, projectJson TEXT NOT NULL,
      continuityJson TEXT NOT NULL, completedRequestId TEXT, reply TEXT,
      UNIQUE(owner,conversationKey));`);
  }
  get(id: string): IsolatedTurnState | null {
    return this.db.query("SELECT * FROM isolated_turn_state WHERE executionId=?").get(id) as IsolatedTurnState | null;
  }
  prepare(owner: string, request: CompletedTurnRequest, config: string, boundId: string | null): IsolatedTurnState {
    return this.db.transaction(() => {
      const existing = this.db.query("SELECT * FROM isolated_turn_state WHERE owner=? AND conversationKey=?")
        .get(owner, request.conversationKey) as IsolatedTurnState | null;
      if (boundId && existing?.executionId !== boundId) throw new Error("Isolated runtime binding missing or changed");
      if (existing && existing.config !== config) throw new Error("Isolated native runtime image/model binding changed");
      const id = existing?.executionId ?? crypto.randomUUID();
      if (!existing) {
        this.db.query(`INSERT INTO isolated_turn_state
          (executionId,owner,conversationKey,config,pendingRequestId,prompt,projectJson,continuityJson)
          VALUES (?,?,?,?,?,?,?,'[]')`).run(id, owner, request.conversationKey, config, request.requestId, request.prompt, JSON.stringify(request.projectFiles));
      } else if (existing.pendingRequestId !== request.requestId) {
        if (existing.pendingRequestId !== existing.completedRequestId) throw new Error("Previous isolated native request remains unresolved");
        this.db.query("UPDATE isolated_turn_state SET pendingRequestId=?,prompt=?,projectJson=? WHERE executionId=?")
          .run(request.requestId, request.prompt, JSON.stringify(request.projectFiles), id);
      }
      return this.get(id)!;
    }).immediate();
  }
  complete(state: IsolatedTurnState, result: { nativeReference: string; reply: string; project: ProjectFile[]; continuity: ProjectFile[] }): void {
    if (!result.reply.trim() || (state.nativeReference && result.nativeReference !== state.nativeReference)) throw new Error("Isolated native conversation continuity lost");
    const changed = this.db.query(`UPDATE isolated_turn_state SET nativeReference=?,reply=?,projectJson=?,continuityJson=?,
      turns=turns+1,completedRequestId=? WHERE executionId=? AND pendingRequestId=? AND turns=?`)
      .run(result.nativeReference, result.reply, JSON.stringify(result.project), JSON.stringify(result.continuity),
        state.pendingRequestId, state.executionId, state.pendingRequestId, state.turns);
    if (changed.changes !== 1) throw new Error("Isolated native completion binding changed");
  }
}
