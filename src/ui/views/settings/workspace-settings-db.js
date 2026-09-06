import Dexie from '/vendor/dexie/dexie.mjs';

export const workspaceSettingsDb = new Dexie('WingmanWorkspaceSettings');
workspaceSettingsDb.version(1).stores({ views: 'id, syncedAt' });
export { Dexie };
