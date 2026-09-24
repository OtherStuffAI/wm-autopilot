import { describe, expect, test } from "bun:test";
import {
  configureFlightDeckPipelineInvocation,
  normalizeFlightDeckPipelineInvocation,
  resolveFlightDeckPipelineInvocation,
  returnPipelineMarkdownToFlightDeckThread,
} from "./flightdeck-invocation";

const valid = {
  workspaceId: "2e5caefd-dd65-45d2-b747-ee874e8e5fc9",
  threadId: "c87e026d-23c5-4fe9-b752-117f18cf4a10",
  frmNpub: "npub1requester",
  prompt: " Ask the council. ",
};

describe("Flight Deck pipeline invocation", () => {
  test("normalizes the four domain fields", () => {
    expect(normalizeFlightDeckPipelineInvocation(valid)).toEqual(valid);
  });

  test("rejects missing, malformed, and extra invocation fields", async () => {
    expect(() => normalizeFlightDeckPipelineInvocation({ ...valid, prompt: "" })).toThrow("prompt is required");
    expect(() => normalizeFlightDeckPipelineInvocation({ ...valid, workspaceId: "workspace" })).toThrow("workspaceId must be a UUID");
    expect(() => normalizeFlightDeckPipelineInvocation({ ...valid, frmNpub: "hex" })).toThrow("frmNpub must be an npub");
    await expect(resolveFlightDeckPipelineInvocation({ ...valid, signerNpub: valid.frmNpub })).rejects.toThrow("Unexpected");
  });

  test("keeps requester context separate from the configured sender", async () => {
    configureFlightDeckPipelineInvocation({
      resolve: async (input) => ({ ...input, channelId: "channel-1", senderNpub: "npub1managed" }),
      send: async (input) => ({ delivered: true, requesterNpub: input.frmNpub, senderNpub: "npub1managed" }),
    });
    const result = await returnPipelineMarkdownToFlightDeckThread({ ...valid, message: "# Answer" });
    expect(result).toMatchObject({ delivered: true, requesterNpub: "npub1requester", senderNpub: "npub1managed" });
  });
});
