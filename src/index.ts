import { runSetupWizard } from "./setup/wizard";
import { assertNoPersistentRootMcpConfig } from "./server/bootstrap/runtime-privacy-tripwires";

function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  return String(value);
}

function isNonFatalRelayRejection(value: unknown): boolean {
  const msg = errorMessage(value);
  return (
    msg.includes("Event rejected") ||
    msg.includes("blocked:") ||
    msg.includes("AUTH required") ||
    msg.includes("rate-limited:")
  );
}

// Safety net: relay policy rejections should not take down the whole Wingman
// process. We still log them so the real call sites can be hardened.
process.on("unhandledRejection", (reason) => {
  if (isNonFatalRelayRejection(reason)) {
    console.warn("[nostr] swallowed unhandled relay rejection:", errorMessage(reason));
    return;
  }
  console.error("[process] Unhandled promise rejection:", reason);
});

process.on("uncaughtException", (error) => {
  if (isNonFatalRelayRejection(error)) {
    console.warn("[nostr] swallowed uncaught relay rejection:", errorMessage(error));
    return;
  }
  console.error("[process] Uncaught exception:", error);
  process.exit(1);
});

const main = async () => {
  assertNoPersistentRootMcpConfig();
  const proceed = await runSetupWizard();
  if (!proceed) {
    process.exit(0);
  }
  // Dynamic import after wizard completes so env vars are loaded
  await import("./server");
};

main().catch((error) => {
  console.error("Failed to start Wingman:", error);
  process.exit(1);
});
