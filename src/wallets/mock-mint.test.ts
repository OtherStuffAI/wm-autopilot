import { transferToBot } from "./wallet-transfers.ts";
import { pendingTransfers } from "./wallet-transfer-store.ts";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deriveKeysetId, hashToCurve } from "@cashu/cashu-ts";
import { nip19 } from "nostr-tools";
import { BotWalletStore } from "./bot-wallet.ts";
import { CocoWalletBrokerAdapter } from "./wallet-broker-adapter.ts";
import { preparePayment } from "./wallet-operations.ts";

// In-process mint fixture only: private scalar 1 means C_ = B_. No real
// Lightning invoice, mint, external network request or Bitcoin is used.
function mockMint() {
  const mint = "https://fixture-mint.invalid";
  const keys = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [String(2 ** i), "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"]));
  const id = deriveKeysetId(keys);
  const quotes = new Map<string, { quote: string; amount: number; request: string; state: string; expiry: number; unit: string; fee_reserve?: number }>();
  const signed = new Map<string, { amount: number; id: string; C_: string }>();
  const spent = new Set<string>();
  let timeout = false;
  let meltTimeout = false;
  let loseSwapAfter = 0;
  let swapCalls = 0;
  function sign(outputs: Array<{ amount: number; B_: string }>) {
    return outputs.map(out => { const sig = { amount: out.amount, id, C_: out.B_ }; signed.set(out.B_, sig); return sig; });
  }
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.origin !== mint) throw new Error("Unexpected network request in wallet fixture");
    const path = url.pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (path === "/v1/info") return Response.json({ name: "Fixture", version: "fixture/1", nuts: { "4": { methods: [{ method: "bolt11", unit: "sat", min_amount: 1, max_amount: 65535 }], disabled: false }, "5": { methods: [{ method: "bolt11", unit: "sat", min_amount: 1, max_amount: 65535 }], disabled: false }, "7": { supported: true }, "8": { supported: true }, "9": { supported: true } } });
    if (path === "/v1/keysets") return Response.json({ keysets: [{ id, unit: "sat", active: true, input_fee_ppk: 0 }] });
    if (path === "/v1/keys" || path === `/v1/keys/${id}`) return Response.json({ keysets: [{ id, unit: "sat", keys }] });
    if ((path === "/v1/mint/quote/bolt11" || path === "/v1/melt/quote/bolt11") && init?.method === "POST") {
      const quote = crypto.randomUUID();
      const melting = path.includes("/melt/");
      const result = { quote, amount: melting ? 2 : Number(body.amount), request: melting ? body.request : "fixture-funding-invoice", state: melting ? "UNPAID" : "PAID", expiry: 2000000000, unit: "sat", ...(melting ? { fee_reserve: 1 } : {}) };
      quotes.set(quote, result);
      return Response.json(result);
    }
    if (path.includes("/quote/bolt11/")) return Response.json(quotes.get(path.split("/").at(-1)!));
    if (path === "/v1/mint/bolt11") {
      const quote = quotes.get(body.quote)!;
      quote.state = "ISSUED";
      const signatures = sign(body.outputs);
      if (timeout) { timeout = false; throw new Error("Simulated lost mint response"); }
      return Response.json({ signatures });
    }
    if (path === "/v1/swap") {
      swapCalls += 1;
      for (const proof of body.inputs) spent.add(hashToCurve(new TextEncoder().encode(proof.secret)).toHex(true));
      const signatures = sign(body.outputs);
      if (loseSwapAfter > 0 && --loseSwapAfter === 0) throw new Error("Simulated lost swap response");
      return Response.json({ signatures });
    }
    if (path === "/v1/melt/bolt11") {
      const quote = quotes.get(body.quote)!;
      quote.state = "PAID";
      for (const proof of body.inputs) spent.add(hashToCurve(new TextEncoder().encode(proof.secret)).toHex(true));
      if (meltTimeout) { meltTimeout = false; throw new Error("Simulated lost melt response"); }
      return Response.json({ ...quote, payment_preimage: "fixture-preimage", change: [] });
    }
    if (path === "/v1/checkstate") return Response.json({ states: body.Ys.map((Y: string) => ({ Y, state: spent.has(Y) ? "SPENT" : "UNSPENT" })) });
    if (path === "/v1/restore") {
      const outputs = body.outputs.filter((out: { B_: string }) => signed.has(out.B_));
      return Response.json({ outputs, signatures: outputs.map((out: { B_: string }) => signed.get(out.B_)) });
    }
    throw new Error(`Unsupported fixture endpoint: ${path}`);
  };
  return { mint, fetchImpl, loseNextMintResponse: () => { timeout = true; }, loseNextMeltResponse: () => { meltTimeout = true; }, loseSecondSwapResponse: () => { loseSwapAfter = 2; }, swapCount: () => swapCalls };
}

