#!/usr/bin/env bun
import { readFile } from "node:fs/promises";

import { TowerWappActivityRoutes, WappPublishingClient, type WappActivityProjection } from "../src/wapps/wapp-publishing-client";
import { wappStore } from "../src/wapps/wapp-store";

const value = (flag: string): string => {
  const index = Bun.argv.indexOf(flag);
  const result = index >= 0 ? Bun.argv[index + 1]?.trim() : "";
  if (!result) throw new Error(`${flag} is required`);
  return result;
};

const installationId = value("--installation");
const projectionFile = value("--projection-file");
const wapp = wappStore.get(installationId);
if (!wapp) throw new Error("WApp installation not found");
const binding = wapp.towerBindingId ? wappStore.getTowerBinding(wapp.towerBindingId) : null;
if (!binding?.workspaceId || !wappStore.hasAppSigningKey(wapp.id) || !wapp.publisherNpub) throw new Error("WApp Tower publishing identity is incomplete");

const projection = JSON.parse(await readFile(projectionFile, "utf8")) as WappActivityProjection;
const { grant, published } = await wappStore.withAppSigningKey(wapp.id, async (nsec) => {
const client = new WappPublishingClient({
  towerUrl: binding.towerUrl,
  workspaceId: binding.workspaceId!,
  wappInstallationId: wapp.wappInstallationId,
  publisherNpub: wapp.publisherNpub!,
  nsec,
  routes: TowerWappActivityRoutes,
});
const grant = await client.start();
const published = await client.publish(projection);
client.stop();
return { grant, published };
});
console.log(JSON.stringify({
  wapp_installation_id: grant.wapp_installation_id,
  publisher_npub: grant.publisher_npub,
  published,
}, null, 2));
