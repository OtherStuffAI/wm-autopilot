import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { lookup } from "node:dns/promises";
import { parseCompletedTurnRequest } from "../../sessions/completed-turn-contract.ts";
import { CompletedTurnStore } from "../../sessions/completed-turn-store.ts";
import { normaliseSessionMetadata } from "../../sessions/session-metadata.ts";
import { InterviewTools, interviewCanUseTool, verifyInterviewInit, INTERVIEW_TOOLS } from "./tools.ts";
import { publicDestination, publicSourceUrl } from "./public-fetch.ts";
import { validateImage } from "./image.ts";
import { parseInterviewInput } from "./contract.ts";
import { assertInterviewLaunch, assertInterviewMetadataUpdate } from "./launch.ts";
import { validateInterviewReply } from "./reply.ts";
import { redactPipelineValue } from "../../pipelines/pipeline-evidence-redaction.ts";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6l8AAAAASUVORK5CYII=";
const image = {id:"image",mimeType:"image/png",base64:png};
const request = (extra = {}) => parseCompletedTurnRequest({agent:"claude",executionProfile:"scoped-interview",conversationKey:"new-generation",requestId:"one",projectId:"design",prompt:"exact prompt",scopedInterview:{sources:[],attachments:[image]},...extra},"owner");
const init = (cwd: string) => ({type:"system",subtype:"init",cwd,tools:INTERVIEW_TOOLS,mcp_servers:[{name:"scoped_interview",source:"sdk",status:"connected"}],permissionMode:"default",plugins:[],skills:[]}) as any;

test("profile contract selects private directory and refuses arbitrary host authority", () => {
  const r = request();
  expect(r.directory).toContain("/.wingmen/runtime/scoped-interviews/");
  expect(r.durationMs).toBe(90000);
  for (const override of [{agent:"codex"},{directory:"/tmp/participant"},{sessionId:"old-host-session"},{durationMs:90001},{scopedInterview:{sources:[],provider:"foreign"}}]) expect(() => request(override)).toThrow();
  expect(() => parseCompletedTurnRequest({...r,directory:undefined},undefined)).toThrow();
  const metadata = normaliseSessionMetadata({executionProfile:"scoped-interview",agentTransport:"claude-sdk",role:"completed-turn",bindingId:r.directory.split("/").at(-1)});
  expect(() => assertInterviewLaunch("claude",r.directory,metadata)).not.toThrow();
  expect(() => assertInterviewLaunch("claude","/tmp",metadata)).toThrow();
  expect(() => assertInterviewMetadataUpdate(metadata,{executionProfile:undefined})).toThrow("immutable");
  expect(() => assertInterviewMetadataUpdate(normaliseSessionMetadata({}),{executionProfile:"scoped-interview"})).toThrow("immutable");
});

test("conversation/request identity cannot widen, migrate or change pinned bytes", () => {
  const db = new Database(":memory:"),store = new CompletedTurnStore(db),r=request();
  store.enqueue("owner",r,"run","step");
  expect(() => store.enqueue("owner",{...r,executionProfile:null},"run","step")).toThrow("binding conflict");
  expect(() => store.enqueue("owner",{...r,scopedInterview:{sources:[],attachments:[]}},"run","step")).toThrow("idempotency conflict");
  expect(() => store.enqueue("owner",{...r,agent:"codex"},"run","step")).toThrow("binding conflict");
  db.close();
});

test("all non-reviewed tools and configured MCP impostors are denied", async () => {
  for (const name of ["Bash","Read","Write","WebFetch","Task","mcp__wingman__session","mcp__foreign__public_web_read",...INTERVIEW_TOOLS]) {
    expect((await interviewCanUseTool(name,{}, {signal:AbortSignal.timeout(1000),mcpServer:{name:"scoped_interview",source:"dynamic"}}))?.behavior).toBe("deny");
  }
  for (const name of INTERVIEW_TOOLS) expect((await interviewCanUseTool(name,{sourceId:"approved"},{signal:AbortSignal.timeout(1000),mcpServer:{name:"scoped_interview",source:"sdk"}}))?.behavior).toBe("allow");
  expect((await interviewCanUseTool(INTERVIEW_TOOLS[0]!,{}, {signal:AbortSignal.timeout(1000)}))?.behavior).toBe("deny");
  expect(() => verifyInterviewInit(init("/private"),"/private")).not.toThrow();
  for (const change of [{tools:[...INTERVIEW_TOOLS,"Bash"]},{mcp_servers:[{name:"scoped_interview",source:"dynamic",status:"connected"}]},{plugins:[{name:"foreign"}]},{skills:["foreign"]},{permissionMode:"bypassPermissions"},{cwd:"/foreign"}]) expect(() => verifyInterviewInit({...init("/private"),...change},"/private")).toThrow("configuration mismatch");
});

