import type { Database } from "bun:sqlite";
/** Called only by the authorized dedicated completed-turn runtime. Claimed
 * deliveries never change state, and pending content remains durable evidence. */
export function supersedeDedicatedPending(db:Database,sessionId:string,bindingId:string):number {
  if(!sessionId || !bindingId)throw new Error("Dedicated queue binding required");
  return db.transaction(()=>{
    if(db.query("SELECT id FROM prompt_queue WHERE session_id=? AND state='claimed'").get(sessionId)) {
      throw new Error("Completed-turn session has unresolved ordinary delivery");
    }
    const at=new Date().toISOString();
    db.query(`INSERT INTO prompt_queue_recovery(session_id,item_id,revision,actor,reason,resolution,created_at)
      SELECT session_id,id,CAST(revision AS TEXT),?,?,'superseded',? FROM prompt_queue WHERE session_id=? AND state='pending'`)
      .run(bindingId,"Latest managed workshop instruction supersedes unsent ordinary prompt",at,sessionId);
    return db.query("UPDATE prompt_queue SET state='superseded',revision=revision+1 WHERE session_id=? AND state='pending'").run(sessionId).changes;
  }).immediate();
}
