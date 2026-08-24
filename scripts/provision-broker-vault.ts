/**
 * Fixed-purpose operator migration for an already-running Autopilot process.
 * Reads normal control-process configuration, rewraps matching legacy agent
 * records into the local broker vault, and never prints private material.
 */
import { BotKeyStore } from "../src/identity/bot-key-store";
import { loadWingmanInstanceIdentity } from "../src/identity/wingman-instance-identity";
import { BrokerKeyVault } from "../src/signing/broker-key-vault";
import { ensureLegacyBrokerRecordProvisioned } from "../src/signing/broker-vault-migration";

const store = new BotKeyStore();
const vault = new BrokerKeyVault();
const instanceIdentity = loadWingmanInstanceIdentity();
let provisioned = 0;
let existing = 0;
let failed = 0;

for (const record of store.listActiveKeys()) {
  if (vault.has(record)) {
    existing += 1;
    continue;
  }
  try {
    ensureLegacyBrokerRecordProvisioned({ vault, record, instanceIdentity });
    provisioned += 1;
    console.log(`[capability-broker] provisioned ${record.botNpub.slice(0, 20)}…`);
  } catch {
    failed += 1;
    console.error(`[capability-broker] could not provision ${record.botNpub.slice(0, 20)}…`);
  }
}

vault.destroy();
console.log(`[capability-broker] migration complete: provisioned=${provisioned} existing=${existing} failed=${failed}`);
if (failed > 0) process.exitCode = 1;
