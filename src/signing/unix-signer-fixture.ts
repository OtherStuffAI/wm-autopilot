/** Disposable cross-language fixture; never opens the host data directory. */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateSecretKey, getPublicKey } from "nostr-tools";
import { ApplicationSigner } from "./application-signer";
import { BrokerKeyVault } from "./broker-key-vault";
import { listenUnixSigner } from "./unix-signer";
import type { BotKeyRecord } from "../identity/bot-key-store";

const [dir, peer, proofBudget] = Bun.argv.slice(2);
const maxProofContentBytes = proofBudget === undefined ? 49 : Number(proofBudget);
if (![47, 49].includes(maxProofContentBytes)) throw new Error("fixture_proof_budget_invalid");
if (!dir || !/^[0-9a-f]{64}$/.test(peer ?? "")) throw new Error("fixture_arguments_required");
const key = generateSecretKey();
const record = { id: "fixture", userNpub: "fixture-owner", botNpub: "fixture-bot", botPubkeyHex: getPublicKey(key) } as BotKeyRecord;
const vault = new BrokerKeyVault({ dataDir: dir });
vault.provision(record, key);
key.fill(0);
const signer = new ApplicationSigner(join(dir, "grants.db"), () => record, vault);
const issued = signer.register(record.userNpub, record.botNpub, record.botPubkeyHex, {
  methods: ["get_public_key", "sign_event", "nip44_encrypt", "nip44_decrypt"],
  peers: [peer!],
  kindRules: [0, 450].map(kind => ({ kind, maxContentBytes: kind === 450 ? maxProofContentBytes : 4096, maxTags: 16, maxTagBytes: 4096,
    allowedTagNames: ["d", "extension", "version", "component", "ciphersuite", "signature_scheme", "mls_signature_key", "x", "p"] })),
});
const credentialFile = join(dir, "application.credential");
writeFileSync(credentialFile, issued.credential, { mode: 0o600, flag: "wx" });
const socket = join(dir, "private", "signer.sock");
let listener = await listenUnixSigner(socket, signer);
process.stdout.write(JSON.stringify({ socket, credential_file: credentialFile, public_key: record.botPubkeyHex }) + "\n");
process.stdin.on("data", async command => {
  if (command.toString().trim() === "restart") {
    await listener.close();
    listener = await listenUnixSigner(socket, signer);
    process.stdout.write("restarted\n");
  } else if (command.toString().trim() === "revoke") {
    signer.revoke(record.userNpub, issued.grant.id);
    process.stdout.write("revoked\n");
  }
});
process.on("SIGTERM", async () => { await listener.close(); signer.close(); vault.destroy(); process.exit(0); });
