import { z } from "zod";

type Row = Record<string, any>;
export type PrivateReportRequest = (method: "GET" | "POST", path: string, body?: unknown) => Promise<Row>;
const boundContextSchema = z.object({
  workspace: z.object({ workspaceId: z.string().uuid(), backendBaseUrl: z.string().url(), sourceAppNpub: z.string().min(1) }),
  bot: z.object({ npub: z.string().min(1), available: z.literal(true) }),
});
export function requirePrivateReportContext(value: unknown) { return boundContextSchema.parse(value); }
export type PrivateReportContext = ReturnType<typeof requirePrivateReportContext>;
function root(context: PrivateReportContext) { return `/api/v4/flightdeck-pg/workspaces/${context.workspace.workspaceId}`; }
function ownDm(channel: Row, bot: string) {
  return channel.kind === "dm" && Array.isArray(channel.participant_npubs)
    && channel.participant_npubs.includes(bot) && !channel.archived_at;
}
function exactPair(channel: Row, bot: string, recipient: string) {
  return ownDm(channel, bot) && new Set(channel.participant_npubs).size === 2
    && channel.participant_npubs.length === 2 && channel.participant_npubs.includes(recipient);
}

/** List only channels whose authoritative participant list includes this bot. */
export async function listOwnPrivateConversations(context: PrivateReportContext, request: PrivateReportRequest) {
  const scopePage = await request("GET", `${root(context)}/scopes?limit=500`);
  if (!Array.isArray(scopePage.scopes) || scopePage.next_cursor !== null || scopePage.scopes.length >= 500) {
    throw new Error("Private conversation scope coverage is incomplete.");
  }
  const channels: Row[] = [];
  const dmScopes = scopePage.scopes.filter((scope: Row) => scope.kind === "dm");
  for (const scope of dmScopes) {
    const page = await request("GET", `${root(context)}/scopes/${scope.id}/channels?limit=500`);
    if (!Array.isArray(page.channels) || page.next_cursor !== null || page.channels.length >= 500) {
      throw new Error("Private conversation channel coverage is incomplete.");
    }
    channels.push(...page.channels.filter((channel: Row) => ownDm(channel, context.bot.npub)));
  }
  if (channels.length > 100) throw new Error("Private conversation count exceeds the bounded review budget.");
  return { channels, dmScopes };
}

