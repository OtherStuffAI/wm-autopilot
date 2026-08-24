# Agent Instruction Signatures

Flight Deck PG chat messages can cause Autopilot to run agent pipelines. Treat
that path as an execution boundary.

Autopilot must not act on a PG chat message unless Tower returns
`metadata.agent_instruction_signature` and the signature verifies locally. The
signature wrapper contains:

- `version: 1`
- `protocol: "flightdeck_pg_message_instruction"`
- `kind: 33358`
- `signer_npub`
- `body_sha256`
- `nostr_event`

The nested Nostr event must be kind `33358`, must include the protocol,
`body_sha256`, `workspace_id`, and `channel_id` tags, and its `content` must be
the exact message body. Thread replies also include `thread_id`.

Autopilot verifies:

1. the Nostr event signature is valid;
2. the event content exactly matches the message body returned by Tower;
3. the body hash in the wrapper and event tag matches the body;
4. the signer npub matches the Tower actor npub;
5. workspace, channel, and thread tags match the event context.

If any check fails, Autopilot records
`chat_skip_invalid_instruction_signature` and does not evaluate dispatch routes.
This protects the written-instruction-to-agent-action path from unsigned
messages, forged actors, and body tampering.
