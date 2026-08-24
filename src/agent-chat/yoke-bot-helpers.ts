import { pathToFileURL } from 'node:url';

import type { YokeBotHelpersModule } from './types';

let cachedModule: Promise<YokeBotHelpersModule> | null = null;

function resolveYokeBotHelpersUrl(): string {
  const override = Bun.env.AGENT_CHAT_YOKE_HELPERS_PATH?.trim();
  if (override) {
    return pathToFileURL(override).href;
  }
  return import.meta.resolve('@runwingman/flightdeck-cli/src/bot-helpers.js');
}

export async function loadYokeBotHelpers(): Promise<YokeBotHelpersModule> {
  if (!cachedModule) {
    const pendingModule = import(resolveYokeBotHelpersUrl()).then((module) => {
      const required = [
        'createBotWorkspaceKey',
        'loadBotWorkspaceKey',
        'signBotRequest',
        'signWorkspaceRequest',
        'fetchBotGroupKeys',
        'loadBotGroupKeys',
        'decryptChatRecord',
        'normalizeThreadId',
        'normalizeChannelParticipants',
        'normalizeChatRoutingContext',
      ] as const;
      for (const key of required) {
        if (typeof module[key] !== 'function') {
          throw new Error(`Yoke bot helper export missing: ${key}`);
        }
      }
      return module as unknown as YokeBotHelpersModule;
    });
    cachedModule = pendingModule;
    pendingModule.catch(() => {
      if (cachedModule === pendingModule) cachedModule = null;
    });
  }
  return cachedModule;
}
