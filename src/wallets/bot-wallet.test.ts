import { transferToBot } from "./wallet-transfers.ts";
import { pendingTransfers } from "./wallet-transfer-store.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Amount } from "@cashu/coco-core";
import { nip19 } from "nostr-tools";
import { BotWalletStore } from "./bot-wallet.ts";
import { acquireWalletLock, decryptWalletSeed, loadWalletConfig, unlockWallet, walletPath } from "./wallet-storage.ts";
import { bitcoinMsats, operationSummary, trustedMint, walletStatus } from "./wallet-operations.ts";
import { readWalletGrant, saveWalletGrant } from "./wallet-grant.ts";
import { runWalletCli } from "./wallet-cli.ts";

const botA = nip19.npubEncode("11".repeat(32));
const botB = nip19.npubEncode("22".repeat(32));
const mint = "https://mint.example";
let root: string;
let previousRoot: string | undefined;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "bot-wallet-test-")); previousRoot = process.env.WINGMAN_WALLET_DIR; process.env.WINGMAN_WALLET_DIR = root; });
afterEach(() => { if (previousRoot === undefined) delete process.env.WINGMAN_WALLET_DIR; else process.env.WINGMAN_WALLET_DIR = previousRoot; rmSync(root, { recursive: true, force: true }); });

test("seed, counters and large proof balances survive close/reopen and remain isolated", async () => {
  const store = new BotWalletStore(root);
  await store.withWallet(botA, async wallet => {
    await wallet.repo.counterRepository.setCounter(mint, "keyset", 456);
    await wallet.repo.proofRepository.saveProofs(mint, [{ mintUrl: mint, unit: "sat", id: "keyset", secret: "fixture-secret", C: "02" + "33".repeat(32), amount: Amount.from("1000000000000000000"), state: "ready" }]);
  }, "sat");
  const config = loadWalletConfig(walletPath(root, botA), botA);
  const seed = decryptWalletSeed(root, config);
  expect(seed.length).toBe(64);
  await new BotWalletStore(root).withWallet(botA, async wallet => {
    expect((await wallet.repo.counterRepository.getCounter(mint, "keyset"))?.counter).toBe(456);
    expect((await wallet.repo.proofRepository.getReadyProofs(mint))[0]?.amount.toString()).toBe("1000000000000000000");
    expect(await walletStatus(wallet)).toHaveProperty("balance");
  });
  expect(decryptWalletSeed(root, loadWalletConfig(walletPath(root, botA), botA))).toEqual(seed);
  await store.withWallet(botB, async wallet => {
    expect(await wallet.repo.proofRepository.getReadyProofs(mint)).toEqual([]);
    expect(await wallet.repo.counterRepository.getCounter(mint, "keyset")).toBeNull();
  }, "msat");
  expect(decryptWalletSeed(root, loadWalletConfig(walletPath(root, botB), botB))).not.toEqual(seed);
  expect(statSync(join(root, botA, "wallet.sqlite")).mode & 0o077).toBe(0);
  expect(statSync(join(root, botA, "wallet.json")).mode & 0o077).toBe(0);
  expect(readFileSync(join(root, botA, "wallet.json"), "utf8")).not.toContain(Buffer.from(seed).toString("hex"));
  seed.fill(0);
});

test("opening never replaces missing required seed or proof database", async () => {
  const store = new BotWalletStore(root);
  await store.withWallet(botA, async () => {}, "sat");
  unlinkSync(join(root, botA, "wallet.sqlite"));
  await expect(store.withWallet(botA, async () => {})).rejects.toThrow("database is missing");
  unlinkSync(join(root, "master.key"));
  await expect(store.withWallet(botA, async () => {})).rejects.toThrow();
  await expect(store.withWallet(botB, async () => {}, "sat")).rejects.toThrow("master key is missing");
});

test("pending receive survives restart and can be explicitly cancelled without mint traffic", async () => {
  const store = new BotWalletStore(root);
  await store.withWallet(botA, async wallet => {
    await wallet.repo.receiveOperationRepository.create({ id: "receive-fixture", state: "init", mintUrl: mint, unit: "sat", amount: Amount.from(4), inputProofs: [], createdAt: 1, updatedAt: 1 });
  }, "sat");
  await store.withWallet(botA, async wallet => {
    const op = await wallet.manager.ops.receive.get("receive-fixture");
    expect(op?.state).toBe("init");
    await wallet.manager.ops.receive.cancel("receive-fixture");
  });
  await store.withWallet(botA, async wallet => { expect(await wallet.manager.ops.receive.get("receive-fixture")).toBeNull(); });
});

