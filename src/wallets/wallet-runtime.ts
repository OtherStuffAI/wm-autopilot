import { BotWalletStore } from "./bot-wallet.ts";
import { CocoWalletBrokerAdapter } from "./wallet-broker-adapter.ts";
import { readWalletGrant } from "./wallet-grant.ts";
import { walletRoot } from "./wallet-storage.ts";

export function createWalletRuntime(dataDirectory: string) {
  const root = walletRoot(dataDirectory);
  return {
    adapter: new CocoWalletBrokerAdapter(new BotWalletStore(root)),
    getPolicy: (botNpub: string) => readWalletGrant(root, botNpub),
  };
}
