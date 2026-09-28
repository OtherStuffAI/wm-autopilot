// Only locally controlled diagnostics may be shown by the operator CLI.
// Exceptions from Coco or mint/network requests must never be echoed.
export class WalletInputError extends Error {}
