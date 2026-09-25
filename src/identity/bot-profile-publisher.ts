import {
  publishToRelays,
  queryRelays,
  type PublishOptions,
  type RelayResult,
  type SignedEvent,
} from '../ngit/relay-publisher';
import { generateBotWordId } from './bot-word-id';
import { parseRelays, validateSignedEventFields } from './nostr-event-utils';

interface BotProfileStatusRequest {
  botPubkeyHex: string;
  requestedRelays?: unknown;
  defaultRelays: string[];
}

interface BotProfilePublishRequest extends BotProfileStatusRequest {
  signedEvent: unknown;
  publishOptions?: PublishOptions;
  readbackOptions?: {
    delaysMs?: number[];
    queryTimeoutMs?: number;
    query?: typeof queryRelays;
  };
}

export interface ProfileRelayResult extends RelayResult {
  public: boolean;
  readback: 'readable' | 'absent' | 'not_attempted';
  readbackAttempts: number;
}

export interface BotProfilePublicationResult {
  eventId: string;
  relays: string[];
  successes: number;
  failures: number;
  durable: boolean;
  results: ProfileRelayResult[];
}

export class ProfilePublicationError extends Error {
  constructor(message: string, readonly publication: BotProfilePublicationResult) {
    super(message);
    this.name = 'ProfilePublicationError';
  }
}

const DEFAULT_READBACK_DELAYS_MS = [0, 250, 750, 1_500];
const DEFAULT_READBACK_QUERY_TIMEOUT_MS = 2_000;

function isPublicRelay(relay: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(relay).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return false;
  }
  if (hostname === 'localhost' || hostname === '::1' || hostname.endsWith('.local')) return false;
  const octets = hostname.split('.').map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return true;
  }
  return !(octets[0] === 10
    || octets[0] === 127
    || (octets[0] === 169 && octets[1] === 254)
    || (octets[0] === 172 && (octets[1] ?? 0) >= 16 && (octets[1] ?? 0) <= 31)
    || (octets[0] === 192 && octets[1] === 168));
}

async function wait(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function verifyRelayReadback(
  relay: string,
  eventId: string,
  options: NonNullable<BotProfilePublishRequest['readbackOptions']>,
): Promise<{ readback: 'readable' | 'absent'; readbackAttempts: number }> {
  const delays = options.delaysMs ?? DEFAULT_READBACK_DELAYS_MS;
  const query = options.query ?? queryRelays;
  for (let index = 0; index < delays.length; index += 1) {
    await wait(delays[index] ?? 0);
    try {
      const events = await query([relay], { ids: [eventId], limit: 1 }, options.queryTimeoutMs ?? DEFAULT_READBACK_QUERY_TIMEOUT_MS);
      if (events.some((event) => event.id === eventId)) {
        return { readback: 'readable', readbackAttempts: index + 1 };
      }
    } catch {
      // A bounded failed query is evidence of absent readback for this attempt.
    }
  }
  return { readback: 'absent', readbackAttempts: delays.length };
}

function validateSignedBotProfileEvent(input: unknown, expectedPubkeyHex: string): SignedEvent {
  if (!input || typeof input !== 'object') {
    throw new Error('signedEvent must be an object');
  }

  const event = input as Partial<SignedEvent>;
  if (event.kind !== 0) {
    throw new Error('signedEvent.kind must be 0');
  }

  return validateSignedEventFields(input, expectedPubkeyHex, 'the active bot');
}

export function buildBotProfileAlias(botPubkeyHex: string): string {
  return `${generateBotWordId(botPubkeyHex)}-bot`;
}

export async function getBotProfileStatus(request: BotProfileStatusRequest) {
  const relays = parseRelays(request.requestedRelays, request.defaultRelays);

  if (relays.length === 0) {
    return {
      exists: false,
      relays,
      latestEventId: null,
      suggestedName: buildBotProfileAlias(request.botPubkeyHex),
    };
  }

  const events = await queryRelays(relays, {
    kinds: [0],
    authors: [request.botPubkeyHex],
    limit: 1,
  });

  return {
    exists: events.length > 0,
    relays,
    latestEventId: events[0]?.id ?? null,
    suggestedName: buildBotProfileAlias(request.botPubkeyHex),
  };
}

export async function publishBotProfileEvent(request: BotProfilePublishRequest) {
  const relays = parseRelays(request.requestedRelays, request.defaultRelays);
  if (relays.length === 0) {
    throw new Error('No relays available for publishing');
  }

  const signedEvent = validateSignedBotProfileEvent(request.signedEvent, request.botPubkeyHex);
  const result = await publishToRelays(signedEvent, relays, request.publishOptions);
  if (result.successes === 0) {
    const relayErrors = result.results
      .map((entry) => `${entry.relay}: ${entry.error || 'rejected'}`)
      .join('; ');
    const publication: BotProfilePublicationResult = {
      eventId: signedEvent.id,
      relays,
      successes: 0,
      failures: result.failures,
      durable: false,
      results: result.results.map((entry) => ({
        ...entry,
        public: isPublicRelay(entry.relay),
        readback: 'not_attempted',
        readbackAttempts: 0,
      })),
    };
    throw new ProfilePublicationError(
      `No relay accepted the bot profile event${relayErrors ? ` (${relayErrors})` : ''}`,
      publication,
    );
  }

  const results: ProfileRelayResult[] = await Promise.all(result.results.map(async (entry) => {
    const publicRelay = isPublicRelay(entry.relay);
    if (!entry.ok || !publicRelay) {
      return { ...entry, public: publicRelay, readback: 'not_attempted', readbackAttempts: 0 };
    }
    const readback = await verifyRelayReadback(entry.relay, signedEvent.id, request.readbackOptions ?? {});
    return { ...entry, public: true, ...readback };
  }));
  const publication: BotProfilePublicationResult = {
    eventId: signedEvent.id,
    relays,
    successes: result.successes,
    failures: result.failures,
    durable: results.some((entry) => entry.public && entry.ok && entry.readback === 'readable'),
    results,
  };
  if (!publication.durable) {
    throw new ProfilePublicationError(
      'No configured public relay both accepted and exposed the bot profile event',
      publication,
    );
  }
  return publication;
}
