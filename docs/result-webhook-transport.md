# Pinned result webhook transport

Result callbacks validate HTTPS port 443 URLs and all DNS answers on each attempt,
then send to one approved address using curl `--resolve`. The URL stays unchanged:
curl uses its original hostname for SNI, certificate identity and HTTP Host.
Literal-IP URLs already pin their destination and require a certificate for that IP.
There is no unpinned fallback, proxy, redirect following, or certificate bypass.

## Runtime dependency

Install curl 8.4 or newer with HTTPS/TLS and IPv6 support on the Autopilot host and
make `curl` available on PATH. macOS supplies curl; Linux/container images must
install their distribution's curl and CA certificates packages; Windows requires
curl.exe on PATH and its configured trust store. The helper uses the OS null device.
Version 8.4 or newer bounds even response bodies whose length is unknown in advance.
The helper checks the curl version before its first transfer. Missing/older curl
or transport failures surface as delivery failures with a numeric
curl exit code; they do not silently switch transport. Exit 60 denotes certificate
verification failure, 28 denotes timeout, and 63 denotes the response size limit.

The tested runtime is Bun 1.3.0 (b0a6feca), macOS curl 8.7.1 using SecureTransport.
A Linux Bun 1.2.23 container without curl was also tested: the dependency fails
explicitly before delivery. Successful Linux and Windows TLS transport is not
claimed; install the required curl and run the same regression suite there.

Bun's node:https custom lookup on that version can attempt a loopback connection
but fails the real public pinned HTTPS request. A direct-IP node:https request's
servername option also does not establish correct hostname rejection there.
Current [Bun fetch docs](https://bun.sh/docs/runtime/networking/fetch) describe
newer IP/TLS controls; this implementation does not assume those work on 1.3.0.
See the official [curl options](https://curl.se/docs/manpage.html) for resolve,
config, max-time and max-filesize.

## Bounds and credentials

The only child argv is `curl -q --config -`. The first `-q` disables curlrc loading.
Signed headers and payload travel through bounded stdin configuration, with
escaped values and rejected header control characters. `data-raw` preserves the
body without interpreting a leading `@` as a local filename. Request bodies are
limited to 1 MiB, total configuration to 8 MiB, and response bodies to 64 KiB.
Responses go to the null device; stdout contains only the three-digit HTTP status.
Diagnostics are drained without logging caller data. TLS uses curl's default
certificate verification and host trust configuration.

DNS has a five-second bound. Transfer/connect timeout is ten seconds, with an
independent eleven-second child kill deadline for a stuck helper. Retries retain
the existing immutable body, run/delivery IDs, fresh signature and five-attempt
policy. A failed/exhausted delivery is not automatically reset by this change.

## Validation and activation

Run `bun test ./src/pipelines/result-webhooks.test.ts`, `bun run typecheck`, and
`git diff --check`. The test needs openssl supporting `req -addext` and curl. It
creates a disposable local TLS receiver and trusts its test certificate only in
the test child environment. It verifies the exact signed JSON/body hash, approved
IP connection, redirect refusal, trusted-cert hostname mismatch, untrusted-cert
rejection before HTTP, oversized response failure and stalled-response deadline.
SSRF, per-attempt DNS validation and durable retry/signature regressions remain.

Source tests and a public receiver's HTTP 401 demonstrate transport, not live
core activation or accepted signed delivery. After review, an operator must
activate source from outside managed sessions with explicit restart authorization.
Do not restart Autopilot from an agent session. After activation, use an explicitly
approved delivery-only recovery or a fresh authorized test request with durable
mapping; do not replay a participant instruction or reset delivery records by hand.
