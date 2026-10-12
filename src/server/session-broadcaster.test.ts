import { expect, test } from "bun:test";
import { SessionBroadcaster } from "./session-broadcaster";
import { installedAppExecutionOwner } from "../wapps/execution-owner-access";
import type { WappRecord } from "../wapps/types";
test("actual lifecycle notifications reach app and current installation owner, never foreign or revoked owners",()=>{
 const broadcaster=new SessionBroadcaster();
 let rows=[{appNpub:"npub1app",ownerNpub:"npub1owner",recordState:"active",status:"active"} as WappRecord];
 broadcaster.setExecutionOwnerResolver(npub=>installedAppExecutionOwner(npub,rows));
 const received:Record<string,string[]>={};
 for(const owner of ["npub1app","npub1owner","npub1foreign"]){received[owner]=[];broadcaster.add(owner,{enqueue:(bytes:Uint8Array)=>received[owner]!.push(new TextDecoder().decode(bytes))} as any);}
 const event={type:"session-started",sessionId:"real-session"} as const;
 broadcaster.broadcast("npub1app",event);
 expect(received.npub1app).toHaveLength(1);expect(received.npub1owner).toEqual(received.npub1app);expect(received.npub1foreign).toEqual([]);
 rows=[{...rows[0]!,recordState:"deleted"}];broadcaster.broadcast("npub1app",{...event,type:"session-updated"});
 expect(received.npub1app).toHaveLength(2);expect(received.npub1owner).toHaveLength(1);expect(received.npub1foreign).toEqual([]);
});
