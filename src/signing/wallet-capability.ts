import type { WalletBrokerAdapter, WalletConstraint } from "./wallet-types.ts";

export const WALLET_READ_METHODS = new Set(["get_balance", "get_pending", "get_payment"]);
export const WALLET_SPEND_METHODS = new Set(["pay_invoice"]);
export class WalletBudgetError extends Error {}

// The adapter invokes reserve only after preparation has established a verified
// upper bound, while holding the bot's cross-process wallet lock.
export async function executeWalletSpend(input: {
  adapter: WalletBrokerAdapter;
  method: string;
  params: unknown;
  botNpub: string;
  amountMsats: unknown;
  constraint: WalletConstraint;
  getSpent: () => number;
  reserve: (amount: number) => void;
  stillAuthorized: () => Promise<boolean>;
}): Promise<unknown> {
  let reserved = false;
  if (!Number.isSafeInteger(input.amountMsats) || (input.amountMsats as number) <= 0) throw new WalletBudgetError("A positive maximum amountMsats is required");
  return await input.adapter.spend({
    method: input.method, params: input.params, botNpub: input.botNpub,
    amountMsats: input.amountMsats as number,
    reserve: async amount => {
      if (reserved) throw new WalletBudgetError("Wallet adapter attempted a second reservation");
      if (!await input.stillAuthorized()) throw new WalletBudgetError("Wallet capability is no longer authorized");
      if (!Number.isSafeInteger(amount) || amount <= 0 || amount > (input.amountMsats as number)
        || amount > input.constraint.maxSpendMsats || input.getSpent() + amount > input.constraint.maxTotalSpendMsats) {
        throw new WalletBudgetError("Verified wallet spend exceeds request or capability budget");
      }
      input.reserve(amount);
      reserved = true;
    },
  }).then(result => {
    if (!reserved) throw new WalletBudgetError("Wallet adapter did not reserve a verified amount");
    return result;
  });
}
