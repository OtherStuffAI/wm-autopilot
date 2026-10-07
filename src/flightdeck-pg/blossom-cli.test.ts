import { afterEach, expect, test } from 'bun:test';
import { runFlightDeckPgCli } from './cli';
const saved={...Bun.env};
afterEach(()=>{for(const name of Object.keys(Bun.env))if(!(name in saved))delete Bun.env[name];Object.assign(Bun.env,saved);});
function args(command: string, extra: string[]=[]){return ['file',command,'file-id','--workspace','workspace-id','--tower-url','http://tower.test','--app-npub','npub1app','--key','1'.repeat(64),'--json',...extra];}
test('publication CLI selects explicit version, exact methods and signs through existing NIP-98 path',async()=>{
  delete Bun.env.SESSION_ID;delete Bun.env.WINGMAN_CAPABILITY;
  const requests:Request[]=[];
  const fetchImpl=async(input:any,init:any)=>{requests.push(new Request(input,init));return Response.json({changed:true,versions:[]});};
  for(const [command,extra] of [['blossom',[]],['publish',['--version','version-id','--public']],['unpublish',['--version','version-id']]] as [string,string[]][]){
    const result=await runFlightDeckPgCli(args(command,extra),{fetchImpl:fetchImpl as typeof fetch});expect(result.exitCode).toBe(0);
  }
  expect(requests.map(r=>r.method)).toEqual(['GET','PUT','DELETE']);
  expect(new URL(requests[0].url).pathname).toBe('/api/v4/flightdeck-pg/workspaces/workspace-id/files/file-id/blossom');
  expect(new URL(requests[1].url).pathname).toBe('/api/v4/flightdeck-pg/workspaces/workspace-id/files/file-id/versions/version-id/blossom');
  for(const request of requests){const auth=JSON.parse(Buffer.from(request.headers.get('authorization')!.slice(6),'base64').toString());expect(auth.kind).toBe(27235);expect(auth.tags).toContainEqual(['u',request.url]);expect(auth.tags).toContainEqual(['method',request.method]);}
});
test('publication CLI requires public consequence acknowledgement and an explicit version; failures are preserved',async()=>{
  delete Bun.env.SESSION_ID;delete Bun.env.WINGMAN_CAPABILITY;
  let calls=0;
  const fetchImpl=async()=>{calls++;return Response.json({code:'storage_incomplete',message:'File upload is not complete'},{status:409});};
  for(const extra of [[],['--public']]){
    const result=await runFlightDeckPgCli(args('publish',extra),{fetchImpl:fetchImpl as typeof fetch});expect(result.exitCode).toBe(1);
  }
  expect(calls).toBe(0);
  const result=await runFlightDeckPgCli(args('publish',['--public','--version','version-id']),{fetchImpl:fetchImpl as typeof fetch});
  expect(result.exitCode).toBe(1);expect(result.stderr).toContain('409');expect(result.stderr).toContain('storage_incomplete');expect(calls).toBe(1);
});
test('publication CLI uses mediated session signing without reading or exporting a key',async()=>{
  Bun.env.BOT_NPUB='npub1bot';Bun.env.BOT_PUBKEY_HEX='a'.repeat(64);Bun.env.SESSION_ID='test-session';Bun.env.WINGMAN_CAPABILITY='test-capability';Bun.env.WINGMAN_URL='http://wingman.test';Bun.env.WINGMAN_BROKER_URL='http://wingman.test';
  const calls:{path:string;body:any}[]=[];
  const fetchImpl=async(input:any,init:any)=>{
    const req=new Request(input,init);const path=new URL(req.url).pathname;const body=init?.body?JSON.parse(init.body):null;calls.push({path,body});
    if(path==='/api/mcp/wingman/flightdeck')return Response.json({workspace:{workspaceId:'workspace-id',backendBaseUrl:'http://tower.test',sourceAppNpub:'npub1app'}});
    if(path==='/api/mcp/capabilities/nip98')return Response.json({token:'Nostr broker-signature',signedBy:'npub1bot'});
    return Response.json({versions:[]});
  };
  const result=await runFlightDeckPgCli(['file','publish','file-id','--workspace','workspace-id','--version','version-id','--public','--json'],{fetchImpl:fetchImpl as typeof fetch});
  expect(result.exitCode).toBe(0);expect(calls.some(c=>c.body?.method==='PUT'&&c.body?.url?.endsWith('/versions/version-id/blossom'))).toBe(true);
});

