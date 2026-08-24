/**
 * Shared types for the Wingman MCP NIP-98 signing system.
 *
 * Two-tier authorization:
 *   Tier 1 – Wingman signs with its instance key (WINGMAN_PRIV).
 *   Tier 2 – User delegates signing via browser (ephemeral key or NIP-07).
 */

// ---------------------------------------------------------------------------
// NIP-98 signing
// ---------------------------------------------------------------------------

export interface SignNip98Request {
  /** Agent session ID (from SESSION_ID env var). */
  sessionId: string;
  /** Full URL to sign for. */
  url: string;
  /** HTTP method (GET, POST, PUT, DELETE …). */
  method: string;
  /** SHA-256 hex hash of request body (required for POST/PUT). */
  bodyHash?: string;
  /** 1 = Wingman identity, 2 = user delegation. Defaults to 1. */
  tier?: 1 | 2;
}

export interface SignNip98Response {
  /** Base64-encoded signed NIP-98 event for the Authorization header. */
  token: string;
  /** The npub that signed this token. */
  signedBy: string;
}

// ---------------------------------------------------------------------------
// Grants (Tier 2 – user delegation)
// ---------------------------------------------------------------------------

export type SignerType = 'ephemeral' | 'nip07';

export interface Nip98Grant {
  id: string;
  /** Target API domain, e.g. "api.example.invalid". */
  domain: string;
  /** Nostr npub of the user who granted access. */
  userNpub: string;
  /** Restrict to a specific session, or null for any session owned by the user. */
  sessionId: string | null;
  /** How the browser will sign events for this grant. */
  signerType: SignerType;
  /** Unix timestamp (ms) when the grant was created. */
  grantedAt: number;
  /** Unix timestamp (ms) when the grant expires. */
  expiresAt: number;
  /** Human-readable reason the agent gave for needing access. */
  reason: string;
  /** Optional endpoint restrictions. Null = full domain access. */
  endpoints: EndpointPattern[] | null;
}

export interface EndpointPattern {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | '*';
  pathPattern: string;
}

// ---------------------------------------------------------------------------
// Grant request / consent flow
// ---------------------------------------------------------------------------

export interface GrantRequest {
  sessionId: string;
  domain: string;
  reason: string;
  durationHours?: number;
  endpoints?: EndpointPattern[];
}

export interface GrantRequestResult {
  /** Whether the grant was approved. */
  granted: boolean;
  /** The grant ID if approved. */
  grantId?: string;
  /** Error message if denied or failed. */
  error?: string;
}

// ---------------------------------------------------------------------------
// NIP-98 support detection
// ---------------------------------------------------------------------------

export interface Nip98SupportResult {
  supported: boolean;
  /** OpenAPI security scheme if found via Swagger. */
  securityScheme?: Record<string, unknown>;
  /** Whether WWW-Authenticate header mentions Nostr. */
  wwwAuthenticate?: boolean;
}

// ---------------------------------------------------------------------------
// WebSocket / SSE messages for browser consent flow
// ---------------------------------------------------------------------------

export interface ConsentRequestMessage {
  type: 'nip98:consent_request';
  requestId: string;
  domain: string;
  endpoints?: EndpointPattern[];
  durationHours: number;
  reason: string;
  sessionId: string;
  agentType: string;
}

export interface ConsentResponseMessage {
  type: 'nip98:consent_response';
  requestId: string;
  approved: boolean;
  grantId?: string;
  signerType?: SignerType;
}

export interface SignRequestMessage {
  type: 'nip98:sign_request';
  requestId: string;
  grantId: string;
  eventTemplate: {
    kind: 27235;
    created_at: number;
    tags: string[][];
    content: string;
  };
}

export interface SignResponseMessage {
  type: 'nip98:sign_response';
  requestId: string;
  signedEvent?: Record<string, unknown>;
  error?: string;
}

// ---------------------------------------------------------------------------
// Generic Nostr event signing (used by ngit / NIP-34)
// ---------------------------------------------------------------------------

export interface NostrSignRequestMessage {
  type: 'nostr:sign_request';
  requestId: string;
  grantId: string;
  /** Human-readable description of what is being signed. */
  description: string;
  eventTemplate: {
    kind: number;
    created_at: number;
    tags: string[][];
    content: string;
  };
}
