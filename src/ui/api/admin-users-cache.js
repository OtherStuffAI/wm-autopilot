import Dexie from "/vendor/dexie/dexie.mjs";

const db = new Dexie("WingmanAdminUsers");
db.version(1).stores({ views: "id, syncedAt" });

// Scope snapshots to the signed-in administrator. The server remains the role authority.
export async function cacheAdminUsers(viewer, users) {
  if (!viewer) throw new Error("Administrator identity is missing");
  await db.views.put({ id: viewer, users, syncedAt: Date.now() });
  return (await db.views.get(viewer)).users;
}

export async function cacheAdminUser(viewer, user) {
  if (!viewer) throw new Error("Administrator identity is missing");
  return db.transaction("rw", db.views, async () => {
    const users = (await db.views.get(viewer))?.users ?? [];
    const key = user.normalizedNpub || user.npub;
    const index = users.findIndex((entry) => (entry.normalizedNpub || entry.npub) === key);
    if (index === -1) users.push(user);
    else users[index] = user;
    await db.views.put({ id: viewer, users, syncedAt: Date.now() });
    return (await db.views.get(viewer)).users;
  });
}
