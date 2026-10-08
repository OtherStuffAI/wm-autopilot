import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncLiveSessionMessages } from "../src/server/live-session-messages";
import { clearCodexSessionMessageCaches } from "../src/agents/codex-session-messages";

// Optional baseline module must export syncLiveSessionMessages from the old revision.
// All transcript/store/upstream state is disposable and never touches live sessions.
const baselineModule = process.env.SESSION_SYNC_BASELINE_MODULE;
const samples = Number(process.env.SESSION_NATIVE_SAMPLES ?? 5);
const upstreamDelay = Number(process.env.SESSION_NATIVE_UPSTREAM_MS ?? 3000);

describe("native authoritative session load", () => {
  test("avoids waiting for a terminal scrape and retains complete ordered native history", async () => {
    const root = await mkdtemp(join(tmpdir(), "session-load-native-"));
    const oldHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = root;
    try {
      await mkdir(join(root, "sessions"));
      const records = [{ type: "session_meta", payload: { id: "fixture-native", cwd: "/fixture" } }];
      for (let i=0;i<2000;i++) records.push({ type: "event_msg", timestamp: new Date(1700000000000+i*1000).toISOString(),
        payload: { type: i%2 ? "agent_message" : "user_message", phase: "final_answer", message: `native message ${i}` } } as any);
      await writeFile(join(root,"sessions","rollout-fixture-native.jsonl"),records.map(r=>JSON.stringify(r)).join('\n'));
      const sync = baselineModule ? (await import(baselineModule)).syncLiveSessionMessages : syncLiveSessionMessages;
      const timings: any[]=[];
      let fetchCount=0;
      for(let i=0;i<samples;i++) {
        clearCodexSessionMessageCaches();
        let stored: any[]=[];
        const session={id:"fixture",agent:"codex",status:"running",metadata:{agentTransport:"agentapi",
          nativeAgentSession:{agent:"codex",sessionId:"fixture-native",workingDirectory:"/fixture"}}};
        const result=await sync({sessionId:"fixture",force:true,agentHost:"127.0.0.1",
          manager:{getSession:()=>session,getAdapter:()=>({deliversPromptsDirectly:()=>false,
            fetchMessages:async()=>{fetchCount++;await Bun.sleep(upstreamDelay);return [];}})} as never,
          messageStore:{hasMessages:()=>false,listSessionMessages:()=>stored,
            replaceMessages:(_:string,rows:any[])=>{stored=rows;}} as never,
          onTiming:(timing:any)=>timings.push(timing)});
        expect(result).toHaveLength(2000);
        expect(result[0].content).toBe("native message 0");
        expect(result.at(-1).content).toBe("native message 1999");
      }
      const totals=timings.map(t=>t.totalMs).sort((a,b)=>a-b);
      console.log("SESSION_NATIVE_TIMINGS",JSON.stringify({samples,upstreamDelay,fetchCount,median:totals[Math.floor(totals.length/2)],p95:totals[Math.ceil(totals.length*.95)-1],timings}));
      if(!baselineModule) expect(fetchCount).toBe(0);
    } finally {
      if(oldHome===undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME=oldHome;
      await rm(root,{recursive:true,force:true});
      clearCodexSessionMessageCaches();
    }
  }, 60_000);
});
