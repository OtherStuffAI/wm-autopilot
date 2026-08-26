# Durable agent profile media

Autopilot can own the raster image referenced by an agent's Nostr kind-0 profile. The Agent Profile create/edit forms retain the compatibility URL field and also accept a JPEG, PNG, or static WebP file up to 5 MB.

The authenticated import endpoint is:

```text
POST /api/agent-chat/profiles/:profileId/media
Content-Type: multipart/form-data

file=<required image file>
profile=<optional JSON profile update>
```

It uses the same Agent Profile management authorization as other profile mutations. The server verifies the bytes and declared MIME type, stores them content-addressed in `data/agent-profile-media.db`, publishes the owned URL with the existing stable agent signer, then updates the local profile. If relay publication fails, the verified bytes remain locally available for retry but the stored profile URL is unchanged.

Public reads use `GET` or `HEAD /media/agent-profiles/:sha256`. They are intentionally unauthenticated so ordinary Nostr clients can load kind-0 pictures. Responses use the verified media type, immutable caching, and `X-Content-Type-Options: nosniff`.

Owned media publication requires an explicitly configured external `WINGMAN_BASE_URL`. Localhost, private IPs, single-label hostnames, and reserved placeholder domains are rejected; the request `Host` header is never used.

Operator import is available in **Settings → Agent Profiles → Edit Agent Profile → Owned profile image**. A successful result explicitly reports both **saved locally** and **published to relays**. Selecting no file leaves the compatibility URL behavior unchanged and does not claim that externally hosted bytes are local.
