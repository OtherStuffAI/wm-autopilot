export interface WalletConstraint {
  readMethods: string[];
  spendMethods: string[];
  maxSpendMsats: number;
  maxTotalSpendMsats: number;
}

export interface WalletBrokerAdapter {
  read(input: { method: string; params: unknown; botNpub: string }): Promise<unknown>;
  spend(input: {
    method: string;
    params: unknown;
    amountMsats: number;
    botNpub: string;
    reserve: (verifiedMaximumMsats: number) => Promise<void>;
  }): Promise<unknown>;
}
