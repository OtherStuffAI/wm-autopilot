import {test,expect} from "bun:test";
import {pipelineFunctionHashes,runtimeFunctionHash,assertPipelineFunctionPins} from "./pipeline-function-pins.ts";
import {completedTurnRegistration} from "./completed-turn-registration.ts";
import {scopedInterviewTurnRegistration,scopedInterviewTurnFunctionName} from "./scoped-interview-registration.ts";
import {executeCompletedTurnFunction} from "./completed-turn-function.ts";
import {CompletedTurnStore} from "../sessions/completed-turn-store.ts";
import {Database} from "bun:sqlite";

const definition=(name:string)=>({spec:{steps:[{name:"Native turn",type:"code",function:name}]}}) as any;
const registry={"session.completedTurn":completedTurnRegistration,[scopedInterviewTurnFunctionName]:scopedInterviewTurnRegistration};
test("existing completed-turn function/grant identity is unchanged; only additive profile pins source",()=>{
 expect((completedTurnRegistration as any)[runtimeFunctionHash]).toBeUndefined();
 expect(pipelineFunctionHashes(definition("session.completedTurn"),registry)).toEqual({});
 expect(()=>assertPipelineFunctionPins({},registry)).not.toThrow();
 const pins=pipelineFunctionHashes(definition(scopedInterviewTurnFunctionName),registry);
 expect(pins[scopedInterviewTurnFunctionName]).toMatch(/^[a-f0-9]{64}$/);
 expect(()=>assertPipelineFunctionPins(pins,{...registry,[scopedInterviewTurnFunctionName]:completedTurnRegistration})).toThrow("changed");
});
test("old Claude conversation config retains its exact prior serialized identity",()=>{
 const db=new Database(":memory:"),store=new CompletedTurnStore(db);
 store.enqueue("owner",{agent:"claude",conversationKey:"prior",requestId:"prior",projectId:"project",prompt:"hello",directory:"/private",model:null,sessionId:null,executionProfile:null,projectFiles:null,durationMs:null},"run","step");
 expect(store.binding("owner","prior")?.config).toBe(JSON.stringify({directory:"/private",model:null,projectId:"project",executionProfile:null}));db.close();
});
test("profile cannot use unpinned old function and additive function cannot run unrestricted sessions",async()=>{
 await expect(executeCompletedTurnFunction({request:{executionProfile:"scoped-interview"}} as any)).rejects.toThrow("dedicated pinned");
 await expect(executeCompletedTurnFunction({request:{},trustedExecutionProfile:"scoped-interview"} as any)).rejects.toThrow("dedicated pinned");
});