test("mock mint funding, lost-response recovery, token transfer and broker payment use durable Coco operations", async () => {
  const root = mkdtempSync(join(tmpdir(), "wallet-mint-fixture-"));
  const oldFetch = globalThis.fetch;
  const fixture = mockMint();
  globalThis.fetch = Object.assign(fixture.fetchImpl, { preconnect: oldFetch.preconnect }) as typeof fetch;
  const store = new BotWalletStore(root);
  const botA = nip19.npubEncode("44".repeat(32));
  const botB = nip19.npubEncode("55".repeat(32));
  let mintOp = "";
  let outgoingToken = "";
  let sendId = "";
  try {
    await store.withWallet(botA, async wallet => {
      await wallet.manager.mint.addMint(fixture.mint, { trusted: true });
      const quote = await wallet.manager.quotes.mint.create({ mintUrl: fixture.mint, method: "bolt11", amount: 16, unit: "sat" });
      const op = await wallet.manager.ops.mint.prepare({ quote, amount: 16 });
      mintOp = op.id;
      fixture.loseNextMintResponse();
      // Coco may recover during execute or report the ambiguous outcome. The
      // persisted operation must recover correctly on the following reopen.
      try { await wallet.manager.ops.mint.execute(op.id); } catch {}
    }, "sat");
    await new BotWalletStore(root).withWallet(botA, async wallet => {
      await wallet.manager.ops.mint.recovery.run();
      const op = await wallet.manager.ops.mint.refresh(mintOp);
      expect(op.state).toBe("finalized");
      expect((await wallet.manager.wallet.balances.total({ units: ["sat"] })).total.toString()).toBe("16");
      const prepared = await wallet.manager.ops.send.prepare({ mintUrl: fixture.mint, amount: 8, unit: "sat" });
      const sent = await wallet.manager.ops.send.execute(prepared.id);
      sendId = sent.operation.id;
      outgoingToken = wallet.manager.wallet.encodeToken(sent.token);
    });
    await store.withWallet(botB, async wallet => {
      await wallet.manager.mint.addMint(fixture.mint, { trusted: true });
      const op = await wallet.manager.ops.receive.prepare({ token: outgoingToken });
      expect((await wallet.manager.ops.receive.execute(op.id)).state).toBe("finalized");
    }, "sat");
    await store.withWallet(botA, async wallet => { expect((await wallet.manager.ops.send.refresh(sendId)).state).toBe("finalized"); });
    const adapter = new CocoWalletBrokerAdapter(store);
    const beforeDenial = await adapter.read({ method: "get_balance", botNpub: botB, params: {} });
    await expect(adapter.spend({ method: "pay_invoice", params: { mint: fixture.mint, invoice: "fixture-denied-invoice" }, botNpub: botB, amountMsats: 1, reserve: async () => { throw new Error("budget denied"); } })).rejects.toThrow("budget denied");
    const afterDenial = await adapter.read({ method: "get_balance", botNpub: botB, params: {} }) as { balance: unknown };
    expect(afterDenial.balance).toEqual((beforeDenial as { balance: unknown }).balance);
    await store.withWallet(botB, async wallet => { expect(await wallet.manager.ops.melt.listPrepared()).toEqual([]); });
    let reserved = 0;
    const payment = await adapter.spend({ method: "pay_invoice", params: { mint: fixture.mint, invoice: "fixture-payment-invoice" }, botNpub: botB, amountMsats: 8000, reserve: async amount => { reserved = amount; } });
    expect(reserved).toBeGreaterThanOrEqual(3000);
    expect(payment).toHaveProperty("state", "finalized");
    expect(JSON.stringify(payment)).not.toMatch(/fixture-preimage|proofs|secret|token/);
    let ambiguousPayment = "";
    await store.withWallet(botB, async wallet => {
      const { op } = await preparePayment(wallet, { mint: fixture.mint, invoice: "fixture-payment-invoice-2" });
      ambiguousPayment = op.id;
      fixture.loseNextMeltResponse();
      try { await wallet.manager.ops.melt.execute(op.id); } catch {}
    });
    await store.withWallet(botB, async wallet => {
      expect((await wallet.manager.ops.melt.refresh(ambiguousPayment)).state).toBe("finalized");
    });
    fixture.loseSecondSwapResponse();
    await expect(store.withWallet(botA, source => transferToBot(source, store, { recipient: botB, mint: fixture.mint, amount: "4" }))).rejects.toThrow();
    let transferId = "";
    await store.withWallet(botA, async wallet => {
      const pending = pendingTransfers(wallet.database);
      expect(pending).toHaveLength(1);
      transferId = pending[0]!.id;
      expect(pending[0]?.receiveId).toBeTruthy();
      expect(JSON.stringify(pending)).not.toMatch(/proofs|token|secret/);
    });
    const swapsBeforeResume = fixture.swapCount();
    const transfer = await store.withWallet(botA, source => transferToBot(source, store, { id: transferId }));
    expect(transfer.state).toBe("completed");
    expect(JSON.stringify(transfer)).not.toMatch(/proofs|token|secret/);
    expect(fixture.swapCount()).toBe(swapsBeforeResume);
    await store.withWallet(botA, async wallet => { expect(pendingTransfers(wallet.database)).toEqual([]); });
    // Repeating resume must reuse the exact receive, never create new value.
    await store.withWallet(botA, source => transferToBot(source, store, { id: transferId }));
    expect(fixture.swapCount()).toBe(swapsBeforeResume);
    await expect(store.withWallet(botA, source => transferToBot(source, store, { recipient: botA, mint: fixture.mint, amount: "1" }))).rejects.toThrow("another bot");

  } finally { globalThis.fetch = oldFetch; rmSync(root, { recursive: true, force: true }); }
});
