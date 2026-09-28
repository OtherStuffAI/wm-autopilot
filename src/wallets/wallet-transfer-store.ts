import type { Database } from "bun:sqlite";

export interface Transfer {
  id: string;
  recipient: string;
  mint: string;
  amount: string;
  unit: string;
  state: string;
  sendId: string | null;
  receiveId: string | null;
  previousSendIds: string;
}
export function initializeWalletTransfers(database: Database): void {
  database.exec(`CREATE TABLE IF NOT EXISTS autopilot_wallet_transfers (
    id TEXT PRIMARY KEY, recipient TEXT NOT NULL, mint TEXT NOT NULL,
    amount TEXT NOT NULL, unit TEXT NOT NULL, state TEXT NOT NULL,
    sendId TEXT, receiveId TEXT, previousSendIds TEXT NOT NULL
  )`);
}
export function pendingTransfers(database: Database) {
  return database.query<Transfer, []>("SELECT * FROM autopilot_wallet_transfers WHERE state != 'completed'").all()
    .map(({ previousSendIds, ...summary }) => summary);
}
export function saveTransfer(database: Database, row: Transfer): void {
  database.query(`INSERT OR REPLACE INTO autopilot_wallet_transfers
    (id,recipient,mint,amount,unit,state,sendId,receiveId,previousSendIds) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(row.id, row.recipient, row.mint, row.amount, row.unit, row.state, row.sendId, row.receiveId, row.previousSendIds);
}