test("cross-process lock blocks concurrent opens and only dead owners can unlock", async () => {
  const store = new BotWalletStore(root);
  await store.withWallet(botA, async () => {}, "sat");
  const directory = walletPath(root, botA);
  const release = acquireWalletLock(directory);
  await expect(store.withWallet(botA, async () => {})).rejects.toThrow("locked");
  expect(() => unlockWallet(directory)).toThrow("still running");
  release();
  writeFileSync(join(directory, "wallet.lock"), JSON.stringify({ pid: 2147483647 }), { mode: 0o600 });
  unlockWallet(directory);
  await store.withWallet(botA, async () => {});
});

test("unit, mint trust, grant and identity validation fail closed", async () => {
  const store = new BotWalletStore(root);
  await expect(store.withWallet(botA, async () => {}, "usd")).rejects.toThrow("units");
  await store.withWallet(botA, async wallet => { await expect(trustedMint(wallet, mint)).rejects.toThrow("trusted"); }, "sat");
  expect(() => walletPath(root, "../../other")).toThrow();
  expect(() => loadWalletConfig(walletPath(root, botA), botB)).toThrow("identity");
  expect(readWalletGrant(root, botA)).toBeUndefined();
  const grant = { readMethods: ["get_balance"], spendMethods: ["pay_invoice"], maxSpendMsats: 5000, maxTotalSpendMsats: 10000 };
  expect(saveWalletGrant(root, botA, grant)).toEqual(grant);
  expect(readWalletGrant(root, botA)).toEqual(grant);
  expect(() => saveWalletGrant(root, botA, { ...grant, readMethods: ["export_seed"] })).toThrow();
  expect(() => saveWalletGrant(root, botA, { ...grant, maxTotalSpendMsats: 1 })).toThrow();
  expect(bitcoinMsats(Amount.from(5), "sat")).toBe(5000);
  expect(bitcoinMsats(Amount.from(5), "msat")).toBe(5);
});

test("CLI no-funds create/open/recover and consistent backup restore", async () => {
  await runWalletCli(["create", "--bot", botA, "--unit", "sat"]);
  const status = await runWalletCli(["open", "--bot", botA]);
  expect(JSON.stringify(status)).not.toMatch(/encryptedSeed|proofs|fixture-secret/);
  const backup = join(root, "snapshot");
  await runWalletCli(["backup", "--bot", botA, "--out", backup]);
  process.env.WINGMAN_WALLET_DIR = backup;
  expect(await runWalletCli(["open", "--bot", botA])).toEqual(status);
  expect(await runWalletCli(["recover", "--bot", botA])).toEqual(status);
  await expect(runWalletCli(["create", "--bot", botA, "--unit", "sat"])).rejects.toThrow();
});

test("operation summaries never serialize tokens, input proofs, secrets or mint errors", () => {
  const op = { id: "fixture", state: "init" as const, mintUrl: mint, unit: "sat", amount: Amount.from(1), inputProofs: [], createdAt: 1, updatedAt: 2, error: "private-error", token: "private-token" };
  expect(JSON.stringify(operationSummary(op))).not.toMatch(/private|inputProof/);
});


test("bot transfer fails before creating a send when recipient is locked or unit differs", async () => {
  const store = new BotWalletStore(root);
  await store.withWallet(botA, async () => {}, "sat");
  await store.withWallet(botB, async () => {}, "msat");
  await store.withWallet(botB, async () => {
    await expect(store.withWallet(botA, source => transferToBot(source, store, { recipient: botB, mint, amount: "1" }))).rejects.toThrow("locked");
  });
  await expect(store.withWallet(botA, source => transferToBot(source, store, { recipient: botB, mint, amount: "1" }))).rejects.toThrow("same unit");
  await store.withWallet(botA, async wallet => {
    expect(pendingTransfers(wallet.database)).toEqual([]);
    expect(await wallet.manager.ops.send.listInFlight()).toEqual([]);
  });
});
