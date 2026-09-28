/** Shared path without initializing any storage connections. */
export const databaseFile = new URL("../../data/wingman.db", import.meta.url).pathname;
