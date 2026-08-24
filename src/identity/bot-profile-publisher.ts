import { publishToRelays, queryRelays, type SignedEvent } from '../ngit/relay-publisher';
import { generateBotWordId } from './bot-word-id';
import { parseRelays, validateSignedEventFields } from './nostr-event-utils';

interface BotProfileStatusRequest {
  botPubkeyHex: string;
  requestedRelays?: unknown;
  defaultRelays: string[];
}

interface BotProfilePublishRequest extends BotProfileStatusRequest {
  signedEvent: unknown;
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
  const result = await publishToRelays(signedEvent, relays);
  if (result.successes === 0) {
    const relayErrors = result.results
      .map((entry) => `${entry.relay}: ${entry.error || 'rejected'}`)
      .join('; ');
    throw new Error(`No relay accepted the bot profile event${relayErrors ? ` (${relayErrors})` : ''}`);
  }

  return {
    eventId: signedEvent.id,
    relays,
    ...result,
  };
}
