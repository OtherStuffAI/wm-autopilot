import { existsSync, copyFileSync, chmodSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { BotWalletStore, type OpenBotWallet } from "./bot-wallet.ts";
import { privateDirectory, readPrivate, unlockWallet, walletPath, writePrivate } from "./wallet-storage.ts";
import { saveWalletGrant } from "./wallet-grant.ts";
import { mintUrl, operationSummary, positiveAmount, preparePayment, quoteSummary, recoverWallet, requiredText, trustedMint, walletStatus, WalletInputError } from "./wallet-operations.ts";

const HELP = `Operator Cashu wallet (Bun + Coco). --bot <npub> required.
  create --unit sat|msat               Create isolated durable wallet
  open | balance | pending            Inspect local state (no recovery)
  trust --mint <https-url>             Add and explicitly trust a mint
  untrust --mint <https-url>           Disable a mint; keeps existing funds
  mints                               List configured mint trust
  fund-quote --mint <url> --amount <integer>
  fund-check --mint <url> --quote <id>
  mint --mint <url> --quote <id>       Prepare/execute paid funding quote
  send --mint <url> --amount <integer> --token-out <new-private-file>
  token-export --id <send-operation> --token-out <new-private-file>
  receive --token-file <private-file>  Persist and redeem token
  pay --mint <url> --invoice-file <file> --max-msats <integer>
  check --kind send|receive|mint|melt --id <operation>
  resume --kind receive|mint|melt --id <operation> [--max-msats <integer>]
  cancel --kind send|receive|melt --id <operation>
  reclaim --kind send|melt --id <operation>
  recover | sync                      Explicit Coco recovery/reconciliation
  restore --mint <url>                 NUT-13 seed scan for configured unit
  backup --out <new-directory>         Private consistent DB + encrypted seed + key
  grant --policy-file <file>           Explicit read/spend policy for new capabilities
  unlock                              Remove lock only if recorded PID exited
Amounts use wallet unit. Token/seed/proof contents never printed.
Set WINGMAN_WALLET_DIR to an operator-owned persistent root.
See docs/bot-cashu-wallets.md for custody, grants and recovery limitations.`;

function argsOf(args: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith("--") || !value || value.startsWith("--") || result[name] !== undefined) throw new WalletInputError("Expected unique --option value pairs");
    result[name] = value;
  }
  return result;
}
function required(args: Record<string, string>, name: string): string {
  return requiredText(args[`--${name}`], `--${name}`);
}
function checkMaximum(actual: number, value: string): void {
  const maximum = Number(value);
  if (!Number.isSafeInteger(maximum) || maximum <= 0 || actual > maximum) throw new WalletInputError("Verified payment inputs exceed --max-msats");
}
function preflightOutput(path: string): void {
  // Reserve the destination before creating a bearer token. Existing files
  // cannot be overwritten; crash recovery uses token-export to a fresh file.
  writePrivate(resolve(path), "");
}
async function backup(wallet: OpenBotWallet, root: string, destination: string) {
  const out = resolve(destination);
  if (existsSync(out)) throw new WalletInputError("Backup destination must be new");
  mkdirSync(out, { mode: 0o700 });
  const botDir = join(out, wallet.config.botNpub);
  privateDirectory(botDir);
  // Lock is held and DELETE journaling has committed every Coco transaction.
  for (const name of ["wallet.sqlite", "wallet.json", "grant.json"]) {
    const source = join(wallet.directory, name);
    if (existsSync(source)) { copyFileSync(source, join(botDir, name)); chmodSync(join(botDir, name), 0o600); }
  }
  writePrivate(join(out, "master.key"), readPrivate(join(root, "master.key")));
  writePrivate(join(out, "backup.json"), JSON.stringify({ version: 1, botNpub: wallet.config.botNpub, unit: wallet.config.unit }));
  return { backup: out, botNpub: wallet.config.botNpub };
}

