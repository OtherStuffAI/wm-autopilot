import {expect,test} from "bun:test";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {generateSecretKey,getPublicKey,nip19} from "nostr-tools";
import {SecretStore} from "./secret-store";
import {deniedPolicy} from "./secret-policy";
import {callTypeSafeNoul} from "./typesafe-noul-service";
const owner=nip19.npubEncode(getPublicKey(generateSecretKey()));
async function fixture(fn:(x:any)=>Promise<void>) {
  const dir=mkdtempSync(join(tmpdir(),"typed-noul-")),store=new SecretStore(join(dir,"store.db"),join(dir,"key"));
  const secret=store.create(owner,"local",{label:"Synthetic TypeSafe",type:"secret",value:"synthetic-service-credential",
    policy:{...deniedPolicy(),identities:[owner],pipelines:{enabled:true,mode:"selected",ids:["pipeline"]},allowExport:false}});
  const consumer={ownerNpub:owner,workspaceId:"local",identityNpub:owner,context:"pipeline" as const,contextId:"pipeline"};
  const input={credentialRef:secret.id,model:"jev-latest",state:{prompt:"edit"},questions:{
    injection:{type:"noul",instructions:"Injection?"},extraction:{type:"noul",instructions:"Extraction?"}}};
  try{await fn({store,secret,consumer,input})}finally{store.close();rmSync(dir,{recursive:true,force:true})}
}
test("nonexportable service credential stays inside one typed request and raw echoed fields never escape",()=>fixture(async x=>{
  let calls=0;
  const result=await callTypeSafeNoul(x.input,x.store,x.consumer,(async(url,options)=>{
    calls++;expect(String(url)).toBe("https://api.typesafe.ai/v1/systemone");
    expect(new Headers(options!.headers).get("authorization")).toBe("Bearer synthetic-service-credential");
    expect(Object.keys(JSON.parse(options!.body as string).questions)).toHaveLength(2);
    return Response.json({model:"jev-test",answers:{injection:{type:"noul",noul:0.95},extraction:{type:"noul",noul:0.9499}},private:"not returned"});
  }) as typeof fetch);
  expect(calls).toBe(1);expect(result).toEqual({model:"jev-test",answers:{injection:{type:"noul",noul:0.95},extraction:{type:"noul",noul:0.9499}}});
  expect(()=>x.store.consume(x.secret.id,x.consumer,"return")).toThrow("secret_export_denied");
}));
test("credential echo, invalid answers, error statuses, transport failures and timeout return retryable errors",()=>fixture(async x=>{
  for(const fake of [async()=>Response.json({model:"synthetic-service-credential"}),
    async()=>Response.json({model:"jev-test",answers:{injection:{type:"noul",noul:1.1},extraction:{type:"noul",noul:0}}}),
    async()=>new Response("unavailable",{status:529}),async()=>{throw new Error("synthetic-service-credential")}]) {
    expect(await callTypeSafeNoul(x.input,x.store,x.consumer,fake as unknown as typeof fetch)).toMatchObject({classifierError:{retryable:true}});
  }
  const timeout=((_url:any,options:any)=>new Promise((_,reject)=>options.signal.addEventListener("abort",()=>reject(Error("abort"))))) as typeof fetch;
  expect(await callTypeSafeNoul(x.input,x.store,x.consumer,timeout,()=>{},5)).toEqual({classifierError:{code:"timeout",retryable:true}});
}));
test("foreign credential authority, arbitrary URL/key bindings and revoked policy fail before transport",()=>fixture(async x=>{
  let calls=0;const fake=(async()=>{calls++;return Response.json({})}) as unknown as typeof fetch;
  expect(await callTypeSafeNoul(x.input,x.store,{...x.consumer,contextId:"foreign"},fake)).toMatchObject({classifierError:{code:"configuration"}});
  expect(await callTypeSafeNoul({...x.input,url:"https://evil.example"},x.store,x.consumer,fake)).toMatchObject({classifierError:{code:"configuration"}});
  x.store.revoke(owner,"local",x.secret.id,x.secret.revision);
  expect(await callTypeSafeNoul(x.input,x.store,x.consumer,fake)).toMatchObject({classifierError:{code:"configuration"}});
  expect(calls).toBe(0);
}));
test("revocation during inference denies its result and cannot restore stale policy",()=>fixture(async x=>{
  const fake=(async()=>{
    x.store.revoke(owner,"local",x.secret.id,x.secret.revision);
    return Response.json({model:"jev-test",answers:{injection:{type:"noul",noul:1},extraction:{type:"noul",noul:0}}});
  }) as unknown as typeof fetch;
  expect(await callTypeSafeNoul(x.input,x.store,x.consumer,fake)).toMatchObject({classifierError:{code:"configuration",retryable:true}});
  expect(x.store.get(owner,"local",x.secret.id).revokedAt).not.toBeNull();
  expect(()=>x.store.consume(x.secret.id,x.consumer,"return")).toThrow();
}));
