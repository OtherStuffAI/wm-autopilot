# White Noise discovery for externally signed accounts

A running connector and an accepted KeyPackage publication do not establish
phone discovery. Verify the client's discovery relay list, the advertised
account relays, and the retrieved package independently before requesting a
phone retry. Keep relay URLs, device records and run evidence in ignored
`tmp/docs/handoffs/`; do not put them in this document.

## Identify the client protocol

The former Flutter app and native iOS app have different discovery contracts.
The screenshot text alone is not a library error code: native iOS maps
`MissingKeyPackage`, `InvalidKeyPackageEvent` and post-resolution
`InvalidIdentity` to the same invitation prompt.

| Client source | Package lookup | Compatibility checks |
| --- | --- | --- |
| Flutter `v2026.5.22+25`, pinned whitenoise-rs `062a6b4` | Kinds 30443 and 443; relay lists 10051, then 10002, then discovery relays | Baseline requires `encoding=base64`, ciphersuite `0x0001`, and extension `0xf2ee` |
| Native iOS `v2026.9.29`, MarmotKit 0.11.0 | Kind 10002 discovers outbox relays; kind 10050 discovers inbox; kind 30443 carries the package | Current profile account proof, MLS validation, lifetime, author/credential identity, package reference and advertised capabilities must match |
| Native iOS source pinned to MarmotKit 0.12.0 | Same current discovery/package contract | The package publisher explicitly omits the legacy `encoding` tag; there is no dedicated kind-10051 list |

Sources: [Flutter release dependency](https://github.com/marmot-protocol/whitenoise/blob/2c16c5b0b384d52c660fbdea11922aceeb01ff74/rust/Cargo.toml),
[whitenoise-rs baseline validator](https://github.com/marmot-protocol/whitenoise-rs/blob/062a6b4b7b0bf2a9d7f81c6154b49667643ad516/src/whitenoise/key_packages.rs),
[native invitation error mapping](https://github.com/marmot-protocol/whitenoise-ios/blob/7944afab7ea81597382db4527b509a99eb23a8d9/whitenoise-ios/Recipients/DirectChatStarter.swift),
[native release SDK provenance](https://github.com/marmot-protocol/whitenoise-ios/blob/7944afab7ea81597382db4527b509a99eb23a8d9/Packages/MarmotKit/MARMOT_VERSION),
[current package decoder](https://github.com/marmot-protocol/mdk/blob/946e0547485c9a2c393c2048ec3a968fd50fb441/crates/marmot-app/src/key_package_records.rs),
and [current publisher](https://github.com/marmot-protocol/mdk/blob/122bd90ffac60bb6311346e228d0f609a18521ee/crates/transport-nostr-adapter/src/key_package.rs).

Do not relabel a current package with legacy capability tags. Its MLS bytes and
account proof must actually implement the advertised profile. A change of event
kind alone does not provide protocol interoperability. Review any additional
signing kind or policy expansion with the manager before publishing.

## Verify the discovery chain

1. Resolve the installed app build and its pinned SDK. Use the native platform
   source when the UI matches that client; the obsolete Flutter landing page
   points to the current platform repositories.
2. Query the client's discovery targets for the exact account's kind-10002 and
   kind-10050 events. Validate their canonical IDs and Schnorr signatures. An
   inbox hint in an `nprofile` is not evidence that the native outbox-discovery
   query will retrieve those lists.
3. Follow the retrieved kind-10002 `r` tags to query kind 30443 for that account.
   Validate the retrieved event and decode its MLS bytes. Check current lifetime,
   account proof, credential identity, `i` reference and capability tags using
   the matching SDK. Kind 10050 uses `relay` tags for Welcome delivery.
4. Require completed reads with the actual expected events. `OK` publication
   acknowledgements, duplicate acknowledgements, connection counts and local
   readiness are insufficient. A `CLOSED` response is not an empty result;
   retain the reason privately and stop that subscription. After two blocked
   attempts, reduce the probe, for example to one kind and one author.

All probes must retain the host-safety discipline: reject retired hosts and
non-public DNS addresses, pin a validated address, verify TLS against the
configured hostname and use bounded requests. Never authenticate a relay by
expanding the grant implicitly.

## Repair metadata visibility without changing relay roles

Discovery targets and advertised account/inbox relays serve different purposes.
When the current signed relay lists are not retrievable through the native
discovery path, the narrow repair can be fanout of those **exact existing signed
events** to the intended discovery targets. Verify their signatures before
fanout and verify identical event fields through fresh independent reads
afterward. This does not require changing the advertised lists, generating a
KeyPackage, signing another kind, replacing an account or rerunning bootstrap.

Use the supported runtime bootstrap/discovery publication surface for ongoing
configuration where available. If the connector cannot express discovery
targets separately from advertised relay roles, hand that product gap to the
owning repository. Do not append discovery URLs to an already bounded grant's
advertised list merely to force fanout, and do not run a second process against
the managed connector's account home.

Once both discovery hops are independently verified, the native profile's
**Retry** action repeats direct-chat creation with the saved recipient. Ask for
one Retry on the existing profile, without re-adding it or using Share Invite.
The latter shares an application download invitation, not an authenticated MLS
Welcome. Confirm phone chat creation and an authenticated allowed-sender
conversation separately before sending or claiming delivery.
