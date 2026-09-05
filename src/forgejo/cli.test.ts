import { expect, test } from "bun:test";
import { runForgejoCli } from "./cli";

function fixture(status = 200) {
  const calls: Array<{url:string;body:any;authorization:string|null}> = [];
  const fetchImpl = (async (input: RequestInfo|URL, init?:RequestInit) => {
    const request=new Request(input,init);const raw=await request.text();calls.push({url:request.url,body:raw?JSON.parse(raw):null,authorization:request.headers.get('authorization')});
    if(request.url.startsWith('http://127.0.0.1:3600/'))return Response.json({username:'agent',password:'native-secret',expiresAt:'2030-01-01T00:00:00Z'});
    return status === 200 ? Response.json({number:8,title:'Native issue'}) : Response.json({message:'denied native-secret'},{status});
  }) as typeof fetch;
  return {calls,io:{fetchImpl,capabilityContext:{wingmanUrl:'http://127.0.0.1:3600',sessionId:'session',capabilityToken:'scoped',fetch:fetchImpl}}};
}
test('issues call native Forgejo with brokered OAuth and owner/repository',async()=>{
  const f=fixture();const result=await runForgejoCli(['issues','create','--repo','org/repo','--forgejo-url','https://forgejo.test','--title','Native issue','--body','body'],f.io);
  expect(result.exitCode).toBe(0);expect(f.calls[0]!.url).toEndWith('/api/mcp/capabilities/git-credential');expect(f.calls[0]!.body).toMatchObject({host:'forgejo.test',path:'org/repo.git'});
  expect(f.calls[1]).toMatchObject({url:'https://forgejo.test/api/v1/repos/org/repo/issues',authorization:'Bearer native-secret',body:{title:'Native issue',body:'body'}});
  expect(result.stdout).not.toContain('native-secret');
});
test('PR creation uses stock API',async()=>{
  const f=fixture();const result=await runForgejoCli(['pulls','create','--repo','org/repo','--forgejo-url','https://forgejo.test','--title','Change','--head','feature','--base','main'],f.io);
  expect(result.exitCode).toBe(0);expect(f.calls[1]!.url).toEndWith('/pulls');expect(f.calls[1]!.body).toMatchObject({head:'feature',base:'main'});
});
for(const status of [403,404])test(`permission ${status} never retries`,async()=>{
  const f=fixture(status);const result=await runForgejoCli(['issues','list','--repo','org/repo','--forgejo-url','https://forgejo.test'],f.io);
  expect(result.exitCode).toBe(1);expect(f.calls).toHaveLength(2);expect(result.stderr).not.toContain('native-secret');
});
test('401 retries once through broker and is bounded',async()=>{
  const f=fixture(401);const result=await runForgejoCli(['issues','list','--repo','org/repo','--forgejo-url','https://forgejo.test'],f.io);
  expect(result.exitCode).toBe(1);expect(f.calls).toHaveLength(4);
});
test('retired Tower bootstrap cannot fall back and private credentials are rejected',async()=>{
  expect((await runForgejoCli(['bootstrap','request'],{env:{}})).stderr).toContain('retired');
  expect((await runForgejoCli(['issues','list','--key','secret'],{env:{}})).stderr).toContain('not supported');
});
