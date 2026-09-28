#!/usr/bin/env bun
import { runWalletCli } from "../src/wallets/wallet-cli.ts";
import { WalletInputError } from "../src/wallets/wallet-operations.ts";

try {
  const isHelp = ["help", "--help", "-h"].includes(process.argv[2] ?? "help");
  if (!isHelp && (process.env.WINGMAN_CAPABILITY || process.env.SESSION_ID)) {
    throw new WalletInputError("Operator wallet CLI is unavailable in managed agent sessions; use the wallet capability client. Run operator commands from an external operator shell.");
  }
  const result = await runWalletCli(process.argv.slice(2));
  process.stdout.write(typeof result === "string" ? `${result}\n` : `${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  // Coco/network errors can contain proofs or request details. Never echo them.
  process.stderr.write(`${error instanceof WalletInputError ? error.message : "Wallet command failed. Check configuration, private file permissions and pending operations; see recovery documentation."}\n`);
  process.exitCode = 1;
}
