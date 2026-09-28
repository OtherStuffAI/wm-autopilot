import { saveTransfer, type Transfer } from "./wallet-transfer-store.ts";
import type { SendOperation } from "@cashu/coco-core";
import type { BotWalletStore, OpenBotWallet } from "./bot-wallet.ts";
import { operationSummary, positiveAmount, requiredText, trustedMint, WalletInputError } from "./wallet-operations.ts";

function proofFingerprint(proofs: Array<{ id: string; secret: string; C: string; amount: { toString(): string } }>): string {
  return JSON.stringify(proofs.map(proof => JSON.stringify([proof.id, proof.amount.toString(), proof.C, proof.secret])).sort());
}

// Both wallet locks are acquired before creating any value-moving operation.
// Contention fails immediately, so reverse-direction transfers cannot deadlock.
export async function transferToBot(source: OpenBotWallet, store: BotWalletStore, input: { recipient?: string; mint?: string; amount?: string; id?: string }) {
  let transfer = input.id
    ? source.database.query<Transfer, [string]>("SELECT * FROM autopilot_wallet_transfers WHERE id = ?").get(input.id)
    : null;
  if (input.id && !transfer) throw new WalletInputError("Transfer journal does not exist in this source wallet");
  const recipient = transfer?.recipient ?? requiredText(input.recipient, "--to-bot");
  if (recipient === source.config.botNpub) throw new WalletInputError("Transfer recipient must be another bot");
  return await store.withWallet(recipient, async destination => {
    if (destination.config.unit !== source.config.unit) throw new WalletInputError("Transfer wallets must use the same unit");
    const mint = await trustedMint(source, transfer?.mint ?? input.mint);
    await trustedMint(destination, mint);
    if (!transfer) {
      const amount = positiveAmount(input.amount).toString();
      transfer = { id: crypto.randomUUID(), recipient, mint, amount, unit: source.config.unit, state: "preparing", sendId: null, receiveId: null,
        previousSendIds: JSON.stringify((await source.repo.sendOperationRepository.getByMintUrl(mint)).map(op => op.id)) };
      saveTransfer(source.database, transfer);
    }
    const row = transfer;
    let send: SendOperation | null = row.sendId ? await source.manager.ops.send.get(row.sendId) : null;
    if (!row.sendId) {
      const previous = new Set<string>(JSON.parse(row.previousSendIds));
      const candidates = (await source.repo.sendOperationRepository.getByMintUrl(mint)).filter(op => !previous.has(op.id) && op.unit === row.unit && op.amount.toString() === row.amount && op.method === "default");
      if (candidates.length > 1) throw new WalletInputError("Transfer preparation is ambiguous; operator inspection required");
      send = candidates[0] ?? await source.manager.ops.send.prepare({ mintUrl: mint, amount: row.amount, unit: row.unit });
      row.sendId = send.id;
      row.previousSendIds = "[]";
      saveTransfer(source.database, row);
    }
    if (!send) throw new WalletInputError("Transfer send operation is missing");
    if (send.state === "prepared") send = (await source.manager.ops.send.execute(send.id)).operation;
    else if (send.state === "executing") send = await source.manager.ops.send.refresh(send.id);
    if (!("token" in send) || !send.token || !["pending", "finalized"].includes(send.state)) {
      throw new WalletInputError("Transfer send has no redeemable persisted token; inspect source operation");
    }
    row.state = "sent";
    saveTransfer(source.database, row);
    let receive = row.receiveId ? await destination.manager.ops.receive.get(row.receiveId) : null;
    if (!row.receiveId) {
      // A crash can occur between receive.prepare and journaling its ID. Match
      // the exact persisted input proofs, never amount alone, before retrying.
      const fingerprint = proofFingerprint(send.token.proofs);
      const matches = (await destination.repo.receiveOperationRepository.getByMintUrl(mint))
        .filter(op => proofFingerprint(op.inputProofs) === fingerprint);
      if (matches.length > 1) throw new WalletInputError("Transfer redemption is ambiguous; operator inspection required");
      receive = matches[0] ?? await destination.manager.ops.receive.prepare({ token: send.token });
      row.receiveId = receive.id;
      saveTransfer(source.database, row);
    }
    if (!receive) throw new WalletInputError("Transfer receive operation is missing");
    if (receive.state === "executing") receive = await destination.manager.ops.receive.refresh(receive.id);
    if (receive.state === "prepared") receive = await destination.manager.ops.receive.execute(receive.id);
    if (receive.state !== "finalized") throw new WalletInputError("Transfer receive requires operator reconciliation before retrying");
    row.state = "received";
    saveTransfer(source.database, row);
    send = await source.manager.ops.send.refresh(send.id);
    if (send.state !== "finalized") throw new WalletInputError("Recipient received funds; source redemption confirmation is still pending");
    row.state = "completed";
    saveTransfer(source.database, row);
    return { id: row.id, state: row.state, recipient, send: operationSummary(send), receive: operationSummary(receive) };
  });
}