async function messages(context: PrivateReportContext, channelId: string, request: PrivateReportRequest) {
  const result: Row[] = []; const seen = new Set<string>(); let cursor: string | null = null;
  for (let pageNumber = 0; pageNumber < 1000; pageNumber++) {
    const page = await request("GET", `${root(context)}/channels/${channelId}/messages?limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    if (!Array.isArray(page.messages) || page.channel_id !== channelId
      || page.cursor_semantics?.order !== "created_at ASC, id ASC" || page.next_cursor === undefined) {
      throw new Error("Private conversation history coverage is incomplete.");
    }
    result.push(...page.messages);
    if (result.length > 10_000) throw new Error("Private history exceeds the bounded message budget; coverage is incomplete.");
    if (page.next_cursor === null) return result;
    if (typeof page.next_cursor !== "string" || seen.has(page.next_cursor)) throw new Error("Private history cursor is invalid or repeated.");
    seen.add(page.next_cursor); cursor = page.next_cursor;
  }
  throw new Error("Private conversation history exceeded its bounded page budget.");
}

export async function readOwnPrivateHistory(context: PrivateReportContext, request: PrivateReportRequest, since: string, until: string) {
  const start = Date.parse(since); const end = Date.parse(until);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) throw new Error("An explicit valid review window is required.");
  if (end > Date.now()) throw new Error("Review window must end at or before the current time; future history cannot be reviewed.");
  const { channels } = await listOwnPrivateConversations(context, request);
  const conversations = [];
  for (const channel of channels) {
    const rows = await messages(context, channel.id, request);
    if (rows.some(row => !Number.isFinite(Date.parse(row.created_at)))) throw new Error("Private history has an invalid message timestamp.");
    conversations.push({ channelId: channel.id, participants: channel.participant_npubs,
      messages: rows.filter(row => Date.parse(row.created_at) >= start && Date.parse(row.created_at) < end) });
  }
  return { since, until, coverage: "Available Tower private channels containing this bot only; local-only sessions and other channels are not covered.", conversations };
}

/** Exact participant pair and stable client id; receipt readback, never prose, establishes delivery. */
export async function sendPrivateReport(context: PrivateReportContext, request: PrivateReportRequest, input: {
  recipient: string; body: string; clientRequestId: string; dryRun?: boolean;
}) {
  // Tower canonicalizes message text before validating its signature and saving it.
  input = { ...input, body: input.body.trim(), clientRequestId: input.clientRequestId.trim() };
  if (!input.recipient || input.recipient === context.bot.npub || !input.body.trim() || !input.clientRequestId.trim()) {
    throw new Error("Distinct exact recipient, report body and stable client request id are required.");
  }
  const { channels, dmScopes } = await listOwnPrivateConversations(context, request);
  const matches = channels.filter(channel => exactPair(channel, context.bot.npub, input.recipient));
  if (matches.length > 1) throw new Error("Private recipient pair is ambiguous.");
  let channel = matches[0];
  if (input.dryRun) return { delivered: false, dryRun: true, recipient: input.recipient, channelId: channel?.id ?? null,
    action: channel ? "use_exact_existing_pair" : "create_exact_private_pair" };
  if (!channel) {
    if (dmScopes.length !== 1) throw new Error("An exact DMs scope is required to create the private recipient pair.");
    const created = await request("POST", `${root(context)}/scopes/${dmScopes[0]!.id}/channels`, {
      kind: "dm", name: `DM: ${input.recipient}`, participant_npubs: [context.bot.npub, input.recipient],
    });
    channel = created.channel;
    if (!channel?.id || !exactPair(channel, context.bot.npub, input.recipient)) throw new Error("Created DM did not confirm the exact private recipient pair.");
  }
  const channelReadback = await request("GET", `${root(context)}/channels/${channel.id}`);
  if (!exactPair(channelReadback.channel ?? {}, context.bot.npub, input.recipient)) throw new Error("Private recipient readback failed.");
  const prior = (await messages(context, channel.id, request)).filter(row => row.client_request_id === input.clientRequestId);
  if (prior.length > 1) throw new Error("Duplicate report receipts require reconciliation.");
  if (!prior.length) await request("POST", `${root(context)}/channels/${channel.id}/messages`, {
    body: input.body, create_thread: true, client_request_id: input.clientRequestId,
  });
  const saved = (await messages(context, channel.id, request)).filter(row => row.client_request_id === input.clientRequestId);
  const message = saved[0];
  if (saved.length !== 1 || !message?.id || message.body !== input.body
    || message.sender_npub !== context.bot.npub) throw new Error("Private report delivery is unverified; reconcile before retrying.");
  return { delivered: true, channelId: channel.id, messageId: message.id, recipient: input.recipient,
    clientRequestId: input.clientRequestId, reused: prior.length === 1 };
}

/** Select the most recent completed daily interval, never the next boundary. */
export function completedDailyReportWindow(boundaryHourUtc: number, now = Date.now()) {
  if (!Number.isInteger(boundaryHourUtc) || boundaryHourUtc < 0 || boundaryHourUtc > 23 || !Number.isFinite(now)) {
    throw new Error("An explicit UTC boundary hour from 0 through 23 and valid current time are required.");
  }
  const day = 24 * 60 * 60 * 1000;
  const offset = boundaryHourUtc * 60 * 60 * 1000;
  const end = Math.floor((now - offset) / day) * day + offset;
  return { since: new Date(end - day).toISOString(), until: new Date(end).toISOString(), reportDate: new Date(end).toISOString().slice(0, 10) };
}
