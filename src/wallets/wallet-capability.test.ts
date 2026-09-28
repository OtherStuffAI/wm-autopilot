import { expect, test } from "bun:test";
import { executeWalletSpend } from "../signing/wallet-capability.ts";
import type { WalletBrokerAdapter } from "../signing/wallet-types.ts";
import { sanitizeInjectedAgentEnvironment, buildInheritedAgentEnvironment } from "../agents/agent-environment.ts";

const policy = { readMethods: [], spendMethods: ["pay_invoice"], maxSpendMsats: 2000, maxTotalSpendMsats: 3000 };

test("adapter must reserve exactly once before returning a spend", async () => {
  const execute = (adapter: WalletBrokerAdapter) => executeWalletSpend({ adapter, constraint: policy, method: "pay_invoice", botNpub: "fixture", params: {}, amountMsats: 2000, getSpent: () => 0, reserve: () => {}, stillAuthorized: async () => true });
  await expect(execute({ read: async () => ({}), spend: async () => ({}) })).rejects.toThrow("did not reserve");
  await expect(execute({ read: async () => ({}), spend: async input => { await input.reserve(1000); await input.reserve(1000); } })).rejects.toThrow("second reservation");
});

test("wallet custody variables are removed from inherited and injected agent environments", () => {
  const custody = { WINGMAN_WALLET_DIR: "/private/wallets", CASHU_SEED: "fixture", CASHU_TOKEN: "fixture", CASHU_MNEMONIC: "fixture", CASHU_API_KEY: "fixture", CASHU_AUTH_TOKEN: "fixture", COCO_MINT_CREDENTIAL: "fixture", CASHU_CUSTOM_SECRET: "fixture" };
  expect(buildInheritedAgentEnvironment(custody)).toEqual({});
  expect(sanitizeInjectedAgentEnvironment({ ...custody, PATH: "/bin" })).toEqual({ PATH: "/bin" });
});
