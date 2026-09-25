export const PUBLIC_PROFILE_RELAYS = [
  "wss://purplepag.es",
  "wss://relay.damus.io",
  "wss://relay.primal.net",
  "wss://relay.snort.social",
] as const;

export const LOCAL_DEVELOPMENT_RELAY = "ws://127.0.0.1:4869";

export const DEFAULT_CONNECT_RELAYS = [
  ...PUBLIC_PROFILE_RELAYS,
  LOCAL_DEVELOPMENT_RELAY,
] as const;
