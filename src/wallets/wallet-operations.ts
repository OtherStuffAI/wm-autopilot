import { pendingTransfers } from "./wallet-transfer-store.ts";
import { Amount, type MintQuote, type MeltQuote, type SendOperation, type ReceiveOperation, type MintOperation, type MeltOperation } from "@cashu/coco-core";
import type { OpenBotWallet } from "./bot-wallet.ts";

import { WalletInputError } from "./wallet-errors.ts";
export { WalletInputError } from "./wallet-errors.ts";
export function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new WalletInputError(`${name} is required`);
  return value.trim();
}
export function bitcoinMsats(amount: Amount, unit: string): number {
  if (unit !== "sat" && unit !== "msat") throw new WalletInputError("Bitcoin unit required");
  const result = amount.toBigInt() * (unit === "sat" ? 1000n : 1n);
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new WalletInputError("Operation exceeds safe broker accounting range");
  return Number(result);
}
export function positiveAmount(value: unknown): Amount {
  const text = requiredText(value, "amount");
  if (!/^[1-9][0-9]*$/.test(text)) throw new WalletInputError("amount must be a positive integer in the configured unit");
  return Amount.from(text);
}
export function mintUrl(value: unknown): string {
  const url = new URL(requiredText(value, "mint"));
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new WalletInputError("Mint must be an HTTPS URL without credentials, query or fragment");
  return url.href.replace(/\/$/, "");
}
export async function trustedMint(wallet: OpenBotWallet, value: unknown): Promise<string> {
  const mint = mintUrl(value);
  if (!await wallet.manager.mint.isTrustedMint(mint)) throw new WalletInputError("Mint must be explicitly trusted by the operator");
  return mint;
}

type Operation = SendOperation | ReceiveOperation | MintOperation | MeltOperation;
export function operationSummary(op: Operation) {
  return {
    id: op.id, state: op.state, mint: op.mintUrl, unit: op.unit,
    amount: "amount" in op ? op.amount?.toString() : undefined,
    fee: "effectiveFee" in op ? op.effectiveFee?.toString() : undefined,
    createdAt: op.createdAt, updatedAt: op.updatedAt,
  };
}
export function quoteSummary(quote: MintQuote | MeltQuote, includeInvoice = false) {
  return {
    quoteId: quote.quoteId, mint: quote.mintUrl, unit: quote.unit, state: quote.state,
    amount: "amount" in quote ? quote.amount?.toString() : undefined,
    feeReserve: "fee_reserve" in quote ? quote.fee_reserve.toString() : undefined,
    expiry: "expiry" in quote ? quote.expiry : undefined,
    ...(includeInvoice ? { invoice: quote.request } : {}),
  };
}
export async function walletStatus(wallet: OpenBotWallet) {
  const { manager, config } = wallet;
  const [balance, send, receive, mint, melt, mintQuotes, meltQuotes] = await Promise.all([
    manager.wallet.balances.byMintAndUnit({ units: [config.unit] }),
    Promise.all([manager.ops.send.listInFlight(), manager.ops.send.listPrepared()]).then(([active, prepared]) => [...active, ...prepared]),
    Promise.all([manager.ops.receive.listInFlight(), manager.ops.receive.listPrepared()]).then(([active, prepared]) => [...active, ...prepared]),
    manager.ops.mint.listInFlight(),
    Promise.all([manager.ops.melt.listInFlight(), manager.ops.melt.listPrepared()]).then(([active, prepared]) => [...active, ...prepared]),
    manager.quotes.mint.listPending(), manager.quotes.melt.listPending(),
  ]);
  return { botNpub: config.botNpub, unit: config.unit, balance, transfers: pendingTransfers(wallet.database),
    pending: { send: send.map(operationSummary), receive: receive.map(operationSummary), mint: mint.map(operationSummary), melt: melt.map(operationSummary) },
    quotes: { mint: mintQuotes.map(q => quoteSummary(q)), melt: meltQuotes.map(q => quoteSummary(q)) },
  };
}

export async function preparePayment(wallet: OpenBotWallet, params: Record<string, unknown>) {
  const { manager, config } = wallet;
  const mint = await trustedMint(wallet, params.mint);
  const invoice = requiredText(params.invoice, "invoice");
  if (invoice.length > 10000) throw new WalletInputError("Invoice is too long");
  const quote = await manager.quotes.melt.create({ mintUrl: mint, method: "bolt11", methodData: { invoice }, unit: config.unit });
  if (quote.unit !== config.unit || quote.amount.toBigInt() <= 0n) throw new WalletInputError("Mint returned an inconsistent payment quote");
  const op = await manager.ops.melt.prepare({ quote });
  if (op.unit !== config.unit || op.amount.toBigInt() !== quote.amount.toBigInt()) {
    await manager.ops.melt.cancel(op.id);
    throw new WalletInputError("Mint payment amount or unit mismatch");
  }
  // Selected input value is an absolute bound including Lightning reserve,
  // input fees, swap fees and possible rounded/withheld change. Do not assume
  // the mint will return every unit of expected change.
  try { return { op, maximumMsats: bitcoinMsats(op.inputAmount, op.unit) }; }
  catch (error) { await manager.ops.melt.cancel(op.id); throw error; }
}

export async function recoverWallet(wallet: OpenBotWallet) {
  const { manager } = wallet;
  await manager.ops.send.recovery.run();
  await manager.ops.melt.recovery.run();
  await manager.ops.receive.recovery.run();
  await manager.ops.mint.recovery.run();
  for (const op of await manager.ops.send.listInFlight()) if (op.state === "pending") await manager.ops.send.refresh(op.id);
  for (const op of await manager.ops.melt.listInFlight()) if (op.state === "pending" || op.state === "executing") await manager.ops.melt.refresh(op.id);
  return await walletStatus(wallet);
}
