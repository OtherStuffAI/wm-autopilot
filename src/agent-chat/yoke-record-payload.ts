import { pathToFileURL } from 'node:url';

import type { YokeWorkspaceSession } from './types';

interface YokeTranslatorModule {
  decryptRecordPayload: (
    record: Record<string, unknown>,
    session: YokeWorkspaceSession,
    groupKeys: unknown,
    wsSession?: YokeWorkspaceSession | null,
  ) => Record<string, unknown>;
}

let cachedModule: Promise<YokeTranslatorModule> | null = null;

function resolveYokeTranslatorsUrl(): string {
  const override = Bun.env.AGENT_CHAT_YOKE_TRANSLATORS_PATH?.trim();
  if (override) {
    return pathToFileURL(override).href;
  }
  return new URL('../../../wingman-yoke/src/translators.js', import.meta.url).href;
}

async function loadYokeTranslators(): Promise<YokeTranslatorModule> {
  if (!cachedModule) {
    cachedModule = import(resolveYokeTranslatorsUrl()).then((module) => {
      if (typeof module.decryptRecordPayload !== 'function') {
        throw new Error('Yoke translator export missing: decryptRecordPayload');
      }
      return module as unknown as YokeTranslatorModule;
    });
  }
  return cachedModule;
}

export async function decryptRecordPayloadWithYoke(params: {
  record: Record<string, unknown>;
  wsSession: YokeWorkspaceSession;
  groupKeys: unknown;
}): Promise<Record<string, unknown>> {
  const module = await loadYokeTranslators();
  return module.decryptRecordPayload(params.record, params.wsSession, params.groupKeys, params.wsSession);
}