async function command(wallet: OpenBotWallet, store: BotWalletStore, name: string, args: Record<string, string>): Promise<unknown> {
  const { manager, config } = wallet;
  if (["create", "open", "balance", "pending"].includes(name)) return await walletStatus(wallet);
  if (name === "trust") {
    const mint = mintUrl(required(args, "mint"));
    await manager.mint.addMint(mint, { trusted: true });
    return { mint, trusted: await manager.mint.isTrustedMint(mint), unit: config.unit };
  }
  if (name === "untrust") { const mint = mintUrl(required(args, "mint")); await manager.mint.untrustMint(mint); return { mint, trusted: false }; }
  if (name === "mints") return (await manager.mint.getAllMints()).map(mint => ({ mint: mint.mintUrl, trusted: mint.trusted }));
  if (name === "fund-quote") {
    const mint = await trustedMint(wallet, required(args, "mint"));
    const quote = await manager.quotes.mint.create({ mintUrl: mint, method: "bolt11", amount: positiveAmount(required(args, "amount")), unit: config.unit });
    return quoteSummary(quote, true);
  }
  if (name === "fund-check" || name === "mint") {
    const mint = await trustedMint(wallet, required(args, "mint"));
    const ref = { mintUrl: mint, quoteId: required(args, "quote") };
    const quote = await manager.quotes.mint.refresh(ref);
    if (name === "fund-check") return quoteSummary(quote);
    if (quote.method !== "bolt11" || quote.unit !== config.unit) throw new WalletInputError("Funding quote unit/method mismatch");
    const previous = await manager.ops.mint.listByQuote(ref);
    const op = previous[0] ?? await manager.ops.mint.prepare({ quote, amount: quote.amount });
    return operationSummary(await manager.ops.mint.execute(op.id));
  }
  if (name === "send") {
    const mint = await trustedMint(wallet, required(args, "mint"));
    const amount = positiveAmount(required(args, "amount"));
    const out = required(args, "token-out");
    preflightOutput(out);
    const op = await manager.ops.send.prepare({ mintUrl: mint, amount, unit: config.unit });
    const sent = await manager.ops.send.execute(op.id);
    await Bun.write(resolve(out), manager.wallet.encodeToken(sent.token));
    return { ...operationSummary(sent.operation), tokenFile: resolve(out) };
  }
  if (name === "token-export") {
    const op = await manager.ops.send.get(required(args, "id"));
    if (!op || !("token" in op) || !op.token) throw new WalletInputError("Operation has no persisted outgoing token");
    const out = required(args, "token-out");
    preflightOutput(out);
    await Bun.write(resolve(out), manager.wallet.encodeToken(op.token));
    return { ...operationSummary(op), tokenFile: resolve(out) };
  }
  if (name === "receive") {
    const token = readPrivate(resolve(required(args, "token-file"))).toString().trim();
    const decoded = await manager.wallet.decodeToken(token);
    await trustedMint(wallet, decoded.mint);
    if (decoded.unit !== config.unit) throw new WalletInputError("Token unit differs from wallet unit");
    const op = await manager.ops.receive.prepare({ token: decoded });
    return operationSummary(await manager.ops.receive.execute(op.id));
  }
  if (name === "pay") {
    const invoice = (await Bun.file(resolve(required(args, "invoice-file"))).text()).trim();
    const maximum = required(args, "max-msats");
    const { op, maximumMsats } = await preparePayment(wallet, { mint: required(args, "mint"), invoice });
    try { checkMaximum(maximumMsats, maximum); }
    catch (error) { await manager.ops.melt.cancel(op.id); throw error; }
    return { ...operationSummary(await manager.ops.melt.execute(op.id)), reservedMsats: maximumMsats };
  }
  if (["check", "resume", "cancel", "reclaim"].includes(name)) {
    const kind = required(args, "kind");
    const id = required(args, "id");
    if (!["send", "receive", "mint", "melt"].includes(kind)) throw new WalletInputError("Unknown operation kind");
    const api = manager.ops[kind as "send" | "receive" | "mint" | "melt"];
    if (name === "check") return operationSummary(await api.refresh(id));
    if (name === "resume") {
      if (kind === "send") throw new WalletInputError("Use token-export or reclaim for sends");
      if (kind === "melt") {
        const op = await manager.ops.melt.get(id);
        if (!op || op.state !== "prepared") throw new WalletInputError("Only a prepared melt can be resumed; use check/recover for ambiguous payments");
        const { bitcoinMsats } = await import("./wallet-operations.ts");
        checkMaximum(bitcoinMsats(op.inputAmount, op.unit), required(args, "max-msats"));
        return operationSummary(await manager.ops.melt.execute(id));
      }
      if (kind === "mint") return operationSummary(await manager.ops.mint.execute(id));
      return operationSummary(await manager.ops.receive.execute(id));
    }
    if (name === "cancel") {
      if (kind === "mint") throw new WalletInputError("Mint cancellation is unsupported");
      if (kind === "send") await manager.ops.send.cancel(id);
      else if (kind === "receive") await manager.ops.receive.cancel(id);
      else await manager.ops.melt.cancel(id);
    } else {
      if (kind === "send") await manager.ops.send.reclaim(id);
      else if (kind === "melt") await manager.ops.melt.reclaim(id);
      else throw new WalletInputError("Reclaim supports send or melt");
    }
    return { id, action: name };
  }
  if (name === "recover" || name === "sync") return await recoverWallet(wallet);
  if (name === "restore") {
    const mint = await trustedMint(wallet, required(args, "mint"));
    await manager.wallet.restore(mint, { units: [config.unit] });
    return await walletStatus(wallet);
  }
  if (name === "backup") return await backup(wallet, store.root, required(args, "out"));
  if (name === "grant") return saveWalletGrant(store.root, config.botNpub, JSON.parse(await Bun.file(required(args, "policy-file")).text()));
  throw new WalletInputError("Unknown wallet command; use help");
}

export async function runWalletCli(argv: string[]): Promise<unknown> {
  const [name = "help", ...rest] = argv;
  if (["help", "--help", "-h"].includes(name)) return HELP;
  const args = argsOf(rest);
  const bot = required(args, "bot");
  const store = new BotWalletStore();
  if (name === "unlock") { unlockWallet(walletPath(store.root, bot)); return { unlocked: true }; }
  return await store.withWallet(bot, wallet => command(wallet, store, name, args), name === "create" ? required(args, "unit") : undefined);
}
