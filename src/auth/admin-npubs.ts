import { isNpubInList, normaliseNpub, normaliseNpubList } from "../identity/npub-utils";

export const ADMIN_ROLE = "admin";

export type AdminIdentityUserRecord = {
  npub: string;
  normalizedNpub: string;
  roles: string[];
};

export type AdminIdentityUserStore = {
  listUsers: () => AdminIdentityUserRecord[];
  setRole: (npub: string, role: string, enabled: boolean) => unknown;
};

export function listStoredAdminNpubs(identityUserStore: Pick<AdminIdentityUserStore, "listUsers">): string[] {
  return normaliseNpubList(
    identityUserStore
      .listUsers()
      .filter((user) => user.roles.includes(ADMIN_ROLE))
      .map((user) => user.normalizedNpub || user.npub),
  );
}

export function listEffectiveAdminNpubs(
  identityUserStore: Pick<AdminIdentityUserStore, "listUsers">,
  bootstrapAdminNpubs: Iterable<string>,
): string[] {
  return normaliseNpubList([...bootstrapAdminNpubs, ...listStoredAdminNpubs(identityUserStore)]);
}

export function isEffectiveAdminNpub(
  npub: string | null | undefined,
  identityUserStore: Pick<AdminIdentityUserStore, "listUsers">,
  bootstrapAdminNpubs: Iterable<string>,
): boolean {
  const normalized = normaliseNpub(npub);
  if (!normalized) {
    return false;
  }
  if (isNpubInList(normalized, bootstrapAdminNpubs)) {
    return true;
  }
  return isNpubInList(normalized, listStoredAdminNpubs(identityUserStore));
}

export function seedBootstrapAdminUsers(
  identityUserStore: AdminIdentityUserStore,
  bootstrapAdminNpubs: Iterable<string>,
): string[] {
  const seeded: string[] = [];
  const storedAdmins = new Set(listStoredAdminNpubs(identityUserStore));
  for (const adminNpub of normaliseNpubList([...bootstrapAdminNpubs])) {
    if (storedAdmins.has(adminNpub)) {
      continue;
    }
    identityUserStore.setRole(adminNpub, ADMIN_ROLE, true);
    storedAdmins.add(adminNpub);
    seeded.push(adminNpub);
  }
  return seeded;
}

export function wouldLeaveNoEffectiveAdmins(
  targetNpub: string | null | undefined,
  identityUserStore: Pick<AdminIdentityUserStore, "listUsers">,
  bootstrapAdminNpubs: Iterable<string>,
): boolean {
  const normalizedTarget = normaliseNpub(targetNpub);
  if (!normalizedTarget) {
    return false;
  }
  const remaining = listEffectiveAdminNpubs(identityUserStore, bootstrapAdminNpubs)
    .filter((adminNpub) => normaliseNpub(adminNpub) !== normalizedTarget);
  return remaining.length === 0;
}
