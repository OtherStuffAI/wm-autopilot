import { backendConnectionStore } from "../../agent-chat/backend-connection-store.ts";
import { instanceSettingsService } from "../../settings/instance-settings-service.ts";

/** Runtime configuration, never participant input, identifies custom-domain control planes. */
export function isControlPlaneHostname(host: string): boolean {
  if (/(?:^|\.)runwingman\.com$/.test(host) || /(?:^|\.)wingmanbefree\.com$/.test(host)) return true;
  const configured: string[] = [instanceSettingsService.get("runtime.base_url") ?? "", instanceSettingsService.get("internal.wapp_tower_url") ?? ""];
  for (const connection of backendConnectionStore.listAll()) configured.push(connection.backendBaseUrl, connection.transport?.httpsEndpoint ?? "");
  for (const [key,value] of Object.entries(process.env)) if (/(?:WINGMAN|TOWER|AUTOPILOT|BROKER)/i.test(key) && /(?:URL|ORIGIN|HOST)/i.test(key) && value) configured.push(value);
  return configured.some(value => {try {return new URL(value).hostname.toLowerCase() === host;} catch {return false;}});
}