test('attachment CLI publishes existing source bytes with observed link/hash and explicit public consent', async () => {
  delete Bun.env.SESSION_ID; delete Bun.env.WINGMAN_CAPABILITY;
  const requests: Request[]=[];
  const fetchImpl=async(input:any,init:any)=>{requests.push(new Request(input,init));return Response.json({attachment:{link_id:'link-id',sha256_hex:'a'.repeat(64),available:true}});};
  const command=(action:string,extra:string[]=[])=>['attachment',action,'storage-id','--message','message-id','--workspace','workspace-id','--tower-url','http://tower.test','--app-npub','npub1app','--key','1'.repeat(64),'--json',...extra];
  expect((await runFlightDeckPgCli(command('publish'),{fetchImpl:fetchImpl as typeof fetch})).exitCode).toBe(1);expect(requests).toHaveLength(0);
  expect((await runFlightDeckPgCli(command('publish',['--public']),{fetchImpl:fetchImpl as typeof fetch})).exitCode).toBe(0);
  expect(requests.map(r=>r.method)).toEqual(['GET','PUT']);
  expect(new URL(requests[1].url).pathname).toBe('/api/v4/flightdeck-pg/workspaces/workspace-id/messages/message-id/attachments/storage-id/blossom');
  expect(await requests[1].json()).toEqual({public:true,expected_link_id:'link-id',expected_sha256:'a'.repeat(64)});
  expect((await runFlightDeckPgCli(command('unpublish'),{fetchImpl:fetchImpl as typeof fetch})).exitCode).toBe(0);expect(requests.at(-1)!.method).toBe('DELETE');
});
test('attachment CLI uses the stable capability broker and preserves source errors', async () => {
  Bun.env.BOT_NPUB='npub1bot';Bun.env.BOT_PUBKEY_HEX='a'.repeat(64);Bun.env.SESSION_ID='test-session';Bun.env.WINGMAN_CAPABILITY='test-capability';Bun.env.WINGMAN_URL='http://wingman.test';Bun.env.WINGMAN_BROKER_URL='http://wingman.test';
  const calls:{path:string;body:any}[]=[];
  const fetchImpl=async(input:any,init:any)=>{
    const req=new Request(input,init),path=new URL(req.url).pathname,body=init?.body?JSON.parse(init.body):null;calls.push({path,body});
    if(path==='/api/mcp/wingman/flightdeck')return Response.json({workspace:{workspaceId:'workspace-id',backendBaseUrl:'http://tower.test',sourceAppNpub:'npub1app'}});
    if(path==='/api/mcp/capabilities/nip98')return Response.json({token:'Nostr broker-signature',signedBy:'npub1bot'});
    return Response.json({attachment:{link_id:'link-id',sha256_hex:'b'.repeat(64),available:true}});
  };
  const result=await runFlightDeckPgCli(['attachment','publish','storage-id','--message','message-id','--public','--json'],{fetchImpl:fetchImpl as typeof fetch});
  expect(result.exitCode).toBe(0);
  expect(calls.filter(c=>c.path==='/api/mcp/capabilities/nip98').map(c=>c.body.method)).toEqual(['GET','PUT']);
  expect(calls.some(c=>c.body?.method==='PUT'&&c.body?.url?.endsWith('/messages/message-id/attachments/storage-id/blossom'))).toBe(true);
});