test("public destinations reject mixed DNS, private/mapped/transition IPs and control planes", async () => {
  for (const url of ["http://example.com","https://user:password@example.com","https://example.com:444","https://tower.otherstuff.studio","https://rick.runwingman.com","https://rick.runwingman.com.","https://example.com/#x"]) expect(() => publicSourceUrl(url)).toThrow();
  for (const address of ["127.0.0.1","10.0.0.1","169.254.169.254","::ffff:8.8.8.8","2002:0808:0808::","fc00::1","::1"]) {
    const resolve = (async () => [{address:"8.8.8.8",family:4},{address,family:address.includes(":")?6:4}]) as unknown as typeof lookup;
    await expect(publicDestination("https://example.com",resolve)).rejects.toThrow("only public");
  }
});

test("native image content requires valid bytes and exact ID; two-read budget resets each turn", async () => {
  const tools = new InterviewTools();tools.configure({sources:[],attachments:[image]});tools.begin(AbortSignal.timeout(1000));
  await expect(tools.read("image",undefined,"image")).rejects.toThrow("init not verified");
  tools.confirmInit();
  const result = await tools.read("image",undefined,"image");
  expect(result.content[1]).toMatchObject({type:"image",mimeType:"image/png",data:png});
  await expect(tools.read("image","https://invented.example")).rejects.toThrow("Unknown");
  await expect(tools.read("image",undefined,"image")).rejects.toThrow("limit");
  tools.end(); tools.configure({sources:[],attachments:[image]});tools.begin(AbortSignal.timeout(1000));tools.confirmInit();
  expect((await tools.read("image",undefined,"image")).content[1]?.type).toBe("image");
  expect(tools.receipts).toHaveLength(1);
  tools.end(); await expect(tools.read("image",undefined,"image")).rejects.toThrow();
});

test("image ingress rejects mismatched MIME, excessive dimensions, SVG and wrong digest", () => {
  const bytes=Buffer.from(png,"base64");
  expect(validateImage(bytes,"image/png")).toMatchObject({width:1,height:1});
  expect(() => validateImage(bytes,"image/jpeg")).toThrow();
  const huge=Buffer.from(bytes);huge.writeUInt32BE(9000,16);expect(() => validateImage(huge,"image/png")).toThrow();
  expect(() => validateImage(Buffer.from("<svg/>"),"image/svg+xml")).toThrow();
  expect(() => parseInterviewInput({attachments:[{...image,sha256:"incorrect"}]})).toThrow("digest");
  expect(() => parseInterviewInput({attachments:[{...image,base64:"garbage?"}]})).toThrow();
});

test("ticket credentials and echoes are redacted before evidence capture", () => {
  const secret="synthetic-private-ticket";
  expect(JSON.stringify(redactPipelineValue({scopedInterview:{attachmentSource:{ticket:secret}},echo:secret}).value)).not.toContain(secret);
  expect(() => parseInterviewInput({attachmentSource:{url:"https://example.com/foreign",ticket:"a".repeat(43),jobId:"00000000-0000-0000-0000-000000000000",expiresAt:Date.now()+10000}})).toThrow("path");
});

test("completed text is preserved without interpreting JSON, prose or action-looking output", () => {
  for (const reply of ["A useful plain reply.", '{"response":"A useful answer"}', '{"action":"public_web_read"}', 'prefix {"title":"t","document":"d","response":"r"}', '```json\n{"title":"t","document":"d","response":"r"}\n```']) {
    expect(validateInterviewReply(reply)).toBe(reply);
  }
  for (const reply of ["", " \n", "x".repeat(180001), "界".repeat(60001)]) {
    expect(() => validateInterviewReply(reply)).toThrow();
  }
  expect(validateInterviewReply("界".repeat(60000))).toHaveLength(60000);
});
