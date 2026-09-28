# Persistent bot Cashu wallets

Autopilot owns wallet custody and execution. Each canonical stable bot npub maps
to its own local Coco SQLite database and randomly generated BIP-39 seed. Tower
and Flight Deck coordinate work; neither stores wallet secrets or proofs. Bot
key rotation creates a different wallet identity: funds do not automatically
follow a new npub, owner or session. The operator must explicitly arrange any
transfer. Sessions and ordinary Autopilot restarts do not recreate wallets.

There is no application balance ceiling. Mint limits and Coco/Cashu amount
support still apply. Amounts are decimal integers in the wallet's immutable
`sat` or `msat` unit; balances serialize as strings without Number rounding.
Broker operation budgets are safe integer **millisatoshis**, independently of
wallet balance. Other currencies, amountless Lightning invoices, mint-auth
configuration, agent bearer-token exports and agent token transfers are outside
this release. Operator token transfers are supported.

## Setup and ownership

Use Bun and `bun install --frozen-lockfile`. Dependencies are pinned to
`@cashu/coco-core` and `@cashu/coco-sqlite-bun` 2.0.0. Coco currently depends on
Cashu TS 5.0.0-rc.4; upgrades require rerunning wallet and broker tests. The
implementation uses the maintained [Coco APIs](https://cashubtc.github.io/coco/starting/start-here.html)
and [Bun adapter](https://github.com/cashubtc/coco/tree/master/packages).

Run the operator CLI from an external operator shell. It rejects managed agent
session environments. Agents use `clis/wingman-capability.ts wallet` instead.
The default root is this checkout's `data/bot-wallets` irrespective of shell
working directory. To override it, set `WINGMAN_WALLET_DIR` to the same absolute
persistent directory in the operator shell and Autopilot control process. Mount
that directory on persistent storage in containers. No live funds or mint trust
are configured automatically.

```sh
bun clis/cashu-wallet.ts help
bun clis/cashu-wallet.ts create --bot <stable-bot-npub> --unit sat
bun clis/cashu-wallet.ts open --bot <stable-bot-npub>
bun clis/cashu-wallet.ts trust --bot <stable-bot-npub> --mint https://mint.example
bun clis/cashu-wallet.ts mints --bot <stable-bot-npub>
bun clis/cashu-wallet.ts balance --bot <stable-bot-npub>
bun clis/cashu-wallet.ts pending --bot <stable-bot-npub>
```

Replace placeholders; the example domain is not a mint recommendation. Explicit
trust is required for funding, receiving, sending, payment and seed scanning.
Only HTTPS mint URLs without credentials/query/fragment are accepted. Use
`untrust --mint <url>` to disable a mint without deleting its existing funds.
Trust involves accepting the mint's custody, solvency and availability risk;
Cashu is not a self-custodial on-chain wallet.

Directories are mode 0700 and files 0600. The root `master.key` encrypts each
wallet seed with Noble AES-GCM and binds it to npub/unit/version. Each bot
folder contains `wallet.json`, `wallet.sqlite`, optional `grant.json`, and a
short-lived `wallet.lock`. SQLite persists mint keys, deterministic counters,
proofs, quotes, operation recovery material and any Coco-managed auth state.
Proofs and the SQLite database are **not encrypted at rest**. Protect the whole
root with encrypted disks and access controls, and keep backups encrypted.
Never copy these files, bearer token files or the master key to prompts, agent
environments, tracked docs, source control, routine logs or task comments.

The control process and operator are trusted custodians. This release shares
the existing broker's same-process/OS-user boundary: a hostile agent with the
same unrestricted filesystem privileges could bypass CLI checks and read wallet
files. Private modes, CLI checks and environment sanitizing prevent routine
secret propagation, not hostile same-user access. Large-balance installations
requiring that isolation must separate agent OS permissions from custody before
activation. There is no claim of a hardware wallet or separate wallet daemon.

## Funding, tokens and Lightning

```sh
bun clis/cashu-wallet.ts fund-quote --bot <npub> --mint https://mint.example --amount 1000
bun clis/cashu-wallet.ts fund-check --bot <npub> --mint https://mint.example --quote <quote-id>
bun clis/cashu-wallet.ts mint --bot <npub> --mint https://mint.example --quote <quote-id>

bun clis/cashu-wallet.ts transfer-to-bot --bot <sender-npub> --to-bot <recipient-npub> --mint https://mint.example --amount 100
bun clis/cashu-wallet.ts transfer-resume --bot <sender-npub> --id <transfer-id>

bun clis/cashu-wallet.ts send --bot <sender-npub> --mint https://mint.example --amount 100 --token-out /private/new-token.cashu
bun clis/cashu-wallet.ts receive --bot <recipient-npub> --token-file /private/new-token.cashu
bun clis/cashu-wallet.ts check --bot <sender-npub> --kind send --id <send-operation-id>

bun clis/cashu-wallet.ts pay --bot <npub> --mint https://mint.example --invoice-file /private/invoice.txt --max-msats 105000
bun clis/cashu-wallet.ts check --bot <npub> --kind melt --id <payment-operation-id>
```

`fund-quote` prints a Lightning funding invoice and durable quote ID. It does
not pay the invoice. `mint` prepares/executes or resumes the stored mint
operation after payment. Keep quote IDs and operation IDs for reconciliation.
Funding and payment use BOLT11. Mint support for the configured unit is required.
`pay` creates and prepares the payment, validates the mint amount/unit, and
requires `--max-msats` to cover the verified maximum input value including fees
and potentially withheld change. Insufficient maxima cancel the prepared
operation before execution.

`send` creates a new 0600 output file before executing; bearer tokens are never
printed. `receive` requires a private regular token file and the same unit as
the recipient wallet, persists a receive operation and swaps proofs into the
recipient's custody. Tokens are cash: sending/exporting a file does not prove
redemption. Use `check` or `sync` to reconcile. `token-export --id <send-id>
--token-out <new-path>` recovers the persisted outgoing token if writing its
original file failed. It exports the same token, not new funds. It can still
export a previously redeemed token; check state before using it. Never share a
token in agent chat. Remove unneeded token files through an operator's secure
storage policy after confirming redemption.

`transfer-to-bot` is the simpler same-machine operator path: both wallets must
already exist, use the same unit, and trust the mint. It locks both wallets before
preparing a send, persists a transfer journal, and redeems the persisted token
into the recipient without exporting it to a file or stdout. Output gives only
transfer/send/receive IDs and public summaries. Mint fees can reduce the amount
credited to the recipient. A failure does not make the transfer atomic across
mints or databases; `pending` on the sender lists its durable transfer journal.
Use `transfer-resume --id <transfer-id>` to reconcile that journal. Resume reuses
the exact persisted send and recipient receive; it never blindly creates a new
payment after an uncertain response. If a crash happened before the sender
operation ID was journaled, it identifies the new matching operation relative
to the recorded pre-operation IDs and refuses ambiguous matches. Avoid unrelated
source-wallet mutations until the pending transfer is resolved. Missing or
inconsistent operations require operator inspection. Back up **both** wallets
after resolving transfers; restoring one wallet's stale snapshot cannot recreate
the other wallet's received proofs. This command is operator-only; brokered
agent transfers are not granted in this release.

Routine JSON includes balance, public mint/unit, quote/operation identifiers,
state and fee/amount summaries. It excludes seeds, proof secrets, token content,
auth credentials, preimages and raw mint error details. A failed network command
prints a generic diagnostic because upstream exceptions can contain secret
payloads. Inspect `pending` and `check` before retrying a payment; do not assume
an error means that no funds moved. A pending quote alone is not a payment.

## Agent grants and spend enforcement

No wallet methods are granted by default, including in Full Agent signing mode.
An operator supplies a per-bot policy file:

```json
{
  "readMethods": ["get_balance", "get_pending", "get_payment"],
  "spendMethods": ["pay_invoice"],
  "maxSpendMsats": 100000,
  "maxTotalSpendMsats": 500000
}
```

```sh
bun clis/cashu-wallet.ts grant --bot <npub> --policy-file /private/wallet-policy.json
```

The issuer applies that bot's explicit grant when issuing a **new or explicitly
reissued** session capability. Changing the grant does not rewrite already issued
capabilities. Revoke/reissue existing sessions through the existing authenticated
capability administration surface when changing permissions. To disable new
wallet grants, save empty read/spend lists and zero budgets. This release adds no
wallet grant editor to Flight Deck or Tower.

Agents can then use their bound wallet:

```sh
bun clis/wingman-capability.ts wallet --method get_balance
bun clis/wingman-capability.ts wallet --method get_pending
bun clis/wingman-capability.ts wallet --method get_payment --params-json '{"operationId":"<id>"}'
bun clis/wingman-capability.ts wallet --method pay_invoice --amount-msats 100000 --params-json '{"mint":"https://mint.example","invoice":"<bolt11>"}'
```

`amountMsats` is a maximum acceptable charge, not a trusted invoice amount.
Method classification decides `wallet.read` versus `wallet.spend`; zero or
omitted amounts cannot turn a payment into a read. The broker binds all wallet
access to the capability's stable bot, ignoring any requested foreign bot.
The adapter prepares an operation under the bot's cross-process lock and obtains
an absolute upper bound from Coco's reserved **input proof value**. This includes
Lightning fee reserve, proof input/swap fees and possible withheld change.
The broker verifies that bound against request maximum, per-operation budget
and cumulative session budget, then persists the reservation before execution.
Authorization is rechecked after preparation. CLI and broker accesses cannot
mutate the same wallet concurrently. Contention fails visibly; retry after the
current command finishes.

Every capability for a session shares its cumulative total; refresh/reissue
cannot reset it. The verifier store preserves reservations across ordinary
broker restarts. Finalized payment responses report Coco's actual amount plus
`effectiveFee` when available, and the reserved bound separately. Conservative
reservations are **not refunded**, even for returned change, later reconciliation
or ambiguous errors. This can exhaust a session budget earlier than actual
spending; obtain a new explicitly budgeted session after operator review.
Operator CLI spending is outside agent session budgets and must not run while
an agent expects exclusive operational control. `get_payment` reads local
state; only explicit operator `check`/`recover` contacts the mint to reconcile.

## Backup and recovery

```sh
bun clis/cashu-wallet.ts backup --bot <npub> --out /private/new-wallet-backup
bun clis/cashu-wallet.ts sync --bot <npub>
bun clis/cashu-wallet.ts recover --bot <npub>
bun clis/cashu-wallet.ts restore --bot <npub> --mint https://mint.example
```

`backup` takes the same exclusive wallet lock and copies the committed SQLite
database, encrypted seed configuration, optional grant and shared master key to
a **new** private directory. SQLite uses DELETE journaling and FULL synchronous
commits; never make an ad-hoc live copy of just the DB. Encrypt and securely
store the entire backup. It contains spendable bearer proofs and a decryption
key, so mode 0600 alone is not encrypted backup protection. The generated seed
is not exported as a mnemonic; there is no mnemonic import ceremony in this
release. A seed is not a complete operation/proof backup.

To test/restore a backup, use an unused private root with the copied
`master.key` and `<npub>/wallet.json` plus `<npub>/wallet.sqlite`, and point
`WINGMAN_WALLET_DIR` at it. `open` validates npub/unit and decryptability.
Then explicitly `recover`, inspect operation states, and `restore` at each known
trusted mint if needed. A backup directory itself has this layout and can be
opened directly. **Do not operate the original and restored copy at the same
time**: their deterministic counters/seed can collide. Do not overwrite a live
root, replace a different master key, or import a snapshot under a different
npub. Restoring one backup's master key over another installation's root can
make every other bot seed unreadable. Retain the original safely until recovery
is verified. Master-key loss or encrypted-seed loss cannot be repaired by the
CLI. Missing required state fails visibly instead of creating an empty wallet.

Coco recovery reconciles durable sends, receives, mints and melts. `restore`
uses Coco's NUT-13 deterministic seed scan for the configured unit at a known
trusted mint. It depends on mint support, mint availability, known keysets and
Coco's scan/gap behavior. It cannot recreate every history row, incoming foreign
proof, token destination, quote secret, P2PK material or lost pending operation.
It is not a guarantee that a stale backup recovers every coin. Preserve the
complete DB, seed configuration and master key, keep backups current, and test
restoration with no funds before relying on it.

Use `resume --kind mint|receive --id <id>` for persisted incoming operations.
`resume --kind melt --id <id> --max-msats <maximum>` only accepts a prepared
payment; uncertain executing/pending payments require `check`/`recover` first.
`cancel --kind send|receive|melt --id <id>` cancels an unexecuted operation when
Coco permits it. `reclaim --kind send|melt --id <id>` requests a safe reclaim
when supported; it cannot reverse a redeemed token or paid Lightning invoice.
A failed command can leave reserved proofs or an empty token-output file;
inspect operations before taking further action.

After a CLI crash, a lock can remain. `unlock --bot <npub>` removes it only if
the recorded PID no longer exists; it refuses a live process or an invalid lock.
PID reuse or a truncated lock needs operator inspection. Do not remove a lock
while its owner is running. There are no background watchers or automatic
polling workers in this release; schedule explicit operator reconciliation if
needed. Local reads never resume payments as a side effect.

## Validation and activation

```sh
bun run typecheck:wallets
bun test src/wallets src/signing src/agents/session-capability-binding.test.ts
```

Tests use temporary wallets and an in-process mock mint. They cover large
balances, seed/counter/proof persistence, bot isolation, locks, backup restoration,
lost mint/melt responses, token redemption, grant validation and broker budget,
amount mismatch, restart and concurrency cases. They never use real Bitcoin.
The focused typecheck covers the CLI, wallet modules, adapter and wallet policy
helper. Repository-wide typechecking remains a separate project check.

Activation requires installing the pinned dependencies, choosing/persisting the
custody root, operator-created bot wallets and mint trust, tested private backups,
and explicit per-bot grants if agent access is desired. Loading production
broker wiring requires an operator-approved Autopilot restart from outside any
managed session. New/reissued capabilities must adopt the grants. No restart,
funding, live mint selection, wallet grant or real-network payment is performed
by installation alone. A live mint/Lightning smoke remains an operator step.
