import type { WalletBrokerAdapter } from "../signing/wallet-types.ts";
import { BotWalletStore } from "./bot-wallet.ts";
import { bitcoinMsats, operationSummary, preparePayment, requiredText, walletStatus, WalletInputError } from "./wallet-operations.ts";

export class CocoWalletBrokerAdapter implements WalletBrokerAdapter {
  constructor(private readonly store = new BotWalletStore()) {}

  async read(input: Parameters<WalletBrokerAdapter["read"]>[0]): Promise<unknown> {
    return await this.store.withWallet(input.botNpub, async wallet => {
      if (input.method === "get_balance" || input.method === "get_pending") return await walletStatus(wallet);
      if (input.method === "get_payment") {
        const params = input.params as Record<string, unknown> | undefined;
        const op = await wallet.manager.ops.melt.get(requiredText(params?.operationId, "operationId"));
        if (!op) throw new WalletInputError("Payment operation does not exist in this bot wallet");
        return operationSummary(op);
      }
      throw new WalletInputError("Unsupported wallet read method");
    });
  }

  async spend(input: Parameters<WalletBrokerAdapter["spend"]>[0]): Promise<unknown> {
    if (input.method !== "pay_invoice") throw new WalletInputError("Unsupported wallet spend method");
    return await this.store.withWallet(input.botNpub, async wallet => {
      if (!input.params || typeof input.params !== "object" || Array.isArray(input.params)) throw new WalletInputError("Payment params are required");
      const { op, maximumMsats } = await preparePayment(wallet, input.params as Record<string, unknown>);
      try { await input.reserve(maximumMsats); }
      catch (error) { await wallet.manager.ops.melt.cancel(op.id); throw error; }
      // After reservation, every failure is ambiguous until Coco reconciles the
      // persisted operation. Never refund session budget merely on a timeout.
      const result = await wallet.manager.ops.melt.execute(op.id);
      const settledMsats = result.state === "finalized" && result.effectiveFee !== undefined
        ? bitcoinMsats(result.amount.add(result.effectiveFee), result.unit) : undefined;
      if (settledMsats !== undefined && settledMsats > maximumMsats) throw new Error("Wallet settlement exceeded reserved inputs");
      return { ...operationSummary(result), reservedMsats: maximumMsats, settledMsats };
    });
  }
}
