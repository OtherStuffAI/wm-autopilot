import { describe, expect, test } from "bun:test";
import { TerminalTicketStore } from "./terminal-ticket-store";

describe("terminal ticket store", () => {
  test("creates and consumes a ticket once for the matching npub", () => {
    const store = new TerminalTicketStore({ ttlMs: 1000, now: () => 100 });
    const { ticket } = store.create("npub1admin");

    expect(store.consume(ticket, "npub1admin")).toBe(true);
    expect(store.consume(ticket, "npub1admin")).toBe(false);
  });

  test("burns a ticket when consumed by the wrong npub", () => {
    const store = new TerminalTicketStore({ ttlMs: 1000, now: () => 100 });
    const { ticket } = store.create("npub1admin");

    expect(store.consume(ticket, "npub1other")).toBe(false);
    expect(store.consume(ticket, "npub1admin")).toBe(false);
  });

  test("expires tickets", () => {
    let now = 100;
    const store = new TerminalTicketStore({ ttlMs: 50, now: () => now });
    const { ticket } = store.create("npub1admin");
    now = 151;

    expect(store.consume(ticket, "npub1admin")).toBe(false);
  });

  test("revokes all outstanding tickets", () => {
    const store = new TerminalTicketStore({ ttlMs: 1000, now: () => 100 });
    const { ticket } = store.create("npub1admin");
    store.clear();
    expect(store.consume(ticket, "npub1admin")).toBe(false);
  });
});
