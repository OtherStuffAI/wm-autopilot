import { expect, test } from "bun:test";
import { classifyStoredBotUsers, listBotUserIdentities } from "./bot-user-identities";
import { isActiveAdminNpub, wouldLeaveNoEffectiveAdmins } from "./admin-npubs";

const human = "npub1human";
const bot = "npub1bot";

test("discovers profiles without login, normalizes duplicates and uses profile names", () => {
  const result = listBotUserIdentities([{ botNpub: ` ${bot} `, displayName: "Old name", active: true }], [
    { botNpub: bot, label: "Agent Delta", enabled: true },
    { botNpub: ` ${bot} `, label: "Duplicate", enabled: true },
    { botNpub: "npub1external", label: "External profile", enabled: true },
  ]);
  expect(result).toEqual([{ botNpub: bot, displayName: "Agent Delta", active: true },
    { botNpub: "npub1external", displayName: "External profile", active: true }]);
});

test("inactive keys and disabled/archived profiles cannot retain effective admin; bootstrap lockout remains", () => {
  const users = [{ npub: human, normalizedNpub: human, roles: ["admin"] },
    { npub: bot, normalizedNpub: bot, roles: ["admin", "bot"] }];
  const store = { listUsers: () => users };
  for (const profiles of [[], [{ botNpub: bot, label: "Agent Delta", enabled: true }]]) {
    const bots = listBotUserIdentities([{ botNpub: bot, displayName: "Agent Delta", active: false }], profiles);
    expect(isActiveAdminNpub(bot, store, [], bots)).toBe(false);
    expect(wouldLeaveNoEffectiveAdmins(human, store, [], (npub) => isActiveAdminNpub(npub, store, [], bots))).toBe(true);
    expect(isActiveAdminNpub(bot, store, [bot], bots)).toBe(true);
  }
  expect(isActiveAdminNpub(bot, store, [], [])).toBe(false);
  const disabled = listBotUserIdentities([{ botNpub: bot, displayName: "Agent Delta", active: true }],
    [{ botNpub: bot, label: "Agent Delta", enabled: false }]);
  expect(isActiveAdminNpub(bot, store, [], disabled)).toBe(false);
  users[1]!.roles = ["bot"];
  expect(isActiveAdminNpub(bot, store, [], [{ botNpub: bot, displayName: "Agent Delta", active: true }])).toBe(false);
});

test("classifies legacy stored bot admins before profile/key deletion, without promoting anyone", () => {
  const users = [{ npub: human, normalizedNpub: human, roles: ["admin"] },
    { npub: bot, normalizedNpub: bot, roles: ["admin"] }];
  const store = { listUsers: () => users, setRole: (npub: string, role: string) => { users.find((user) => user.npub === npub)!.roles.push(role); } };
  classifyStoredBotUsers(store, [{ botNpub: bot, displayName: "Agent Delta", active: true }]);
  expect(users[0]!.roles).toEqual(["admin"]);
  expect(users[1]!.roles).toEqual(["admin", "bot"]);
  expect(isActiveAdminNpub(bot, store, [], [])).toBe(false);
  expect(isActiveAdminNpub(human, store, [], [])).toBe(true);
});

test("deleting a key cannot leave an enabled profile with effective admin authority", () => {
  const store = { listUsers: () => [{ npub: bot, normalizedNpub: bot, roles: ["admin", "bot"] }] };
  const profiles = listBotUserIdentities([], [{ botNpub: bot, label: "Agent Delta", enabled: true }]);
  expect(isActiveAdminNpub(bot, store, [], profiles, () => false)).toBe(false);
  expect(isActiveAdminNpub(bot, store, [], profiles, () => true)).toBe(true);
});
