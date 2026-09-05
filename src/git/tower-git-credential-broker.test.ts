import { expect, test } from "bun:test";
import { TowerGitCredentialBroker } from "./tower-git-credential-broker";
import { nativeFixture, nativeServer } from "./native-forgejo-login.test";
const request = { protocol: "https" as const, host: "forgejo.test", gatewayOrigin: "https://forgejo.test", path: "/org/repo.git", organization: "org", repository: "repo" };
const input = { session: {} as any, botNpub: "npub-agent", workspaceId: "", request, signNip98: async () => "Nostr proof" };
test("uses static configured hosts without Tower discovery",async()=>{
  const broker=new TowerGitCredentialBroker({servers:[nativeServer],fetch:(async()=>{throw new Error('offline');}) as typeof fetch});
  expect(await broker.discover()).toEqual({gatewayOrigins:['https://forgejo.test']});
  await expect(broker.exchange({...input,request:{...request,gatewayOrigin:'https://foreign.test'}})).rejects.toThrow('not configured');
});
test("native credentials are isolated by actor, retained across paths and Tower downtime",async()=>{
  const fixture=nativeFixture(); const broker=new TowerGitCredentialBroker({servers:[nativeServer],fetch:fixture.fetchImpl});
  const first=await broker.exchange(input); expect(fixture.logins()).toBe(1);
  const second=await broker.exchange({...input,request:{...request,path:'/other/repo.git'}});expect(second.password).toBe(first.password);expect(fixture.logins()).toBe(1);
  const lastCalls=fixture.calls.slice(-1);expect(lastCalls[0]!.url).toBe('https://forgejo.test/api/v1/user');
  await broker.exchange({...input,botNpub:'other-actor'});expect(fixture.logins()).toBe(2);
});
test("permission failures do not retry Nostr login; revoked credentials reauthenticate once",async()=>{
  const fixture=nativeFixture(); const broker=new TowerGitCredentialBroker({servers:[nativeServer],fetch:fixture.fetchImpl});await broker.exchange(input);
  fixture.setUserStatus(403);await expect(broker.exchange(input)).rejects.toThrow('(403)');expect(fixture.logins()).toBe(1);
  fixture.setUserStatus(401);await expect(broker.exchange(input)).rejects.toThrow('issued account');expect(fixture.logins()).toBe(2);
});
test("concurrent credential requests share a single login",async()=>{
  const fixture=nativeFixture(); const broker=new TowerGitCredentialBroker({servers:[nativeServer],fetch:fixture.fetchImpl});
  await Promise.all([broker.exchange(input),broker.exchange(input)]);expect(fixture.logins()).toBe(1);
});

test("expired native tokens force fresh Nostr-backed authorization",async()=>{
  const fixture=nativeFixture({expiresIn:1});const broker=new TowerGitCredentialBroker({servers:[nativeServer],fetch:fixture.fetchImpl});
  const first=await broker.exchange(input);const second=await broker.exchange(input);expect(first.password).not.toBe(second.password);expect(fixture.logins()).toBe(2);
});
