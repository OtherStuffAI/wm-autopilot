import {test,expect} from "bun:test";
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {generateSecretKey,getPublicKey,nip19} from "nostr-tools";
import {WappStore} from "./wapp-store";
import {ensureLocalPipelineInstallation} from "./local-pipeline-installation";
test("trusted local installation creates fresh custody, reuses exact binding and denies owner/origin drift",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"local-install-")),store=new WappStore(join(dir,"wapps.sqlite"));
 const owner=nip19.npubEncode(getPublicKey(generateSecretKey())),input={appId:"app",ownerNpub:owner,scopeId:"bbfd13f9-1cdf-4f56-8213-cf0cffbe4d3c",launchUrl:"https://app.example",sourceWingmanUrl:"https://autopilot.example",title:"App"};
 const lookup=async()=>({root:dir,ownerNpub:owner});
 try {
  const result=await ensureLocalPipelineInstallation(store,lookup,input);
  expect(result.appNpub).not.toBe(owner);expect(result.towerPublicationGranted).toBe(false);expect(store.hasAppSigningKey(result.installationId)).toBe(true);
  expect(await ensureLocalPipelineInstallation(store,lookup,input)).toEqual(result);
  await expect(ensureLocalPipelineInstallation(store,lookup,{...input,launchUrl:"https://other.example"})).rejects.toThrow("installation_drift_denied");
  await expect(ensureLocalPipelineInstallation(store,async()=>({root:dir,ownerNpub:null}),input)).rejects.toThrow("installation_owner_denied");
  await expect(ensureLocalPipelineInstallation(store,lookup,{...input,appId:"new",launchUrl:"http://app.example"})).rejects.toThrow("installation_origin_denied");
 } finally {rmSync(dir,{recursive:true,force:true})}
});
