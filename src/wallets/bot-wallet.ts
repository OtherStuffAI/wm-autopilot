import { WalletInputError } from "./wallet-errors.ts";
import { existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Manager, type CocoConfig } from "@cashu/coco-core";
import { SqliteRepositories } from "@cashu/coco-sqlite-bun";
import { acquireWalletLock, createWalletConfig, decryptWalletSeed, loadWalletConfig, assertPrivateFile, walletPath, walletRoot, writePrivate, type WalletConfig } from "./wallet-storage.ts";

export interface OpenBotWallet {
  manager: Manager;
  repo: SqliteRepositories;
  database: Database;
  config: WalletConfig;
  directory: string;
}

// Open locally without initializeCoco's automatic recovery sweeps. A balance
// read must never resume payments. Recovery is an explicit operator command.
export class BotWalletStore {
  constructor(readonly root = walletRoot()) {}

  async withWallet<T>(botNpub: string, callback: (wallet: OpenBotWallet) => Promise<T>, createUnit?: string): Promise<T> {
    const directory = walletPath(this.root, botNpub);
    const release = acquireWalletLock(directory);
    let database: Database | undefined;
    let manager: Manager | undefined;
    let seed: Uint8Array | undefined;
    try {
      const config = createUnit
        ? createWalletConfig(this.root, directory, botNpub, createUnit)
        : loadWalletConfig(directory, botNpub);
      seed = decryptWalletSeed(this.root, config);
      const dbPath = join(directory, "wallet.sqlite");
      if (existsSync(dbPath)) assertPrivateFile(dbPath);
      else if (createUnit) writePrivate(dbPath, new Uint8Array());
      else throw new WalletInputError("Wallet proof database is missing; restore the complete backup before opening");
      database = new Database(dbPath, { strict: true });
      database.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
      chmodSync(dbPath, 0o600);
      const repo = new SqliteRepositories({ database });
      await repo.init();
      const watchers: CocoConfig["watchers"] = {
        mintOperationWatcher: { disabled: true }, proofStateWatcher: { disabled: true }, meltQuoteWatcher: { disabled: true },
      };
      const processors: CocoConfig["processors"] = {
        mintOperationProcessor: { disabled: true }, meltSettlementProcessor: { disabled: true },
      };
      const walletSeed = seed;
      manager = new Manager(repo, async () => walletSeed.slice(), undefined, undefined, undefined, watchers, processors);
      await manager.initPlugins();
      return await callback({ manager, repo, database, config, directory });
    } finally {
      try { await manager?.dispose(); } finally {
        database?.close();
        seed?.fill(0);
        release();
      }
    }
  }
}
