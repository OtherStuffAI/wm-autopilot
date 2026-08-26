import { isIP } from 'node:net';

import type { AgentProfileMediaStore } from '../agent-chat/agent-profile-media-store';

export const AGENT_PROFILE_MEDIA_PATH_PREFIX = '/media/agent-profiles/';

function isPrivateIpv4(hostname: string): boolean {
  const octets = hostname.split('.').map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return true;
  const [a, b] = octets;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)
    || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168)
    || (a === 100 && b! >= 64 && b! <= 127) || a! >= 224;
}

function isPrivateIpv6(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return normalized === '::' || normalized === '::1' || normalized.startsWith('fc')
    || normalized.startsWith('fd') || /^fe[89ab]/.test(normalized);
}

function isPublicHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!normalized || normalized === 'localhost' || normalized.endsWith('.localhost')) return false;
  if (normalized.endsWith('.invalid') || normalized.endsWith('.test') || normalized.endsWith('.example')) return false;
  if (['example.com', 'example.net', 'example.org'].includes(normalized)) return false;
  const ipVersion = isIP(normalized);
  if (ipVersion === 4) return !isPrivateIpv4(normalized);
  if (ipVersion === 6) return !isPrivateIpv6(normalized);
  return normalized.includes('.');
}

export function buildAgentProfileMediaPublicUrl(input: {
  baseUrl: string;
  baseUrlConfigured: boolean;
  digest: string;
}): string {
  if (!input.baseUrlConfigured) {
    throw new Error('Set an external WINGMAN_BASE_URL before publishing owned profile media.');
  }
  if (!/^[0-9a-f]{64}$/.test(input.digest)) throw new Error('Profile media digest is invalid.');
  let base: URL;
  try {
    base = new URL(input.baseUrl);
  } catch {
    throw new Error('WINGMAN_BASE_URL is not a valid public URL.');
  }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password
    || base.search || base.hash || !isPublicHostname(base.hostname)) {
    throw new Error('WINGMAN_BASE_URL must be an external HTTP(S) origin, not localhost, a private address, or a placeholder.');
  }
  return new URL(`${AGENT_PROFILE_MEDIA_PATH_PREFIX}${input.digest}`, base.origin).toString();
}

export function handleAgentProfileMediaPublicRoute(
  request: Request,
  url: URL,
  store: AgentProfileMediaStore,
): Response | null {
  if (!url.pathname.startsWith(AGENT_PROFILE_MEDIA_PATH_PREFIX)) return null;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
  }
  const digest = url.pathname.slice(AGENT_PROFILE_MEDIA_PATH_PREFIX.length);
  if (!/^[0-9a-f]{64}$/.test(digest)) return new Response('Not Found', { status: 404 });
  const media = store.get(digest);
  if (!media) return new Response('Not Found', { status: 404 });
  const headers = {
    'Content-Type': media.contentType,
    'Content-Length': String(media.size),
    'Cache-Control': 'public, max-age=31536000, immutable',
    'ETag': `"sha256-${media.digest}"`,
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'cross-origin',
  };
  return new Response(request.method === 'HEAD' ? null : media.bytes, { headers });
}
